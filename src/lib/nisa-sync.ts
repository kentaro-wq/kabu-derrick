import { adminSupabase } from '@/lib/supabase'

/**
 * holdings + 注文中(active buy orders) から NISA成長枠の利用済額を再計算して profile を更新。
 *
 * 【つみたて枠は自動計算しない理由】
 * - nisa_tsumitate / old_tsumitate の保有は複数年にまたがる積立総額
 * - old_tsumitate（旧NISA）は当年の利用枠に無関係
 * - 保有残高から「今年分だけ」を算出する手段がない
 * → つみたて利用済は楽天証券の画面を見て設定画面から手動入力する運用とする
 */
export async function recalcNisaUsed(): Promise<void> {
  const [holdingsRes, ordersRes] = await Promise.all([
    adminSupabase.from('holdings').select('account_type, quantity, purchase_price'),
    adminSupabase.from('orders').select('account_type, order_type, status, price, quantity'),
  ])

  const holdings = holdingsRes.data ?? []
  const orders = ordersRes.data ?? []

  // 成長枠: 保有コスト（個別株は取得単価×株数がそのままコスト）
  const growthHoldingCost = holdings
    .filter(h => h.account_type === 'nisa_growth' && h.quantity != null && h.purchase_price != null)
    .reduce((sum, h) => sum + Number(h.purchase_price) * Number(h.quantity), 0)

  // 成長枠: 注文中の買い注文コスト（楽天は注文中も利用済に含む）
  const growthOrderCost = orders
    .filter(o => o.account_type === 'nisa_growth' && o.order_type === 'buy' && o.status === 'active' && o.price != null && o.quantity != null)
    .reduce((sum, o) => sum + Number(o.price) * Number(o.quantity), 0)

  const growthUsed = Math.round(growthHoldingCost + growthOrderCost)

  // 計算結果が0の場合はデータ欠損の可能性があるため更新しない
  // （holdings の quantity/purchase_price が全て null だと誤って 0 になる）
  if (growthUsed === 0) return

  // 成長枠のみ更新。つみたて枠は手動入力値を保持（上書きしない）
  await adminSupabase.from('profile').update({
    nisa_growth_used: growthUsed,
    updated_at: new Date().toISOString(),
  }).neq('id', '00000000-0000-0000-0000-000000000000')
}
