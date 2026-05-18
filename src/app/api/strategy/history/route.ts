import { NextResponse } from 'next/server'
import { adminSupabase } from '@/lib/supabase'

export async function GET() {
  try {
    const { data, error } = await adminSupabase
      .from('strategy_proposals')
      .select('id, headline, nisa_strategy, tokutei_strategy, next_actions, risk_notes, raw_response, created_at')
      .order('created_at', { ascending: false })
      .limit(10)

    if (error) {
      console.error('[strategy/history] supabase error', error)
      return NextResponse.json({ history: [] })
    }

    return NextResponse.json({ history: data ?? [] })
  } catch (err) {
    console.error('[strategy/history] unexpected error', err)
    return NextResponse.json({ history: [] })
  }
}
