/**
 * シグナル一覧取得 + 打率サマリー
 */
import { NextResponse } from 'next/server'
import { adminSupabase } from '@/lib/supabase'

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const limit = parseInt(searchParams.get('limit') ?? '30')

  // 最新シグナル一覧
  const { data: signals, error } = await adminSupabase
    .from('prediction_signals')
    .select(`
      id, ticker, name, signal_date, score,
      conditions_met, reasoning, risk_factors,
      price_at_signal, volume_ratio, rsi14, golden_cross,
      above_ma25, above_ma75, per, pbr,
      signal_outcomes (
        pct_5d, hit_5d,
        pct_10d, hit_10d,
        pct_20d, hit_20d
      )
    `)
    .order('signal_date', { ascending: false })
    .order('score', { ascending: false })
    .limit(limit)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // 打率サマリー
  const { data: outcomes } = await adminSupabase
    .from('signal_outcomes')
    .select('hit_5d, hit_10d, hit_20d, pct_10d')

  const oc = outcomes ?? []
  const total = oc.length
  const hit5 = oc.filter(o => o.hit_5d === true).length
  const hit10 = oc.filter(o => o.hit_10d === true).length
  const hit20 = oc.filter(o => o.hit_20d === true).length
  const tracked5 = oc.filter(o => o.hit_5d !== null).length
  const tracked10 = oc.filter(o => o.hit_10d !== null).length
  const tracked20 = oc.filter(o => o.hit_20d !== null).length
  const avgReturn10 = tracked10 > 0
    ? Math.round(oc.filter(o => o.pct_10d !== null).reduce((s, o) => s + (o.pct_10d ?? 0), 0) / tracked10 * 10) / 10
    : null

  const stats = {
    totalSignals: total,
    hitRate5d: tracked5 > 0 ? Math.round(hit5 / tracked5 * 1000) / 10 : null,
    hitRate10d: tracked10 > 0 ? Math.round(hit10 / tracked10 * 1000) / 10 : null,
    hitRate20d: tracked20 > 0 ? Math.round(hit20 / tracked20 * 1000) / 10 : null,
    avgReturn10d: avgReturn10,
    tracked: { d5: tracked5, d10: tracked10, d20: tracked20 },
  }

  return NextResponse.json({ signals: signals ?? [], stats })
}
