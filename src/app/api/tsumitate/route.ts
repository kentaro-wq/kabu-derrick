import { NextResponse } from 'next/server'
import { adminSupabase } from '@/lib/supabase'

export async function GET() {
  const { data, error } = await adminSupabase
    .from('tsumitate_settings')
    .select('id, name, monthly_amount, account_type')
    .order('monthly_amount', { ascending: false })
  if (error) return NextResponse.json({ settings: [] })
  return NextResponse.json({ settings: data ?? [] })
}

export async function POST(req: Request) {
  const body = await req.json()
  const { data, error } = await adminSupabase
    .from('tsumitate_settings')
    .insert(body)
    .select()
    .single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data)
}

export async function DELETE(req: Request) {
  const { searchParams } = new URL(req.url)
  const id = searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })
  const { error } = await adminSupabase.from('tsumitate_settings').delete().eq('id', id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ success: true })
}
