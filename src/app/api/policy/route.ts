import { NextResponse } from 'next/server'
import { adminSupabase } from '@/lib/supabase'

export async function GET() {
  const { data } = await adminSupabase
    .from('investment_policy')
    .select('id, content, updated_at')
    .order('updated_at', { ascending: false })
    .limit(10)

  const [current, ...history] = data ?? []
  return NextResponse.json({ current: current ?? null, history })
}

export async function PUT(req: Request) {
  const { content } = await req.json()
  await adminSupabase.from('investment_policy').insert({ content, updated_at: new Date().toISOString() })
  return NextResponse.json({ ok: true })
}
