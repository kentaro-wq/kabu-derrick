import { NextResponse } from 'next/server'
import { adminSupabase } from '@/lib/supabase'
import { fetchPrice } from '@/lib/stock-price'

// 全保有銘柄の株価を取得してDBを更新し、ルールチェックを実行
export async function POST() {
  const { data: holdings, error } = await adminSupabase
    .from('holdings')
    .select('id, ticker, name, quantity, purchase_price, evaluation_amount, unrealized_gain, unrealized_gain_pct')

  if (error || !holdings || holdings.length === 0) {
    return NextResponse.json({ error: '保有銘柄なし', updated: 0 })
  }

  const results = await Promise.all(
    holdings.map(async h => {
      const price = await fetchPrice(h.ticker)
      if (price == null) return { ticker: h.ticker, name: h.name, price: null, updated: false }

      if (h.quantity == null) {
        await adminSupabase
          .from('holdings')
          .update({ current_price: price, updated_at: new Date().toISOString() })
          .eq('id', h.id)
      } else {
        const purchasePrice = h.purchase_price ?? 0
        const evaluationAmount = price * h.quantity
        const unrealizedGain = purchasePrice > 0 ? evaluationAmount - purchasePrice * h.quantity : null
        const unrealizedGainPct = purchasePrice > 0 ? ((price - purchasePrice) / purchasePrice) * 100 : null
        await adminSupabase
          .from('holdings')
          .update({
            current_price: price,
            evaluation_amount: evaluationAmount,
            unrealized_gain: unrealizedGain,
            unrealized_gain_pct: unrealizedGainPct,
            updated_at: new Date().toISOString(),
          })
          .eq('id', h.id)
      }

      return { ticker: h.ticker, name: h.name, price, updated: true }
    })
  )

  const updated = results.filter(r => r.updated).length
  const failed = results.filter(r => !r.updated).map(r => r.ticker)

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://kabu-derrick.vercel.app'
  const [checkRes, marketRes] = await Promise.all([
    fetch(`${baseUrl}/api/holding-rules/check`, { method: 'POST' }),
    fetch(`${baseUrl}/api/market/check`, { method: 'POST' }),
  ])
  const [checkData, marketData] = await Promise.all([
    checkRes.json().catch(() => ({})),
    marketRes.json().catch(() => ({})),
  ])

  return NextResponse.json({
    updated,
    failed,
    results: results.map(r => ({ ticker: r.ticker, name: r.name, price: r.price })),
    ruleCheck: checkData,
    marketCheck: marketData,
  })
}
