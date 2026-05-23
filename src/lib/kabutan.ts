import * as cheerio from 'cheerio'

// ---- 銘柄個別情報 ----

export interface StockInfo {
  ticker: string
  price: number | null        // 現在株価
  changePct: number | null    // 前日比（%）
  per: number | null          // PER
  pbr: number | null          // PBR
  dividendYield: number | null // 配当利回り（%）
  // 業績サマリー（最新通期→予想）
  revenueGrowthPct: number | null  // 売上高前期比（%）
  profitGrowthPct: number | null   // 経常益前期比（%）
  eps: number | null               // 1株益（予想）
  dps: number | null               // 1株配当（予想）
}

function toNum(s: string): number | null {
  const c = s.replace(/[,\s円%倍兆億万&nbsp;]/g, '').replace(/[−－]/g, '-').trim()
  const n = parseFloat(c)
  return isNaN(n) || !isFinite(n) ? null : n
}

export async function fetchStockInfo(ticker: string): Promise<StockInfo | null> {
  try {
    const res = await fetch(`https://kabutan.jp/stock/?code=${ticker}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) return null

    const html = await res.text()
    const $ = cheerio.load(html)

    const info: StockInfo = {
      ticker, price: null, changePct: null, per: null, pbr: null,
      dividendYield: null, revenueGrowthPct: null, profitGrowthPct: null,
      eps: null, dps: null,
    }

    // 現在株価: span.kabuka
    info.price = toNum($('span.kabuka').first().text())

    // 前日比%: dl.si_i1_dl1 内の 2番目のdd
    const changeDds = $('dl.si_i1_dl1 dd')
    if (changeDds.length >= 2) {
      info.changePct = toNum(changeDds.eq(1).text())
    }

    // PER / PBR / 配当利回り: #stockinfo_i3 table 1行目のtd[0][1][2]
    const i3Cells = $('#stockinfo_i3 table tbody tr').first().find('td')
    if (i3Cells.length >= 3) {
      info.per = toNum(i3Cells.eq(0).text())
      info.pbr = toNum(i3Cells.eq(1).text())
      info.dividendYield = toNum(i3Cells.eq(2).text())
    }

    // 業績テーブル: 売上高・経常益・1株益・1株配の前期比・予想を探す
    // テーブルを走査して「決算期」ヘッダーを持つ業績テーブルを特定
    $('table').each((_, tbl) => {
      const headers = $(tbl).find('thead th, tr:first-child th').map((_, th) => $(th).text().trim()).get()
      if (!headers.includes('売上高') && !headers.includes('経常益')) return

      const rows = $(tbl).find('tbody tr')
      // 前期比行を探す
      rows.each((_, row) => {
        const label = $(row).find('td, th').first().text().trim()
        if (label.includes('前期比')) {
          const cells = $(row).find('td')
          // headers順: 決算期,売上高,経常益,最終益,1株益,1株配,発表日
          info.revenueGrowthPct = toNum(cells.eq(0).text())  // 売上高前期比
          info.profitGrowthPct = toNum(cells.eq(1).text())   // 経常益前期比
        }
        // 予想行（"予" を含む）から EPS・DPS を取得
        if (label.includes('予')) {
          const cells = $(row).find('td')
          if (cells.length >= 5) {
            info.eps = toNum(cells.eq(3).text())  // 1株益
            info.dps = toNum(cells.eq(4).text())  // 1株配
          }
        }
      })
    })

    return info
  } catch {
    return null
  }
}

// 複数銘柄を並列取得（個別株ティッカーのみ対象）
export async function fetchMultipleStockInfo(tickers: string[]): Promise<Record<string, StockInfo>> {
  const individualTickers = tickers.filter(t => /^\d{4}$/.test(t))
  if (individualTickers.length === 0) return {}

  const results = await Promise.allSettled(
    individualTickers.map(t => fetchStockInfo(t))
  )
  const map: Record<string, StockInfo> = {}
  results.forEach((r, i) => {
    if (r.status === 'fulfilled' && r.value) map[individualTickers[i]] = r.value
  })
  return map
}

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
      signal: AbortSignal.timeout(3000),
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
      signal: AbortSignal.timeout(3000),
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
      signal: AbortSignal.timeout(3000),
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

export interface GainRankingItem {
  ticker: string
  name: string
  price: number
  changePct: number
  volume: number | null
}

/**
 * kabutan 上昇率ランキング（プライム市場）を取得
 * URL: https://kabutan.jp/ranking/?mode=2&market=1
 * 急騰候補の母集団として使用
 */
export async function fetchGainRankings(market = '1'): Promise<GainRankingItem[]> {
  try {
    const res = await fetch(`https://kabutan.jp/ranking/?mode=2&market=${market}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) return []

    const html = await res.text()
    const $ = cheerio.load(html)
    const items: GainRankingItem[] = []

    // kabutan ランキングテーブルのパース
    $('table.stock_table tbody tr, table.ranking_table tbody tr, #market_table tbody tr').each((_, row) => {
      const cells = $(row).find('td')
      if (cells.length < 4) return

      try {
        // tickerはaタグのhrefから抽出
        const link = $(cells[1]).find('a').first()
        const href = link.attr('href') || $(cells[0]).find('a').attr('href') || ''
        const tickerMatch = href.match(/code=(\d{4})/) || href.match(/\/(\d{4})\//)
        if (!tickerMatch) return

        const ticker = tickerMatch[1]
        const name = link.text().trim() || $(cells[1]).text().trim().split('\n')[0]
        const priceText = $(cells[2]).text().replace(/[,\s]/g, '')
        const changePctText = $(cells[4]).text().replace(/[%\s]/g, '')
        const volumeText = $(cells[5]).text().replace(/[,\s]/g, '')

        const price = parseFloat(priceText)
        const changePct = parseFloat(changePctText)
        const volume = parseFloat(volumeText) || null

        if (ticker && name && !isNaN(price) && price > 0) {
          items.push({ ticker, name, price, changePct: isNaN(changePct) ? 0 : changePct, volume })
        }
      } catch { /* skip */ }
    })

    // パースできない場合は汎用テーブルパースにフォールバック
    if (items.length === 0) {
      $('table tbody tr').each((_, row) => {
        const cells = $(row).find('td')
        if (cells.length < 4) return
        try {
          const allLinks = $(row).find('a')
          let ticker = ''
          let name = ''
          allLinks.each((_, a) => {
            const href = $(a).attr('href') || ''
            const m = href.match(/code=(\d{4})/) || href.match(/[?/](\d{4})/)
            if (m && !ticker) {
              ticker = m[1]
              name = $(a).text().trim()
            }
          })
          if (!ticker) return
          const nums = cells.map((_, td) => parseFloat($(td).text().replace(/[,%\s円]/g, ''))).get().filter(n => !isNaN(n))
          if (nums.length >= 2) {
            items.push({ ticker, name, price: nums[0], changePct: nums[nums.length - 2] || 0, volume: null })
          }
        } catch { /* skip */ }
      })
    }

    return items
      .filter(i => /^\d{4}$/.test(i.ticker))
      .slice(0, 60)
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
