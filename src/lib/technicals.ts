/**
 * テクニカル指標計算ライブラリ
 * 移動平均・RSI・出来高比率・ゴールデンクロス判定
 */

export interface OHLCVBar {
  date: string
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export interface TechnicalIndicators {
  ma5: number | null
  ma25: number | null
  ma75: number | null
  volumeRatio: number | null       // 直近出来高 ÷ 20日平均
  rsi14: number | null
  goldenCross: boolean             // MA5がMA25を直近3日以内に上抜け
  aboveMA25: boolean               // 終値 ≥ MA25
  aboveMA75: boolean               // 終値 ≥ MA75
  priceChangeFromLow: number | null // 直近25日安値からの上昇率(%)
  consecutiveUp: number            // 連続陽線日数
  todayChangePct: number | null    // 当日の騰落率(%)
}

function average(arr: number[]): number | null {
  if (arr.length === 0) return null
  return arr.reduce((a, b) => a + b, 0) / arr.length
}

/** 14日RSI計算 */
function calcRSI(closes: number[], period = 14): number | null {
  if (closes.length < period + 1) return null
  const changes: number[] = []
  for (let i = 1; i < closes.length; i++) {
    changes.push(closes[i] - closes[i - 1])
  }
  const recent = changes.slice(-period)
  const gains = recent.filter(c => c > 0)
  const losses = recent.filter(c => c < 0).map(c => -c)
  const avgGain = gains.reduce((a, b) => a + b, 0) / period
  const avgLoss = losses.reduce((a, b) => a + b, 0) / period
  if (avgLoss === 0) return 100
  const rs = avgGain / avgLoss
  return Math.round((100 - 100 / (1 + rs)) * 10) / 10
}

/** 全テクニカル指標を計算 */
export function calcIndicators(bars: OHLCVBar[]): TechnicalIndicators {
  const closes = bars.map(b => b.close)
  const volumes = bars.map(b => b.volume)
  const n = bars.length

  const ma5 = n >= 5 ? average(closes.slice(-5)) : null
  const ma25 = n >= 25 ? average(closes.slice(-25)) : null
  const ma75 = n >= 75 ? average(closes.slice(-75)) : null

  const vol20avg = n >= 20 ? average(volumes.slice(-20)) : null
  const lastVol = volumes[n - 1]
  const volumeRatio = vol20avg && vol20avg > 0
    ? Math.round((lastVol / vol20avg) * 100) / 100
    : null

  const rsi14 = calcRSI(closes)

  // ゴールデンクロス判定（直近3日でMA5がMA25を上抜け）
  let goldenCross = false
  if (n >= 28) {
    for (let i = Math.max(26, n - 3); i <= n - 1; i++) {
      const prevMA5 = average(closes.slice(i - 5, i))
      const prevMA25 = average(closes.slice(i - 25, i))
      const curMA5 = average(closes.slice(i - 4, i + 1))
      const curMA25 = average(closes.slice(i - 24, i + 1))
      if (prevMA5 !== null && prevMA25 !== null && curMA5 !== null && curMA25 !== null) {
        if (prevMA5 <= prevMA25 && curMA5 > curMA25) {
          goldenCross = true
          break
        }
      }
    }
  }

  const lastClose = closes[n - 1]
  const aboveMA25 = ma25 !== null && lastClose >= ma25
  const aboveMA75 = ma75 !== null && lastClose >= ma75

  // 直近25日安値からの上昇率
  const lows25 = bars.slice(-25).map(b => b.low)
  const min25 = Math.min(...lows25)
  const priceChangeFromLow = min25 > 0
    ? Math.round(((lastClose - min25) / min25) * 1000) / 10
    : null

  // 連続陽線日数
  let consecutiveUp = 0
  for (let i = n - 1; i >= 0; i--) {
    if (bars[i].close > bars[i].open) consecutiveUp++
    else break
  }

  // 当日騰落率
  const todayChangePct = n >= 2
    ? Math.round(((closes[n - 1] - closes[n - 2]) / closes[n - 2]) * 1000) / 10
    : null

  return {
    ma5: ma5 != null ? Math.round(ma5) : null,
    ma25: ma25 != null ? Math.round(ma25) : null,
    ma75: ma75 != null ? Math.round(ma75) : null,
    volumeRatio,
    rsi14,
    goldenCross,
    aboveMA25,
    aboveMA75,
    priceChangeFromLow,
    consecutiveUp,
    todayChangePct,
  }
}

/** テクニカル指標をAIに渡すテキストサマリーに変換 */
export function summarizeIndicators(ticker: string, price: number, ind: TechnicalIndicators): string {
  const lines: string[] = []
  lines.push(`【${ticker}】現在値: ${price.toLocaleString()}円`)

  if (ind.ma5 && ind.ma25) {
    const pct5 = Math.round(((price - ind.ma5) / ind.ma5) * 1000) / 10
    const pct25 = Math.round(((price - ind.ma25) / ind.ma25) * 1000) / 10
    lines.push(`MA5: ${ind.ma5.toLocaleString()}円 (乖離${pct5 >= 0 ? '+' : ''}${pct5}%), MA25: ${ind.ma25.toLocaleString()}円 (乖離${pct25 >= 0 ? '+' : ''}${pct25}%)`)
  }
  if (ind.ma75) {
    const pct75 = Math.round(((price - ind.ma75) / ind.ma75) * 1000) / 10
    lines.push(`MA75: ${ind.ma75.toLocaleString()}円 (乖離${pct75 >= 0 ? '+' : ''}${pct75}%)`)
  }
  if (ind.volumeRatio != null) lines.push(`出来高比率: ${ind.volumeRatio}倍（20日平均比）`)
  if (ind.rsi14 != null) lines.push(`RSI(14): ${ind.rsi14}`)
  if (ind.goldenCross) lines.push(`✓ ゴールデンクロス（直近3日以内）`)
  if (ind.aboveMA25) lines.push(`✓ MA25上抜け済み`)
  if (ind.aboveMA75) lines.push(`✓ MA75上抜け済み`)
  if (ind.priceChangeFromLow != null) lines.push(`直近25日安値からの上昇率: +${ind.priceChangeFromLow}%`)
  if (ind.consecutiveUp >= 2) lines.push(`連続陽線: ${ind.consecutiveUp}日`)
  if (ind.todayChangePct != null) lines.push(`当日騰落率: ${ind.todayChangePct >= 0 ? '+' : ''}${ind.todayChangePct}%`)

  return lines.join('\n')
}
