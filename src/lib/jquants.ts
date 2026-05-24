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

// V2 daily bars response format: { data: [{ Date, Code, O, H, L, C, Vo, Va, AdjO, AdjH, AdjL, AdjC, AdjVo, ... }] }
interface DailyBarV2 {
  Date: string
  Code: string
  O: number   // Open
  H: number   // High
  L: number   // Low
  C: number   // Close
  Vo: number  // Volume
  Va?: number // Turnover Value
  AdjO?: number
  AdjH?: number
  AdjL?: number
  AdjC?: number
  AdjVo?: number
}

// 指定銘柄の最新日次株価を取得（V2 API）
async function fetchLatestPrice(ticker: string, apiKey: string): Promise<{ price: number; date: string } | null> {
  try {
    const code = toJQuantsCode(ticker)
    const res = await fetch(
      `https://api.jquants.com/v2/equities/bars/daily?code=${code}`,
      {
        headers: authHeaders(apiKey),
        signal: AbortSignal.timeout(10000),
      }
    )
    if (!res.ok) return null
    const data = await res.json()
    const bars: DailyBarV2[] = data.data ?? []
    if (bars.length === 0) return null
    const latest = bars[bars.length - 1]
    return { price: latest.C, date: latest.Date }
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
    // V2 API: /v2/equities/bars/daily（ページネーション対応）
    const allBars: DailyBarV2[] = []
    let paginationKey: string | undefined
    const baseUrl = `https://api.jquants.com/v2/equities/bars/daily?code=${code}&from=${fromStr}&to=${toStr}`
    let safety = 0
    do {
      const url = paginationKey
        ? `${baseUrl}&pagination_key=${encodeURIComponent(paginationKey)}`
        : baseUrl
      const res = await fetch(url, {
        headers: authHeaders(idToken),
        signal: AbortSignal.timeout(10000),
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        console.error(`[jquants] v2 bars ${code} HTTP ${res.status}: ${text.slice(0, 200)}`)
        break
      }
      const data = await res.json()
      const chunk: DailyBarV2[] = data.data ?? []
      allBars.push(...chunk)
      paginationKey = data.pagination_key
      safety++
      if (safety > 20) break  // 最大20ページ（=数千件）で安全停止
    } while (paginationKey)

    if (allBars.length === 0) {
      console.error(`[jquants] v2 bars ${code} empty response`)
    }
    return allBars
      .filter(b => b.C != null && b.Vo != null)
      .slice(-days)
      .map(b => ({
        date: b.Date,
        open: b.O,
        high: b.H,
        low: b.L,
        close: b.C,
        volume: b.Vo,
      }))
  } catch (e) {
    console.error(`[jquants] v2 bars ${code} exception:`, e)
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
