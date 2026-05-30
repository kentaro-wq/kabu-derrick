/**
 * 過去判定の自己評価ジョブ
 *
 * 目的: 過去のAI判定が「結果的に正しかったか」を後追いで評価し、
 * 戦略改善・プロンプト改善・閾値調整の根拠データを蓄積する。
 *
 * フロー:
 *  1. 7日以上前の判定で price_7d_after が null のレコードを取得
 *  2. Yahoo bars から判定日 + 7日後の終値を取得して埋める
 *  3. 14日以上前のレコードについても同様に price_14d_after を埋める
 *  4. 14日後データが揃ったら decision_was_right を評価
 *  5. 週次集計を LINE 通知
 *
 * 判定の正解基準・評価ホライズンは src/lib/judgment-eval.ts に一元化
 * (evaluate と reflect が同じ基準を参照し、ドリフトを防ぐ)。
 * ホライズンは戦略別 (固定20日=20営業日, トレーリング/AI=14営業日 等)。
 */
import { NextResponse } from 'next/server'
import { adminSupabase } from '@/lib/supabase'
import { sendLineMessage } from '@/lib/line'
import { fetchYahooBars } from '@/lib/stock-price'
import { evaluateDecision, evalHorizonDays } from '@/lib/judgment-eval'

export const maxDuration = 60

interface ExitJudgmentRow {
  id: string
  ticker: string
  name: string
  judgment_date: string
  current_price: number
  decision: 'hold' | 'take_profit' | 'cut_loss'
  strategy: string | null
  price_7d_after: number | null
  price_14d_after: number | null
  pct_7d_after: number | null
  pct_14d_after: number | null
  price_at_horizon: number | null
  pct_at_horizon: number | null
  eval_horizon_days: number | null
  decision_was_right: boolean | null
}

// 指定日から N営業日後の終値を取得 (Yahoo bars)
function findPriceNDaysAfter(bars: Array<{ date: string; close: number }>, judgmentDate: string, n: number): number | null {
  const jIdx = bars.findIndex(b => b.date >= judgmentDate)
  if (jIdx === -1) return null
  const targetIdx = jIdx + n
  if (targetIdx >= bars.length) return null
  return bars[targetIdx].close
}

export async function POST() {
  const today = new Date()
  const sevenDaysAgo = new Date(today)
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7)
  const fourteenDaysAgo = new Date(today)
  fourteenDaysAgo.setDate(fourteenDaysAgo.getDate() - 14)

  // 評価対象: 7日以上前で 7d/14d チェックポイント or ホライズン評価が未完了のもの
  const { data: rows } = await adminSupabase
    .from('exit_judgments')
    .select('id, ticker, name, judgment_date, current_price, decision, strategy, price_7d_after, price_14d_after, pct_7d_after, pct_14d_after, price_at_horizon, pct_at_horizon, eval_horizon_days, decision_was_right')
    .lte('judgment_date', sevenDaysAgo.toISOString().slice(0, 10))
    .or('price_7d_after.is.null,price_14d_after.is.null,decision_was_right.is.null')

  if (!rows || rows.length === 0) {
    return NextResponse.json({ message: '評価対象なし', count: 0 })
  }

  // ticker ごとに bars をまとめて取得 (API節約)
  const tickerSet = new Set(rows.map(r => r.ticker))
  const barsByTicker = new Map<string, Array<{ date: string; close: number }>>()
  for (const ticker of tickerSet) {
    const bars = await fetchYahooBars(ticker, '3mo')
    barsByTicker.set(ticker, bars.map(b => ({ date: b.date, close: b.close })))
  }

  let updated = 0
  const evaluations: Array<{ ticker: string; name: string; decision: string; pctHorizon: number; horizon: number; correct: boolean }> = []

  for (const r of rows as ExitJudgmentRow[]) {
    const bars = barsByTicker.get(r.ticker) ?? []
    if (bars.length === 0 || r.current_price <= 0) continue

    const updates: Partial<ExitJudgmentRow> = {}

    // 7d / 14d は生データのチェックポイントとして従来どおり記録 (情報用)
    if (r.price_7d_after === null) {
      const p7 = findPriceNDaysAfter(bars, r.judgment_date, 7)
      if (p7 !== null) {
        updates.price_7d_after = p7
        updates.pct_7d_after = ((p7 - r.current_price) / r.current_price) * 100
      }
    }
    if (r.price_14d_after === null) {
      const p14 = findPriceNDaysAfter(bars, r.judgment_date, 14)
      if (p14 !== null) {
        updates.price_14d_after = p14
        updates.pct_14d_after = ((p14 - r.current_price) / r.current_price) * 100
      }
    }

    // 正解判定: 戦略別ホライズン (営業日) の終値で評価。
    // 適格性は「暦日」ではなく「ホライズン営業日 bar の存在」でゲート
    // (暦日と営業日の混在バグを排除し、bar が揃った時点で確実に評価する)。
    if (r.decision_was_right === null) {
      const horizon = evalHorizonDays(r.strategy)
      const ph = findPriceNDaysAfter(bars, r.judgment_date, horizon)
      if (ph !== null) {
        const pctH = ((ph - r.current_price) / r.current_price) * 100
        updates.price_at_horizon = ph
        updates.pct_at_horizon = pctH
        updates.eval_horizon_days = horizon
        updates.decision_was_right = evaluateDecision(r.decision, r.current_price, ph)
        evaluations.push({
          ticker: r.ticker, name: r.name, decision: r.decision,
          pctHorizon: Math.round(pctH * 10) / 10,
          horizon,
          correct: updates.decision_was_right,
        })
      }
    }

    if (Object.keys(updates).length > 0) {
      await adminSupabase.from('exit_judgments').update(updates).eq('id', r.id)
      updated++
    }
  }

  // 週次集計サマリー
  // 過去30日の評価済み判定で正解率を集計
  const thirtyDaysAgo = new Date(today)
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)
  const { data: recentEval } = await adminSupabase
    .from('exit_judgments')
    .select('decision, decision_was_right')
    .gte('judgment_date', thirtyDaysAgo.toISOString().slice(0, 10))
    .not('decision_was_right', 'is', null)

  const stats = {
    total: recentEval?.length ?? 0,
    correct: recentEval?.filter(r => r.decision_was_right).length ?? 0,
    byDecision: {} as Record<string, { total: number; correct: number }>,
  }
  for (const r of recentEval ?? []) {
    const d = r.decision as string
    if (!stats.byDecision[d]) stats.byDecision[d] = { total: 0, correct: 0 }
    stats.byDecision[d].total++
    if (r.decision_was_right) stats.byDecision[d].correct++
  }
  const accuracy = stats.total > 0 ? (stats.correct / stats.total) * 100 : null

  // LINE 通知: 評価が増えた時のみ
  if (evaluations.length > 0 && accuracy !== null) {
    const dateLabel = new Date().toLocaleDateString('ja-JP', { month: 'long', day: 'numeric' })
    let msg = `📊 マイ株デリック AI判定の的中率レポート ${dateLabel}\n\n`
    msg += `【過去30日の評価済み判定】\n`
    msg += `総数: ${stats.total}件 / 正解: ${stats.correct}件 / 正解率: ${accuracy.toFixed(1)}%\n\n`
    msg += `【判定種別ごと】\n`
    for (const [d, s] of Object.entries(stats.byDecision)) {
      const acc = s.total > 0 ? ((s.correct / s.total) * 100).toFixed(0) : '-'
      const label = d === 'hold' ? '継続' : d === 'cut_loss' ? '損切' : d === 'take_profit' ? '利確' : d
      msg += `・${label}: ${s.correct}/${s.total}件 (正解率${acc}%)\n`
    }
    if (evaluations.length > 0) {
      msg += `\n【今回新たに評価された判定】\n`
      for (const e of evaluations.slice(0, 5)) {
        const icon = e.correct ? '✓' : '✗'
        const label = e.decision === 'hold' ? '継続' : e.decision === 'cut_loss' ? '損切' : '利確'
        msg += `${icon} ${e.name}(${e.ticker}) ${label}判定 → ${e.horizon}営業日後 ${e.pctHorizon >= 0 ? '+' : ''}${e.pctHorizon}%\n`
      }
    }
    msg += `\n※的中率は AI 判定の質向上に向けたフィードバック指標です`
    await sendLineMessage(msg).catch(() => {})
  }

  return NextResponse.json({
    ok: true,
    updated,
    evaluations,
    stats: { ...stats, accuracy },
  })
}

export async function GET() {
  return POST()
}
