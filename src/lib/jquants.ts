/**
 * J-Quants API（日本取引所グループ公式・無料）
 * 登録: https://jpx-jquants.com/
 * 環境変数: JQUANTS_REFRESH_TOKEN
 */
import { adminSupabase } from '@/lib/supabase'
import { recalcNisaUsed } from '@/lib/nisa-sync'

const REFRESH_TOKEN = process.env.JQUANTS_REFRESH_TOKEN

// 4桁コード→J-Quants用5桁コード（国内株は末尾0）
function toJQuantsCode(ticker: string): string {
  return /^\d{4}$/.test(ticker) ? ticker + '0' : ticker
}

// リフレッシュトークン → IDトークン（24時間有効）
async function getIdToken(): Promise<string | null> {
  if (!REFRESH_TOKEN) return null
  try {
    const res = await fetch('https://api.jquants.com/v1/token/auth_refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshtoken: REFRESH_TOKEN }),
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) return null
    const data = await res.json()
    return data.idToken ?? null
  } catch {
    return null
  }
}

interface DailyQuote {
  Date: string
  Code: string
  Open: number
  High: number
  Low: number
  Close: number
  Volume: number
  TurnoverValue: number
}

// 指定銘柄の最新日次株価を取得
async function fetchLatestPrice(ticker: string, idToken: string): Promise<{ price: number; date: string } | null> {
  try {
    const code = toJQuantsCode(ticker)
    const res = await fetch(
      `https://api.jquants.com/v1/prices/daily_quotes?code=${code}`,
      {
        headers: { Authorization: `Bearer ${idToken}` },
        signal: AbortSignal.timeout(10000),
      }
    )
    if (!res.ok) return null
    const data = await res.json()
    const quotes: DailyQuote[] = data.daily_quotes ?? []
    if (quotes.length === 0) return null
    // 最新日（末尾）の終値
    const latest = quotes[quotes.length - 1]
    return { price: latest.Close, date: latest.Date }
  } catch {
    return null
  }
}

// 全保有銘柄の株価を更新（Cron/手動から呼ぶ）
export async function updateAllHoldingPrices(): Promise<{ updated: number; skipped: number; error: string | null }> {
  const idToken = await getIdToken()
  if (!idToken) {
    return { updated: 0, skipped: 0, error: 'JQUANTS_REFRESH_TOKEN が未設定です' }
  }

  const { data: holdings, error } = await adminSupabase
    .from('holdings')
    .select('id, ticker, quantity, purchase_price')

  if (error || !holdings) {
    return { updated: 0, skipped: 0, error: error?.message ?? 'holdings取得失敗' }
  }

  const targets = holdings.filter(
    (h: { ticker: string }) => /^\d{4}$/.test(h.ticker)
  )

  let updated = 0
  let skipped = 0

  await Promise.allSettled(
    targets.map(async (h: { id: string; ticker: string; quantity: number; purchase_price: number }) => {
      const priceData = await fetchLatestPrice(h.ticker, idToken)
      if (!priceData) { skipped++; return }

      const qty = Number(h.quantity)
      const purchasePrice = Number(h.purchase_price)
      const evaluation = Math.round(priceData.price * qty)
      const unrealizedGain = Math.round(evaluation - purchasePrice * qty)
      const costBasis = purchasePrice * qty
      const unrealizedGainPct = costBasis > 0
        ? Math.round((unrealizedGain / costBasis) * 1000) / 10
        : null

      const { error: upErr } = await adminSupabase
        .from('holdings')
        .update({
          current_price: priceData.price,
          evaluation_amount: evaluation,
          unrealized_gain: unrealizedGain,
          unrealized_gain_pct: unrealizedGainPct,
          updated_at: new Date().toISOString(),
        })
        .eq('id', h.id)

      if (!upErr) updated++
      else skipped++
    })
  )

  if (updated > 0) {
    await recalcNisaUsed().catch(console.error)
  }

  return { updated, skipped, error: null }
}

export const isJQuantsConfigured = !!REFRESH_TOKEN
