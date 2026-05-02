import { NextResponse } from 'next/server'
import { adminSupabase } from '@/lib/supabase'

export async function GET() {
  const { data } = await adminSupabase.from('investment_policy').select('id, content, updated_at').limit(1).single()
  return NextResponse.json({ policy: data })
}

export async function PUT(req: Request) {
  const { content } = await req.json()
  const { data: existing } = await adminSupabase.from('investment_policy').select('id').limit(1).single()
  if (existing) {
    await adminSupabase.from('investment_policy').update({ content, updated_at: new Date().toISOString() }).eq('id', existing.id)
  } else {
    await adminSupabase.from('investment_policy').insert({ content })
  }
  return NextResponse.json({ ok: true })
}
