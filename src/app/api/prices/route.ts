import { NextResponse } from 'next/server'
import { adminSupabase } from '@/lib/supabase'

interface YahooChartResult {
  chart: {
    result: Array<{
      meta: {
        regularMarketPrice: number
        previousClose: number
        currency: string
      }
    }> | null
    error: unknown
  }
}

async function fetchPrice(ticker: string): Promise<number | null> {
  // 4桁数字なら東証(.T)、それ以外はそのまま
  const symbol = /^\d{4}$/.test(ticker) ? `${ticker}.T` : ticker
  try {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=1d`,
      { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(8000) }
    )
    if (!res.ok) return null
    const data: YahooChartResult = await res.json()
    return data.chart?.result?.[0]?.meta?.regularMarketPrice ?? null
  } catch {
    return null
  }
}

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

      // 含み損益を再計算
      const qty = h.quantity ?? 0
      const purchasePrice = h.purchase_price ?? 0
      const evaluationAmount = price * qty
      const unrealizedGain = purchasePrice > 0 ? evaluationAmount - purchasePrice * qty : null
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

      return { ticker: h.ticker, name: h.name, price, updated: true }
    })
  )

  const updated = results.filter(r => r.updated).length
  const failed = results.filter(r => !r.updated).map(r => r.ticker)

  // 株価更新後にルールチェックを実行
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://kabu-derrick.vercel.app'
  const checkRes = await fetch(`${baseUrl}/api/holding-rules/check`, { method: 'POST' })
  const checkData = await checkRes.json().catch(() => ({}))

  return NextResponse.json({
    updated,
    failed,
    results: results.map(r => ({ ticker: r.ticker, name: r.name, price: r.price })),
    ruleCheck: checkData,
  })
}
