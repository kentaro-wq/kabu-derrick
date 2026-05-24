/**
 * バックテスト実行 API
 *
 * 流れ:
 * 1. ユニバース全銘柄の過去1年OHLCVを並列取得
 * 2. 共通の取引日リストからランダムにsampleSize日サンプリング
 * 3. 各日について候補抽出 → Claude判定 → 結果計算
 * 4. 全部DB保存
 *
 * 設計の鍵: J-Quants APIコールはバックテスト開始時の80回だけ
 * （ユニバース80銘柄 × 1回ずつ）。あとはメモリ内処理。
 */
import { NextResponse } from 'next/server'
import { adminSupabase } from '@/lib/supabase'
import { fetchOHLCVHistory, getIdToken, isJQuantsConfigured } from '@/lib/jquants'
import { BACKTEST_UNIVERSE } from '@/lib/backtest-universe'
import {
  extractCandidatesForDate,
  evaluateCandidate,
  pickRandomTradingDates,
  getCommonTradingDates,
  PROMPT_VERSION,
} from '@/lib/backtest'
import type { OHLCVBar } from '@/lib/technicals'

export const maxDuration = 800

interface BacktestRequest {
  name?: string
  sampleSize?: number   // サンプリング日数（デフォルト10日）
  maxCandidatesPerDay?: number  // 各日の最大候補数（コスト制御）
  ohlcvDays?: number    // 過去何日分のOHLCVを取得するか
  // 時代別バックテスト用
  periodLabel?: string  // 表示用ラベル（例: "直近3ヶ月"）
  dateFrom?: string     // YYYY-MM-DD
  dateTo?: string       // YYYY-MM-DD
  trigger?: 'manual' | 'cron'
}

export async function POST(req: Request) {
  if (!isJQuantsConfigured) {
    return NextResponse.json({ error: 'JQUANTS_REFRESH_TOKEN が未設定' }, { status: 503 })
  }

  let body: BacktestRequest = {}
  try { body = await req.json() } catch { /* empty body OK */ }

  const sampleSize = body.sampleSize ?? 10
  const maxCandidatesPerDay = body.maxCandidatesPerDay ?? 8
  const ohlcvDays = body.ohlcvDays ?? 380  // 約1.5年分を保持して時代別サンプル可能に
  const runName = body.name ?? `Backtest ${new Date().toISOString().slice(0, 16)}`
  const trigger = body.trigger ?? 'manual'
  const periodLabel = body.periodLabel ?? null
  const dateFrom = body.dateFrom ?? null
  const dateTo = body.dateTo ?? null

  // run レコードを先に作成（status: running）
  const { data: runRow, error: runErr } = await adminSupabase
    .from('backtest_runs')
    .insert({
      name: runName,
      status: 'running',
      config: { sampleSize, maxCandidatesPerDay, ohlcvDays, universeSize: BACKTEST_UNIVERSE.length },
      prompt_version: PROMPT_VERSION,
      period_label: periodLabel,
      date_from: dateFrom,
      date_to: dateTo,
      trigger,
    })
    .select()
    .single()

  if (runErr || !runRow) {
    return NextResponse.json({ error: runErr?.message ?? 'run作成失敗' }, { status: 500 })
  }

  const runId = runRow.id

  try {
    // Step 1: J-Quants OHLCV を全ユニバース分まとめて取得
    const idToken = await getIdToken()
    if (!idToken) throw new Error('J-Quants認証失敗')

    const universeWithBars: { ticker: string; name: string; bars: OHLCVBar[] }[] = []
    const BATCH = 5
    for (let i = 0; i < BACKTEST_UNIVERSE.length; i += BATCH) {
      const batch = BACKTEST_UNIVERSE.slice(i, i + BATCH)
      const results = await Promise.all(
        batch.map(async (u) => {
          const bars = await fetchOHLCVHistory(u.ticker, ohlcvDays, idToken)
          return { ...u, bars }
        })
      )
      universeWithBars.push(...results)
    }

    // データが取れた銘柄だけ残す
    const validUniverse = universeWithBars.filter(u => u.bars.length > 30)
    if (validUniverse.length < 10) {
      throw new Error(`ユニバースのデータ取得失敗: ${validUniverse.length}銘柄しかデータなし`)
    }

    // Step 2: 共通取引日からランダムサンプリング
    // 期間指定があれば、その期間内からだけサンプリング（時代別バックテスト）
    const commonDates = getCommonTradingDates(validUniverse)
    const sampleDates = pickRandomTradingDates(
      commonDates,
      sampleSize,
      25, 20,
      (dateFrom || dateTo) ? { from: dateFrom ?? undefined, to: dateTo ?? undefined } : undefined,
    )
    if (sampleDates.length === 0) {
      throw new Error('サンプリング可能な日付が0件')
    }

    // Step 3: 各日について候補抽出 → 判定 → 結果計算
    let totalCandidates = 0
    let totalSignals = 0
    let hit5d = 0, hit10d = 0, hit20d = 0
    let tracked5d = 0, tracked10d = 0, tracked20d = 0
    let sumReturn10d = 0

    for (const date of sampleDates) {
      const candidates = extractCandidatesForDate(validUniverse, date).slice(0, maxCandidatesPerDay)
      totalCandidates += candidates.length

      // 各日の候補を並列5件ずつ判定
      const CONCURRENT = 5
      for (let i = 0; i < candidates.length; i += CONCURRENT) {
        const chunk = candidates.slice(i, i + CONCURRENT)
        const evaluations = await Promise.all(chunk.map(c => evaluateCandidate(c)))

        // DB保存（スコア4以上のみが「発火シグナル」）
        for (let j = 0; j < chunk.length; j++) {
          const c = chunk[j]
          const { judgment, indicators: ind, outcomes } = evaluations[j]

          await adminSupabase.from('backtest_signals').insert({
            run_id: runId,
            ticker: c.ticker,
            name: c.name,
            signal_date: c.date,
            claude_score: judgment.score,
            claude_fire: judgment.fire && judgment.score >= 4,
            conditions_met: judgment.conditions_met,
            reasoning: judgment.reasoning,
            risk_factors: judgment.risk_factors,
            price_at_signal: c.priceAtSignal,
            ma5: ind.ma5, ma25: ind.ma25, ma75: ind.ma75,
            volume_ratio: ind.volumeRatio,
            rsi14: ind.rsi14,
            golden_cross: ind.goldenCross,
            above_ma25: ind.aboveMA25,
            above_ma75: ind.aboveMA75,
            price_5d: outcomes.price5d,   pct_5d: outcomes.pct5d,   hit_5d: outcomes.hit5d,
            price_10d: outcomes.price10d, pct_10d: outcomes.pct10d, hit_10d: outcomes.hit10d,
            price_20d: outcomes.price20d, pct_20d: outcomes.pct20d, hit_20d: outcomes.hit20d,
          })

          // 集計はスコア4以上の「発火シグナル」だけを対象に
          if (judgment.fire && judgment.score >= 4) {
            totalSignals++
            if (outcomes.hit5d != null)  { tracked5d++;  if (outcomes.hit5d) hit5d++ }
            if (outcomes.hit10d != null) { tracked10d++; if (outcomes.hit10d) hit10d++ }
            if (outcomes.hit20d != null) { tracked20d++; if (outcomes.hit20d) hit20d++ }
            if (outcomes.pct10d != null) sumReturn10d += outcomes.pct10d
          }
        }
      }
    }

    // Step 4: run の集計結果を更新
    const hitRate = (h: number, t: number) => t > 0 ? Math.round((h / t) * 1000) / 10 : null
    await adminSupabase
      .from('backtest_runs')
      .update({
        status: 'completed',
        completed_at: new Date().toISOString(),
        total_candidates: totalCandidates,
        total_signals: totalSignals,
        hit_count_5d: hit5d,
        hit_count_10d: hit10d,
        hit_count_20d: hit20d,
        tracked_5d: tracked5d,
        tracked_10d: tracked10d,
        tracked_20d: tracked20d,
        hit_rate_5d: hitRate(hit5d, tracked5d),
        hit_rate_10d: hitRate(hit10d, tracked10d),
        hit_rate_20d: hitRate(hit20d, tracked20d),
        avg_return_10d: totalSignals > 0 ? Math.round((sumReturn10d / totalSignals) * 10) / 10 : null,
      })
      .eq('id', runId)

    return NextResponse.json({
      ok: true,
      runId,
      summary: {
        sampleDates: sampleDates.length,
        totalCandidates,
        totalSignals,
        hitRate10d: hitRate(hit10d, tracked10d),
        tracked10d,
      },
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('[backtest/run] failed:', msg)
    await adminSupabase
      .from('backtest_runs')
      .update({ status: 'failed', notes: msg, completed_at: new Date().toISOString() })
      .eq('id', runId)
    return NextResponse.json({ error: msg, runId }, { status: 500 })
  }
}
