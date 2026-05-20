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

  // 注文画面の「約定済み」ボタン → 保有銘柄を自動更新
  if (updates.status === 'executed') {
    const { data: order } = await adminSupabase.from('orders').select('*').eq('id', id).single()
    if (order) {
      if (order.order_type === 'buy' && order.price != null && order.quantity != null) {
        const qty = Number(order.quantity)
        const price = Number(order.price)
        const acct = order.account_type ?? 'nisa_growth'

        // 同一銘柄・同一口座の既存保有を検索
        const { data: existing } = await (order.ticker
          ? adminSupabase.from('holdings').select('*').eq('ticker', order.ticker).eq('account_type', acct).maybeSingle()
          : adminSupabase.from('holdings').select('*').ilike('name', `%${order.name}%`).eq('account_type', acct).maybeSingle()
        )

        if (existing) {
          const prevQty = Number(existing.quantity ?? 0)
          const prevPurchase = Number(existing.purchase_price ?? price)
          const newQty = prevQty + qty
          const newAvg = newQty > 0 ? (prevQty * prevPurchase + qty * price) / newQty : price
          const newEval = newQty * price
          await adminSupabase.from('holdings').update({
            quantity: newQty,
            purchase_price: Math.round(newAvg * 100) / 100,
            current_price: price,
            evaluation_amount: newEval,
            unrealized_gain: Math.round(newEval - newQty * newAvg),
            unrealized_gain_pct: Math.round(((price - newAvg) / newAvg) * 10000) / 100,
            updated_at: new Date().toISOString(),
          }).eq('id', existing.id)
        } else {
          await adminSupabase.from('holdings').insert({
            name: order.name,
            ticker: order.ticker ?? '',
            account_type: acct,
            asset_type: 'stock',
            quantity: qty,
            purchase_price: price,
            current_price: price,
            evaluation_amount: qty * price,
            unrealized_gain: 0,
            unrealized_gain_pct: 0,
          })
        }
      } else if (order.order_type === 'sell') {
        // 保有を取得してから削除
        const { data: holding } = await (order.ticker
          ? adminSupabase.from('holdings').select('*').eq('ticker', order.ticker).maybeSingle()
          : adminSupabase.from('holdings').select('*').ilike('name', `%${order.name}%`).maybeSingle()
        )
        if (order.ticker) {
          await adminSupabase.from('holdings').delete().eq('ticker', order.ticker)
        } else {
          await adminSupabase.from('holdings').delete().ilike('name', `%${order.name}%`)
        }
        // 実現損益を記録
        const sellPrice = order.price ?? holding?.current_price ?? null
        const buyPrice = holding?.purchase_price ?? null
        const quantity = order.quantity ?? holding?.quantity ?? null
        if (sellPrice && quantity) {
          await adminSupabase.from('realized_trades').insert({
            ticker: order.ticker ?? holding?.ticker ?? '',
            name: order.name,
            sell_date: new Date().toISOString().slice(0, 10),
            sell_price: sellPrice,
            buy_price: buyPrice,
            quantity,
            account_type: holding?.account_type ?? order.account_type ?? null,
          })
        }
      }
    }
  }

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
