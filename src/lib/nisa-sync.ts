import { adminSupabase } from '@/lib/supabase'

/**
 * holdings + 注文中(active buy orders) から NISA利用済額を再計算して profile を更新。
 * 楽天証券の表示ルールに合わせ:
 *   成長枠利用済 = 保有の取得コスト + 注文中の買い注文コスト（両方nisa_growth）
 *   つみたて枠利用済 = 保有の取得コスト（nisa_tsumitate + old_tsumitate）
 */
export async function recalcNisaUsed(): Promise<void> {
  const [holdingsRes, ordersRes] = await Promise.all([
    adminSupabase.from('holdings').select('account_type, quantity, purchase_price'),
    adminSupabase.from('orders').select('account_type, order_type, status, price, quantity'),
  ])

  const holdings = holdingsRes.data ?? []
  const orders = ordersRes.data ?? []

  // 成長枠: 保有コスト
  const growthHoldingCost = holdings
    .filter(h => h.account_type === 'nisa_growth' && h.quantity != null && h.purchase_price != null)
    .reduce((sum, h) => sum + Number(h.purchase_price) * Number(h.quantity), 0)

  // 成長枠: 注文中の買い注文コスト（楽天は注文中も利用済に含む）
  const growthOrderCost = orders
    .filter(o => o.account_type === 'nisa_growth' && o.order_type === 'buy' && o.status === 'active' && o.price != null && o.quantity != null)
    .reduce((sum, o) => sum + Number(o.price) * Number(o.quantity), 0)

  const growthUsed = Math.round(growthHoldingCost + growthOrderCost)

  // つみたて枠: 保有コストのみ
  const tsumitateUsed = Math.round(
    holdings
      .filter(h => (h.account_type === 'nisa_tsumitate' || h.account_type === 'old_tsumitate') && h.quantity != null && h.purchase_price != null)
      .reduce((sum, h) => sum + Number(h.purchase_price) * Number(h.quantity), 0)
  )

  await adminSupabase.from('profile').update({
    nisa_growth_used: growthUsed,
    nisa_tsumitate_used: tsumitateUsed,
    updated_at: new Date().toISOString(),
  }).neq('id', '00000000-0000-0000-0000-000000000000')
}
