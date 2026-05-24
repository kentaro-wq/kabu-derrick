/**
 * バックテストの多角的評価指標 API
 *
 * 混同行列 (Confusion Matrix) に基づく分析:
 *
 *                       実際に上昇 (+5%以上)   上昇せず
 *   Claude発火 (fire)     TP (当てた)        FP (誤判断)
 *   Claude見送り (skip)   FN (見逃した)       TN (正しく見送り)
 *
 * 計算する指標:
 *  - 適合率 Precision  = TP / (TP+FP) = 発火した時に的中する確率
 *  - 再現率 Recall     = TP / (TP+FN) = 上昇銘柄を拾えた率
 *  - 特異度 Specificity= TN / (TN+FP) = 上昇しない銘柄を正しく避けた率
 *  - 見逃し率          = 1 - Recall = 上がったのに発火しなかった率
 *  - 全体精度 Accuracy = (TP+TN) / 全体
 *  - F1 Score          = 2*P*R / (P+R)
 *  - ベースレート      = 全候補のうち実際に上昇した率（ランダム発火の基準）
 */
import { NextResponse } from 'next/server'
import { adminSupabase } from '@/lib/supabase'

interface Signal {
  claude_fire: boolean | null
  claude_score: number | null
  hit_5d: boolean | null
  hit_10d: boolean | null
  hit_20d: boolean | null
}

interface Matrix {
  tp: number    // 発火 + 上昇 = 当てた
  fp: number    // 発火 + 上昇せず = 誤判断
  fn: number    // 見送り + 上昇 = 見逃した
  tn: number    // 見送り + 上昇せず = 正しく見送り
  total: number
}

function buildMatrix(signals: Signal[], horizon: '5d' | '10d' | '20d'): Matrix {
  const key = `hit_${horizon}` as 'hit_5d' | 'hit_10d' | 'hit_20d'
  let tp = 0, fp = 0, fn = 0, tn = 0
  for (const s of signals) {
    const hit = s[key]
    if (hit == null) continue  // 追跡データなし → 除外
    const fired = s.claude_fire === true
    if (fired && hit) tp++
    else if (fired && !hit) fp++
    else if (!fired && hit) fn++
    else tn++
  }
  return { tp, fp, fn, tn, total: tp + fp + fn + tn }
}

function calcMetrics(m: Matrix) {
  const safe = (num: number, den: number) => den > 0 ? Math.round((num / den) * 1000) / 10 : null
  return {
    precision: safe(m.tp, m.tp + m.fp),       // 発火時の的中率
    recall: safe(m.tp, m.tp + m.fn),          // 上昇銘柄の捕捉率
    specificity: safe(m.tn, m.tn + m.fp),     // 非上昇銘柄の正しい見送り率
    missRate: safe(m.fn, m.tp + m.fn),        // 見逃し率
    accuracy: safe(m.tp + m.tn, m.total),     // 全体精度
    baseRate: safe(m.tp + m.fn, m.total),     // 候補のうち実際に上昇した率
    f1: (() => {
      const p = m.tp + m.fp > 0 ? m.tp / (m.tp + m.fp) : 0
      const r = m.tp + m.fn > 0 ? m.tp / (m.tp + m.fn) : 0
      if (p + r === 0) return null
      return Math.round((2 * p * r) / (p + r) * 1000) / 10
    })(),
    fireRate: safe(m.tp + m.fp, m.total),     // 発火率（全体に対する）
  }
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const sprintId = searchParams.get('sprint_id')

  let query = adminSupabase
    .from('backtest_signals')
    .select('claude_fire, claude_score, hit_5d, hit_10d, hit_20d, run_id')
    .not('hit_10d', 'is', null)

  // 特定スプリント指定があれば絞る
  if (sprintId) {
    const { data: runs } = await adminSupabase
      .from('backtest_runs')
      .select('id')
      .eq('sprint_id', sprintId)
    const runIds = (runs ?? []).map(r => r.id)
    if (runIds.length === 0) return NextResponse.json({ matrix: null, metrics: null })
    query = query.in('run_id', runIds)
  }

  const { data } = await query.limit(10000)
  const signals = (data ?? []) as Signal[]

  if (signals.length === 0) {
    return NextResponse.json({
      message: '追跡済みのシグナルがまだありません',
      total: 0,
    })
  }

  // 3つの時間軸で計算
  const m5 = buildMatrix(signals, '5d')
  const m10 = buildMatrix(signals, '10d')
  const m20 = buildMatrix(signals, '20d')

  return NextResponse.json({
    total: signals.length,
    horizons: {
      '5d':  { matrix: m5,  metrics: calcMetrics(m5) },
      '10d': { matrix: m10, metrics: calcMetrics(m10) },
      '20d': { matrix: m20, metrics: calcMetrics(m20) },
    },
  })
}
