interface YahooChartResult {
  chart: {
    result: Array<{
      meta: {
        regularMarketPrice: number
        // 注: Yahoo Finance API は previousClose を常に null で返す（API仕様）。
        // 前日終値が必要な場合は chartPreviousClose (range=2d で取得) を使う。
        // 当ファイルの fetchPrice は最新価格のみ取得する用途なので未使用。
      }
    }> | null
    error: unknown
  }
}

export async function fetchPrice(ticker: string): Promise<number | null> {
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

/**
 * Yahoo Finance から OHLCV bars を取得（J-Quants フォールバック用）
 * J-Quants 無料プランの遅延・キャッシュ問題で直近データが取れない時に使う。
 * AdjC は無いので、株式分割がある銘柄では時系列ジャンプが発生する点に注意。
 */
interface YahooBar {
  date: string
  open: number
  high: number
  low: number
  close: number
  volume: number
}

interface YahooChartFullResult {
  chart: {
    result: Array<{
      timestamp: number[]
      indicators: {
        quote: Array<{
          open: (number | null)[]
          high: (number | null)[]
          low: (number | null)[]
          close: (number | null)[]
          volume: (number | null)[]
        }>
      }
    }> | null
    error: unknown
  }
}

export async function fetchYahooBars(ticker: string, range = '3mo'): Promise<YahooBar[]> {
  const symbol = /^\d{4}$/.test(ticker) ? `${ticker}.T` : ticker
  try {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=${range}`,
      { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(10000) }
    )
    if (!res.ok) return []
    const data: YahooChartFullResult = await res.json()
    const r = data.chart?.result?.[0]
    if (!r) return []
    const ts = r.timestamp ?? []
    const q = r.indicators?.quote?.[0]
    if (!q) return []
    const bars: YahooBar[] = []
    for (let i = 0; i < ts.length; i++) {
      const o = q.open[i], h = q.high[i], l = q.low[i], c = q.close[i], v = q.volume[i]
      if (o == null || h == null || l == null || c == null) continue
      bars.push({
        date: new Date(ts[i] * 1000).toISOString().slice(0, 10),
        open: o, high: h, low: l, close: c, volume: v ?? 0,
      })
    }
    return bars
  } catch {
    return []
  }
}

/**
 * Yahoo Finance から年間配当情報を取得
 * 直近1年の配当合計と、現在価格に対する利回りを返す
 * 取得失敗時は null（配当なし銘柄 or データ取得不可）
 */
export interface DividendInfo {
  annualDividend: number  // 直近1年の配当合計（円）
  yieldPct: number        // 利回り(%) = annualDividend / 現在価格 × 100
  lastExDate: string      // 直近の権利確定日 (ISO date)
}

export async function fetchDividendInfo(ticker: string): Promise<DividendInfo | null> {
  const symbol = /^\d{4}$/.test(ticker) ? `${ticker}.T` : ticker
  try {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=1y&events=div`,
      { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(8000) }
    )
    if (!res.ok) return null
    const data = await res.json()
    const r = data.chart?.result?.[0]
    if (!r) return null
    const currentPrice = r.meta?.regularMarketPrice
    const dividends = r.events?.dividends ?? {}
    const divEntries = Object.values(dividends) as Array<{ amount: number; date: number }>
    if (divEntries.length === 0 || !currentPrice) return null
    // 直近1年の配当合計
    const oneYearAgo = Date.now() / 1000 - 365 * 86400
    const recentDivs = divEntries.filter(d => d.date >= oneYearAgo)
    if (recentDivs.length === 0) return null
    const annualDividend = recentDivs.reduce((s, d) => s + d.amount, 0)
    const yieldPct = (annualDividend / currentPrice) * 100
    const lastExDate = new Date(Math.max(...recentDivs.map(d => d.date)) * 1000)
      .toISOString().slice(0, 10)
    return {
      annualDividend: Math.round(annualDividend * 100) / 100,
      yieldPct: Math.round(yieldPct * 100) / 100,
      lastExDate,
    }
  } catch {
    return null
  }
}

// テキストから日本株の証券コード（4桁数字）を抽出する
// 1300〜9999 の範囲に絞ることで年号・金額などの誤検出を減らす
export function extractTickers(text: string): string[] {
  const matches = text.match(/\b\d{4}\b/g) ?? []
  return [...new Set(
    matches.filter(m => {
      const n = parseInt(m)
      return n >= 1300 && n <= 9999
    })
  )]
}

// テキストに含まれる銘柄コードのリアルタイム株価を一括取得
export async function fetchMentionedPrices(text: string): Promise<Record<string, number>> {
  const tickers = extractTickers(text)
  if (tickers.length === 0) return {}
  const entries = await Promise.all(
    tickers.map(async ticker => {
      const price = await fetchPrice(ticker)
      return price != null ? [ticker, price] as [string, number] : null
    })
  )
  return Object.fromEntries(entries.filter((e): e is [string, number] => e !== null))
}
