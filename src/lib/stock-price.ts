interface YahooChartResult {
  chart: {
    result: Array<{
      meta: {
        regularMarketPrice: number
        previousClose: number
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
