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
    .select('id, name, started_at, completed_at, status, total_candidates, total_signals, hit_rate_5d, hit_rate_10d, hit_rate_20d, avg_return_10d, tracked_10d, prompt_version, notes')
    .order('started_at', { ascending: false })
    .limit(30)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ runs: data ?? [] })
}
