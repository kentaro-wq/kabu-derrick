import { NextResponse } from 'next/server'
import { adminSupabase } from '@/lib/supabase'
import { recalcNisaUsed } from '@/lib/nisa-sync'

export async function GET() {
  const { data, error } = await adminSupabase
    .from('orders')
    .select('*')
    .order('deadline', { ascending: true })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data)
}

export async function POST(req: Request) {
  const body = await req.json()
  const { data, error } = await adminSupabase.from('orders').insert(body).select().single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  recalcNisaUsed().catch(console.error) // 注文追加 → NISA利用済を再計算
  return NextResponse.json(data)
}

export async function PATCH(req: Request) {
  const body = await req.json()
  const { id, ...updates } = body
  const { data, error } = await adminSupabase
    .from('orders')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  recalcNisaUsed().catch(console.error) // 約定・キャンセル → NISA利用済を再計算
  return NextResponse.json(data)
}

export async function DELETE(req: Request) {
  const { searchParams } = new URL(req.url)
  const id = searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })
  const { error } = await adminSupabase.from('orders').delete().eq('id', id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  recalcNisaUsed().catch(console.error) // 注文削除 → NISA利用済を再計算
  return NextResponse.json({ success: true })
}
