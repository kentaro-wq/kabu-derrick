import * as cheerio from 'cheerio'

export interface RankingItem {
  rank: number
  ticker: string
  name: string
  price: number
  change: number
  changePct: number
  volume: number | string
  amount?: string
}

export interface HotStock {
  ticker: string
  name: string
  price: number
  changePct: number
  executionCount?: number
  tickCount?: number
}

export interface StopUpStock {
  ticker: string
  name: string
  openPrice: number
  currentPrice: number
  changePct: number
}

// Kabutan.jp の売買代金ランキングを取得
export async function fetchTradingVolumeRankings(): Promise<RankingItem[]> {
  try {
    const res = await fetch('https://kabutan.jp/ranking/', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      },
      signal: AbortSignal.timeout(10000),
    })

    if (!res.ok) return []

    const html = await res.text()
    const $ = cheerio.load(html)
    const rankings: RankingItem[] = []

    // テーブル行をパース（Kabutuanのランキングテーブル構造に合わせて調整）
    $('table tbody tr').each((index, element) => {
      const row = $(element)
      const cells = row.find('td')

      if (cells.length < 5) return

      try {
        const rank = parseInt($(cells[0]).text().trim()) || index + 1
        const nameCell = $(cells[1])
        const ticker = nameCell.find('a').attr('href')?.match(/\d{4}/)?.[0] || ''
        const name = nameCell.text().trim().split('\n')[0]
        const price = parseFloat($(cells[2]).text().trim()) || 0
        const change = parseFloat($(cells[3]).text().trim().replace(/,/g, '')) || 0
        const changePct = parseFloat($(cells[4]).text().trim().replace(/%/g, '')) || 0
        const amount = $(cells[5]).text().trim()

        if (ticker && name) {
          rankings.push({
            rank,
            ticker,
            name,
            price,
            change,
            changePct,
            volume: amount,
            amount,
          })
        }
      } catch {
        // パース失敗時はスキップ
      }
    })

    return rankings
  } catch {
    return []
  }
}

// Kabutan.jp のストップ高銘柄を取得
export async function fetchStopUpStocks(): Promise<StopUpStock[]> {
  try {
    const res = await fetch('https://kabutan.jp/stock/search', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      },
      signal: AbortSignal.timeout(10000),
    })

    if (!res.ok) return []

    const html = await res.text()
    const $ = cheerio.load(html)
    const stopUpStocks: StopUpStock[] = []

    // ストップ高の条件：当日終値が上値制限まで上昇
    $('table tbody tr').each((index, element) => {
      const row = $(element)
      const cells = row.find('td')

      if (cells.length < 4) return

      try {
        const nameCell = $(cells[0])
        const ticker = nameCell.find('a').attr('href')?.match(/\d{4}/)?.[0] || ''
        const name = nameCell.text().trim()
        const price = parseFloat($(cells[1]).text().trim()) || 0
        const changePct = parseFloat($(cells[2]).text().trim().replace(/%/g, '')) || 0

        // changePctが極端に高い値（通常5-10%程度）をストップ高と判定
        if (ticker && changePct > 5) {
          stopUpStocks.push({
            ticker,
            name,
            openPrice: 0,
            currentPrice: price,
            changePct,
          })
        }
      } catch {
        // パース失敗時はスキップ
      }
    })

    return stopUpStocks
  } catch {
    return []
  }
}

// 活況銘柄（約定回数が多い銘柄）を取得
export async function fetchHotStocks(): Promise<HotStock[]> {
  try {
    const res = await fetch('https://kabutan.jp/stock/search', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      },
      signal: AbortSignal.timeout(10000),
    })

    if (!res.ok) return []

    const html = await res.text()
    const $ = cheerio.load(html)
    const hotStocks: HotStock[] = []

    $('table tbody tr').each((index, element) => {
      const row = $(element)
      const cells = row.find('td')

      if (cells.length < 3) return

      try {
        const nameCell = $(cells[0])
        const ticker = nameCell.find('a').attr('href')?.match(/\d{4}/)?.[0] || ''
        const name = nameCell.text().trim()
        const price = parseFloat($(cells[1]).text().trim()) || 0
        const changePct = parseFloat($(cells[2]).text().trim().replace(/%/g, '')) || 0

        if (ticker && name) {
          hotStocks.push({
            ticker,
            name,
            price,
            changePct,
          })
        }
      } catch {
        // パース失敗時はスキップ
      }
    })

    return hotStocks.slice(0, 20) // Top 20を返す
  } catch {
    return []
  }
}

// 市場全体の統計を取得
export async function fetchMarketStats() {
  try {
    const [rankings, stopUp, hotStocks] = await Promise.all([
      fetchTradingVolumeRankings(),
      fetchStopUpStocks(),
      fetchHotStocks(),
    ])

    return {
      timestamp: new Date().toISOString(),
      tradingVolumeRankings: rankings.slice(0, 10),
      stopUpCount: stopUp.length,
      stopUpStocks: stopUp.slice(0, 10),
      hotStocks,
      marketSentiment:
        stopUp.length > 30 ? 'very-bullish' : stopUp.length > 15 ? 'bullish' : stopUp.length > 5 ? 'neutral' : 'bearish',
    }
  } catch {
    return null
  }
}
