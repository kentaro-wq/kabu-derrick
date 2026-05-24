/**
 * スプリント実行ユーティリティ
 *
 * 予算ベースの連続実行: ¥600分回す → 自動停止
 * 1ティックで最大限のミニ・バックテストを実行（Vercel timeout 内で）
 */
import { adminSupabase } from '@/lib/supabase'
import { fetchOHLCVHistoryCached, getIdToken } from '@/lib/jquants'
import { BACKTEST_UNIVERSE } from '@/lib/backtest-universe'
import {
  extractCandidatesForDate,
  evaluateCandidate,
  pickRandomTradingDates,
  getCommonTradingDates,
  PERIOD_PRESETS,
  periodToDateRange,
  PROMPT_VERSION,
  fetchFewShotExamples,
} from '@/lib/backtest'
import type { OHLCVBar } from '@/lib/technicals'

// 1評価あたりの想定コスト（円）— Claude Haiku 4.5 で約 ¥0.4
export const COST_PER_EVAL_YEN = 0.4

/** メモリ内OHLCVキャッシュ（1tick内で銘柄ごとの再取得を回避） */
type MemCache = Map<string, OHLCVBar[]>

/** スプリント1tick = 「予算が許す限り backtest を回す」 */
export async function runSprintTick(
  sprintId: string,
  maxRunsPerTick = 3,
  perRunSampleSize = 5,
  perRunMaxCandidates = 5,
): Promise<{ runsCompleted: number; done: boolean; reason?: string }> {
  // sprint 状態取得
  const { data: sprint } = await adminSupabase
    .from('sprint_sessions')
    .select('*')
    .eq('id', sprintId)
    .single()

  if (!sprint) return { runsCompleted: 0, done: true, reason: 'sprint not found' }
  if (sprint.status !== 'active') return { runsCompleted: 0, done: true, reason: `status: ${sprint.status}` }

  // 予算チェック
  if (sprint.total_cost_yen >= sprint.budget_yen) {
    await markCompleted(sprintId)
    return { runsCompleted: 0, done: true, reason: 'budget exhausted' }
  }

  const idToken = await getIdToken()
  if (!idToken) return { runsCompleted: 0, done: false, reason: 'jquants auth failed' }

  // メモリキャッシュ（このtick内で銘柄データ共有）
  const memCache: MemCache = new Map()

  // OHLCV をユニバース分まとめて取得（キャッシュ活用）
  // Vercel Hobby plan の 60秒上限を考慮して 30銘柄に絞る（キャッシュ蓄積で2回目以降は高速化）
  const SUB_UNIVERSE = BACKTEST_UNIVERSE.slice(0, 30)
  const universeWithBars: { ticker: string; name: string; bars: OHLCVBar[] }[] = []
  const FETCH_PARALLEL = 5
  for (let i = 0; i < SUB_UNIVERSE.length; i += FETCH_PARALLEL) {
    const batch = SUB_UNIVERSE.slice(i, i + FETCH_PARALLEL)
    const results = await Promise.all(
      batch.map(async (u) => {
        const bars = await fetchOHLCVHistoryCached(u.ticker, 380, idToken, { memoryCache: memCache })
        return { ...u, bars }
      })
    )
    universeWithBars.push(...results)
  }

  const validUniverse = universeWithBars.filter(u => u.bars.length > 30)
  if (validUniverse.length < 10) {
    // 診断情報を含める
    const sample = universeWithBars.slice(0, 5).map(u => ({ ticker: u.ticker, bars: u.bars.length }))
    return {
      runsCompleted: 0,
      done: false,
      reason: `insufficient universe data: ${validUniverse.length}/${universeWithBars.length} valid. samples=${JSON.stringify(sample)}`,
    }
  }

  const commonDates = getCommonTradingDates(validUniverse)

  // Few-shot 学習モードなら過去事例を取得（1tickで1回だけ）
  const fewShot = sprint.use_few_shot ? await fetchFewShotExamples(4) : undefined
  if (sprint.use_few_shot && fewShot) {
    console.log(`[sprint] few-shot: ${fewShot.hits.length} hits, ${fewShot.misses.length} misses`)
  }

  // 予算に達するか maxRunsPerTick に達するまでミニ・バックテストを繰り返す
  let runsCompleted = 0
  let costAccumulated = sprint.total_cost_yen

  for (let runIdx = 0; runIdx < maxRunsPerTick; runIdx++) {
    if (costAccumulated >= sprint.budget_yen) break

    // 時代をローテーション（runごとに変える）
    const preset = PERIOD_PRESETS[(sprint.total_runs + runIdx) % PERIOD_PRESETS.length]
    const range = periodToDateRange(preset)

    const sampleDates = pickRandomTradingDates(
      commonDates,
      perRunSampleSize,
      25, 20,
      { from: range.from, to: range.to },
    )
    if (sampleDates.length === 0) continue

    // backtest_runs レコード作成
    const { data: runRow } = await adminSupabase
      .from('backtest_runs')
      .insert({
        name: `[Sprint] ${range.label}`,
        status: 'running',
        config: { sampleSize: perRunSampleSize, maxCandidatesPerDay: perRunMaxCandidates },
        prompt_version: PROMPT_VERSION,
        period_label: range.label,
        date_from: range.from,
        date_to: range.to,
        trigger: 'cron',
        sprint_id: sprintId,
      })
      .select()
      .single()

    if (!runRow) continue
    const runId = runRow.id

    let runCandidates = 0
    let runFires = 0
    let hit5 = 0, hit10 = 0, hit20 = 0
    let trk5 = 0, trk10 = 0, trk20 = 0
    let sumReturn10d = 0

    for (const date of sampleDates) {
      const candidates = extractCandidatesForDate(validUniverse, date).slice(0, perRunMaxCandidates)
      runCandidates += candidates.length

      // 5並列でClaude判定
      const CONCURRENT = 5
      for (let i = 0; i < candidates.length; i += CONCURRENT) {
        const chunk = candidates.slice(i, i + CONCURRENT)
        const evaluations = await Promise.all(chunk.map(c => evaluateCandidate(c, fewShot)))

        for (let j = 0; j < chunk.length; j++) {
          const c = chunk[j]
          const { judgment, indicators: ind, outcomes } = evaluations[j]
          costAccumulated += COST_PER_EVAL_YEN

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

          if (judgment.fire && judgment.score >= 4) {
            runFires++
            if (outcomes.hit5d  != null) { trk5++;  if (outcomes.hit5d)  hit5++ }
            if (outcomes.hit10d != null) { trk10++; if (outcomes.hit10d) hit10++ }
            if (outcomes.hit20d != null) { trk20++; if (outcomes.hit20d) hit20++ }
            if (outcomes.pct10d != null) sumReturn10d += outcomes.pct10d
          }
        }
      }
    }

    // backtest_runs を完了マーク
    const rate = (h: number, t: number) => t > 0 ? Math.round((h / t) * 1000) / 10 : null
    await adminSupabase
      .from('backtest_runs')
      .update({
        status: 'completed',
        completed_at: new Date().toISOString(),
        total_candidates: runCandidates,
        total_signals: runFires,
        hit_count_5d: hit5, hit_count_10d: hit10, hit_count_20d: hit20,
        tracked_5d: trk5, tracked_10d: trk10, tracked_20d: trk20,
        hit_rate_5d: rate(hit5, trk5),
        hit_rate_10d: rate(hit10, trk10),
        hit_rate_20d: rate(hit20, trk20),
        avg_return_10d: runFires > 0 ? Math.round((sumReturn10d / runFires) * 10) / 10 : null,
      })
      .eq('id', runId)

    // sprint 集計を更新
    const updated = await adminSupabase
      .from('sprint_sessions')
      .update({
        total_runs: sprint.total_runs + runsCompleted + 1,
        total_candidates: sprint.total_candidates + runCandidates,
        total_fires: sprint.total_fires + runFires,
        total_cost_yen: costAccumulated,
        hit_5d: sprint.hit_5d + hit5,   tracked_5d: sprint.tracked_5d + trk5,
        hit_10d: sprint.hit_10d + hit10, tracked_10d: sprint.tracked_10d + trk10,
        hit_20d: sprint.hit_20d + hit20, tracked_20d: sprint.tracked_20d + trk20,
      })
      .eq('id', sprintId)
      .select()
      .single()

    // 次の time-period 判定用にローカルも更新
    if (updated.data) {
      Object.assign(sprint, updated.data)
    }

    runsCompleted++
  }

  // 完了判定
  if (costAccumulated >= sprint.budget_yen) {
    await markCompleted(sprintId)
    return { runsCompleted, done: true, reason: 'budget reached' }
  }

  return { runsCompleted, done: false }
}

async function markCompleted(sprintId: string) {
  const { data: sprint } = await adminSupabase
    .from('sprint_sessions')
    .select('hit_10d, tracked_10d')
    .eq('id', sprintId)
    .single()

  const hitRate10d = sprint && sprint.tracked_10d > 0
    ? Math.round((sprint.hit_10d / sprint.tracked_10d) * 1000) / 10
    : null

  await adminSupabase
    .from('sprint_sessions')
    .update({
      status: 'completed',
      completed_at: new Date().toISOString(),
      hit_rate_10d: hitRate10d,
    })
    .eq('id', sprintId)
}
