import { NextResponse } from 'next/server'
import { adminSupabase } from '@/lib/supabase'

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const year = searchParams.get('year') ?? new Date().getFullYear().toString()

  const { data, error } = await adminSupabase
    .from('realized_trades')
    .select('*')
    .gte('sell_date', `${year}-01-01`)
    .lte('sell_date', `${year}-12-31`)
    .order('sell_date', { ascending: false })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data ?? [])
}

export async function POST(req: Request) {
  const body = await req.json()
  const { ticker, name, sell_date, sell_price, buy_price, quantity, account_type, notes } = body

  if (!ticker || !name || !sell_date || sell_price == null || quantity == null) {
    return NextResponse.json({ error: 'ticker, name, sell_date, sell_price, quantity は必須です' }, { status: 400 })
  }

  const { data, error } = await adminSupabase
    .from('realized_trades')
    .insert({ ticker, name, sell_date, sell_price, buy_price: buy_price ?? null, quantity, account_type: account_type ?? null, notes: notes ?? null })
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data)
}

export async function DELETE(req: Request) {
  const { searchParams } = new URL(req.url)
  const id = searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })

  const { error } = await adminSupabase.from('realized_trades').delete().eq('id', id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ success: true })
}
