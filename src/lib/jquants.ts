/**
 * J-Quants API（日本取引所グループ公式・無料）
 * 登録: https://jpx-jquants.com/
 * 環境変数: JQUANTS_REFRESH_TOKEN
 */
import { adminSupabase } from '@/lib/supabase'
import { recalcNisaUsed } from '@/lib/nisa-sync'

// J-Quants V2 仕様: APIキーを X-API-Key ヘッダーで直接送る
// 環境変数名は互換性のため JQUANTS_REFRESH_TOKEN のまま使用
const API_KEY = process.env.JQUANTS_REFRESH_TOKEN

// 4桁コード→J-Quants用5桁コード（国内株は末尾0）
function toJQuantsCode(ticker: string): string {
  return /^\d{4}$/.test(ticker) ? ticker + '0' : ticker
}

// V2では事前認証不要。APIキーをそのまま返す（既存コードとの互換用）
async function getIdToken(): Promise<string | null> {
  return API_KEY ?? null
}

// V2 仕様の認証ヘッダーを生成
function authHeaders(apiKey: string): Record<string, string> {
  return { 'X-API-Key': apiKey }
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
async function fetchLatestPrice(ticker: string, apiKey: string): Promise<{ price: number; date: string } | null> {
  try {
    const code = toJQuantsCode(ticker)
    const res = await fetch(
      `https://api.jquants.com/v1/prices/daily_quotes?code=${code}`,
      {
        headers: authHeaders(apiKey),
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

/**
 * 指定銘柄の過去N日分のOHLCVを取得（テクニカル指標計算用）
 * idToken を外部から渡すことで、バッチ処理時のトークン取得を1回に抑制できる
 */
export async function fetchOHLCVHistory(
  ticker: string,
  days = 80,
  idTokenOverride?: string | null,
): Promise<import('./technicals').OHLCVBar[]> {
  const idToken = idTokenOverride ?? await getIdToken()
  if (!idToken) return []

  const code = toJQuantsCode(ticker)
  const to = new Date()
  const from = new Date()
  from.setDate(from.getDate() - Math.ceil(days * 1.6)) // 土日・祝日考慮で多めに取得

  const fromStr = from.toISOString().slice(0, 10)
  const toStr = to.toISOString().slice(0, 10)

  try {
    const res = await fetch(
      `https://api.jquants.com/v1/prices/daily_quotes?code=${code}&from=${fromStr}&to=${toStr}`,
      {
        headers: authHeaders(idToken),
        signal: AbortSignal.timeout(10000),
      }
    )
    if (!res.ok) return []
    const data = await res.json()
    const quotes: DailyQuote[] = data.daily_quotes ?? []
    return quotes
      .filter(q => q.Close != null && q.Volume != null)
      .slice(-days)
      .map(q => ({
        date: q.Date,
        open: q.Open,
        high: q.High,
        low: q.Low,
        close: q.Close,
        volume: q.Volume,
      }))
  } catch {
    return []
  }
}

/** IDトークンを外部から使えるようにエクスポート */
export { getIdToken }

export const isJQuantsConfigured = !!API_KEY

/**
 * キャッシュ付きOHLCV取得
 *
 * Supabaseの jquants_ohlcv_cache を参照し、12時間以内のキャッシュがあれば再利用。
 * スプリント実行で同じデータを何度も使うときに大幅な速度向上。
 *
 * 引数 ohlcvCache を渡すとメモリ内でも共有でき、1回のスプリントで実質ゼロコスト。
 */
export async function fetchOHLCVHistoryCached(
  ticker: string,
  days = 380,
  idToken: string,
  options?: {
    memoryCache?: Map<string, import('./technicals').OHLCVBar[]>
    ttlHours?: number
  },
): Promise<import('./technicals').OHLCVBar[]> {
  // 1. メモリキャッシュ確認
  if (options?.memoryCache?.has(ticker)) {
    return options.memoryCache.get(ticker)!.slice(-days)
  }

  // 2. Supabaseキャッシュ確認
  const ttlHours = options?.ttlHours ?? 12
  const { data: cached } = await adminSupabase
    .from('jquants_ohlcv_cache')
    .select('bars, cached_at')
    .eq('ticker', ticker)
    .single()

  if (cached?.bars && cached.cached_at) {
    const ageHours = (Date.now() - new Date(cached.cached_at).getTime()) / (1000 * 60 * 60)
    if (ageHours < ttlHours) {
      const bars = cached.bars as import('./technicals').OHLCVBar[]
      options?.memoryCache?.set(ticker, bars)
      return bars.slice(-days)
    }
  }

  // 3. 鮮度切れ or 未キャッシュ → 取得して保存
  const fresh = await fetchOHLCVHistory(ticker, Math.max(days, 380), idToken)
  if (fresh.length > 0) {
    options?.memoryCache?.set(ticker, fresh)
    await adminSupabase
      .from('jquants_ohlcv_cache')
      .upsert({
        ticker,
        bars: fresh,
        date_from: fresh[0]?.date,
        date_to: fresh[fresh.length - 1]?.date,
        cached_at: new Date().toISOString(),
      }, { onConflict: 'ticker' })
      .then(() => {}, e => console.error('[jquants] cache upsert error:', e))
  }
  return fresh.slice(-days)
}
