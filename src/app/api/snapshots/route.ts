import { NextResponse } from 'next/server'
import { adminSupabase } from '@/lib/supabase'

// 過去90日のスナップショット一覧
export async function GET() {
  const since = new Date()
  since.setDate(since.getDate() - 90)
  const { data, error } = await adminSupabase
    .from('portfolio_snapshots')
    .select('snapshot_date, total_assets, total_evaluation, total_unrealized_gain')
    .gte('snapshot_date', since.toISOString().slice(0, 10))
    .order('snapshot_date', { ascending: true })
  if (error) return NextResponse.json({ snapshots: [] })
  return NextResponse.json({ snapshots: data ?? [] })
}

// 今日のスナップショットを保存（既存があれば上書き）
export async function POST(req: Request) {
  const body = await req.json()
  const today = new Date().toISOString().slice(0, 10)
  const { data, error } = await adminSupabase
    .from('portfolio_snapshots')
    .upsert({ ...body, snapshot_date: today }, { onConflict: 'snapshot_date' })
    .select()
    .single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data)
}
