import { NextResponse } from 'next/server'
import { adminSupabase } from '@/lib/supabase'

export async function GET() {
  const { data, error } = await adminSupabase
    .from('chat_sessions')
    .select('id, title, created_at, updated_at, messages')
    .order('updated_at', { ascending: false })
    .limit(30)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ sessions: data })
}

export async function POST(req: Request) {
  const { id, title, messages } = await req.json()

  if (id) {
    // 既存セッション更新
    const { data, error } = await adminSupabase
      .from('chat_sessions')
      .update({ messages, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select('id')
      .single()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ id: data.id })
  } else {
    // 新規セッション作成
    const { data, error } = await adminSupabase
      .from('chat_sessions')
      .insert({ title: title ?? '相談', messages })
      .select('id')
      .single()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ id: data.id })
  }
}

export async function DELETE(req: Request) {
  const { id } = await req.json()
  const { error } = await adminSupabase.from('chat_sessions').delete().eq('id', id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
