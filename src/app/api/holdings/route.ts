import { NextResponse } from 'next/server'
import { adminSupabase } from '@/lib/supabase'

export async function GET() {
  const { data, error } = await adminSupabase
    .from('holdings')
    .select('*')
    .order('evaluation_amount', { ascending: false })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data)
}

export async function POST(req: Request) {
  const body = await req.json()
  const { data, error } = await adminSupabase.from('holdings').insert(body).select().single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data)
}

// スクショ解析結果で全件置き換え
export async function PUT(req: Request) {
  const { holdings } = await req.json()
  await adminSupabase.from('holdings').delete().neq('id', '00000000-0000-0000-0000-000000000000')
  const rows = holdings.map((h: Record<string, unknown>) => ({ ...h, updated_at: new Date().toISOString() }))
  const { data, error } = await adminSupabase.from('holdings').insert(rows).select()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data)
}

export async function PATCH(req: Request) {
  const body = await req.json()
  const { id, ...updates } = body
  const { data, error } = await adminSupabase
    .from('holdings')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data)
}
