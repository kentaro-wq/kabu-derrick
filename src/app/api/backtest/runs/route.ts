/**
 * バックテスト実行履歴の一覧 + 個別run詳細
 */
import { NextResponse } from 'next/server'
import { adminSupabase } from '@/lib/supabase'

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const runId = searchParams.get('id')

  // 個別run詳細
  if (runId) {
    const [runRes, signalsRes] = await Promise.all([
      adminSupabase.from('backtest_runs').select('*').eq('id', runId).single(),
      adminSupabase
        .from('backtest_signals')
        .select('*')
        .eq('run_id', runId)
        .order('signal_date', { ascending: false })
        .order('claude_score', { ascending: false }),
    ])

    if (runRes.error) return NextResponse.json({ error: runRes.error.message }, { status: 404 })
    return NextResponse.json({ run: runRes.data, signals: signalsRes.data ?? [] })
  }

  // 一覧
  const { data, error } = await adminSupabase
    .from('backtest_runs')
    .select('id, name, started_at, completed_at, status, total_candidates, total_signals, hit_rate_5d, hit_rate_10d, hit_rate_20d, avg_return_10d, tracked_10d, prompt_version, notes, period_label, date_from, date_to, trigger')
    .order('started_at', { ascending: false })
    .limit(50)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // 時代別の集計（completed のみ対象）
  const completed = (data ?? []).filter(r => r.status === 'completed' && r.period_label)
  const byPeriod = new Map<string, {
    label: string
    runCount: number
    totalSignals: number
    tracked10d: number
    hit10d: number
    avgReturn10d: number
  }>()

  for (const r of completed) {
    const key = r.period_label!
    const cur = byPeriod.get(key) ?? { label: key, runCount: 0, totalSignals: 0, tracked10d: 0, hit10d: 0, avgReturn10d: 0 }
    cur.runCount++
    cur.totalSignals += r.total_signals ?? 0
    cur.tracked10d += r.tracked_10d ?? 0
    if (r.hit_rate_10d != null && r.tracked_10d) {
      cur.hit10d += Math.round((r.hit_rate_10d / 100) * r.tracked_10d)
    }
    if (r.avg_return_10d != null) cur.avgReturn10d += r.avg_return_10d
    byPeriod.set(key, cur)
  }

  const periodStats = [...byPeriod.values()].map(p => ({
    label: p.label,
    runCount: p.runCount,
    totalSignals: p.totalSignals,
    tracked10d: p.tracked10d,
    hitRate10d: p.tracked10d > 0 ? Math.round((p.hit10d / p.tracked10d) * 1000) / 10 : null,
    avgReturn10d: p.runCount > 0 ? Math.round((p.avgReturn10d / p.runCount) * 10) / 10 : null,
  }))

  return NextResponse.json({ runs: data ?? [], periodStats })
}
