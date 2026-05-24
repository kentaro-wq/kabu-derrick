/**
 * スプリントステータス取得 + 試算レポート
 *
 * GET /api/backtest/sprint/status              → 最新のactive sprint（なければ最新完了）
 * GET /api/backtest/sprint/status?id=...       → 指定sprint詳細
 * GET /api/backtest/sprint/status?list=true    → 全sprint一覧
 *
 * 完了スプリントには「あと¥X追加すると信頼区間が±Y%に縮まる」試算を含める
 */
import { NextResponse } from 'next/server'
import { adminSupabase } from '@/lib/supabase'
import { COST_PER_EVAL_YEN } from '@/lib/sprint'

interface SprintRow {
  id: string
  name: string
  budget_yen: number
  status: string
  total_runs: number
  total_candidates: number
  total_fires: number
  total_cost_yen: number
  hit_5d: number; tracked_5d: number
  hit_10d: number; tracked_10d: number
  hit_20d: number; tracked_20d: number
  hit_rate_10d: number | null
  avg_return_10d: number | null
  started_at: string
  completed_at: string | null
  use_few_shot: boolean
}

/** 統計的信頼区間（Wilson法の近似版）で打率の±幅を返す */
function confidenceMargin(p: number, n: number): number {
  if (n <= 0) return 0
  // 95% 信頼区間の半幅 ≒ 1.96 * sqrt(p(1-p)/n)
  return Math.round(1.96 * Math.sqrt(p * (1 - p) / n) * 1000) / 10
}

function buildProjection(s: SprintRow) {
  const hitRate10d = s.tracked_10d > 0 ? s.hit_10d / s.tracked_10d : 0
  const currentMargin = confidenceMargin(hitRate10d, s.tracked_10d)
  // 同じ予算追加で何件 tracked が増えるか
  const additionalEvals = Math.floor(s.budget_yen / COST_PER_EVAL_YEN)
  const fireRate = s.total_candidates > 0 ? s.total_fires / s.total_candidates : 0.2
  const trackRate = s.tracked_10d > 0 && s.total_fires > 0 ? s.tracked_10d / s.total_fires : 0.8
  const projectedTracked = s.tracked_10d + Math.floor(additionalEvals * fireRate * trackRate)
  const projectedMargin = confidenceMargin(hitRate10d, projectedTracked)

  return {
    currentHitRate10d: Math.round(hitRate10d * 1000) / 10,
    currentMargin,           // ±X%
    currentTracked: s.tracked_10d,
    additionalBudgetYen: s.budget_yen, // 同額追加した場合
    projectedTracked,
    projectedMargin,         // ±Y%
    marginImprovement: Math.round((currentMargin - projectedMargin) * 10) / 10,
    fireRate: Math.round(fireRate * 1000) / 10,
    note: currentMargin <= 5
      ? '十分な精度。次は改善施策（few-shot等）を試すフェーズ'
      : currentMargin <= 10
      ? 'まずまずの精度。あと同額で更に絞り込める'
      : 'まだサンプル不足。同額追加で大きく精度向上が期待できる',
  }
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const id = searchParams.get('id')
  const list = searchParams.get('list')

  if (list === 'true') {
    const { data, error } = await adminSupabase
      .from('sprint_sessions')
      .select('id, name, status, budget_yen, total_cost_yen, total_fires, hit_rate_10d, tracked_10d, started_at, completed_at')
      .order('started_at', { ascending: false })
      .limit(20)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ sprints: data ?? [] })
  }

  // 単一スプリント取得
  let query = adminSupabase.from('sprint_sessions').select('*')
  if (id) query = query.eq('id', id)
  else query = query.order('started_at', { ascending: false }).limit(1)

  const { data, error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const sprint = Array.isArray(data) ? data[0] : data
  if (!sprint) return NextResponse.json({ sprint: null, projection: null })

  const projection = sprint.tracked_10d > 0 ? buildProjection(sprint as SprintRow) : null

  return NextResponse.json({ sprint, projection })
}

// スプリント停止
export async function POST(req: Request) {
  const { id } = await req.json()
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })

  const { error } = await adminSupabase
    .from('sprint_sessions')
    .update({ status: 'cancelled', completed_at: new Date().toISOString() })
    .eq('id', id)
    .eq('status', 'active')

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
