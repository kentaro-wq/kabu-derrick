/**
 * セグメント別 出口戦略比較
 *
 * 銘柄を「価格帯 × ボラティリティ」でセグメント化し、
 * 各セグメントで最適な出口戦略を発見する。
 *
 * 仮説:
 *  - 低価格・高ボラ → F戦略 (急騰捕捉、連続陰線で売り)
 *  - 高価格・低ボラ → 固定20日保有 (ゆっくり上がる)
 *  - 高価格・高ボラ → トレーリングストップ (大きな振れに対応)
 *
 * これを実データで検証する。
 */
import { NextResponse } from 'next/server'
import { adminSupabase } from '@/lib/supabase'
import type { OHLCVBar } from '@/lib/technicals'
import { fetchYahooBars } from '@/lib/stock-price'

export const maxDuration = 60

interface Bar { date: string; open: number; high: number; low: number; close: number; volume: number }
interface ExitResult { exitDay: number; exitPrice: number; returnPct: number }

// ===== 出口戦略（前回と同じ） =====
function fixedHold(entry: number, forward: Bar[], days: number): ExitResult | null {
  if (forward.length < days) return null
  const bar = forward[days - 1]
  return { exitDay: days, exitPrice: bar.close, returnPct: (bar.close - entry) / entry * 100 }
}
function trailingStop(entry: number, forward: Bar[], dropPct: number): ExitResult | null {
  if (forward.length === 0) return null
  let peak = entry
  for (let i = 0; i < forward.length; i++) {
    const b = forward[i]
    if (b.high > peak) peak = b.high
    const stopLevel = peak * (1 - dropPct / 100)
    if (b.low <= stopLevel) return { exitDay: i + 1, exitPrice: stopLevel, returnPct: (stopLevel - entry) / entry * 100 }
  }
  const last = forward[forward.length - 1]
  return { exitDay: forward.length, exitPrice: last.close, returnPct: (last.close - entry) / entry * 100 }
}
function consecutiveDownExit(entry: number, forward: Bar[], requireConsec = 3, minGain = 5): ExitResult | null {
  if (forward.length === 0) return null
  let down = 0, gained = false
  for (let i = 0; i < forward.length; i++) {
    const b = forward[i]
    if ((b.close - entry) / entry * 100 >= minGain) gained = true
    down = b.close < b.open ? down + 1 : 0
    if (gained && down >= requireConsec) return { exitDay: i + 1, exitPrice: b.close, returnPct: (b.close - entry) / entry * 100 }
  }
  const last = forward[forward.length - 1]
  return { exitDay: forward.length, exitPrice: last.close, returnPct: (last.close - entry) / entry * 100 }
}
function fixedTargetExit(entry: number, forward: Bar[], tp = 10, sl = -5): ExitResult | null {
  if (forward.length === 0) return null
  const tpLv = entry * (1 + tp / 100), slLv = entry * (1 + sl / 100)
  for (let i = 0; i < forward.length; i++) {
    const b = forward[i]
    if (b.low <= slLv) return { exitDay: i + 1, exitPrice: slLv, returnPct: sl }
    if (b.high >= tpLv) return { exitDay: i + 1, exitPrice: tpLv, returnPct: tp }
  }
  const last = forward[forward.length - 1]
  return { exitDay: forward.length, exitPrice: last.close, returnPct: (last.close - entry) / entry * 100 }
}

const STRATEGIES = [
  { key: 'hold10',     name: '固定10日',           fn: (e: number, f: Bar[]) => fixedHold(e, f, 10) },
  { key: 'hold20',     name: '固定20日',           fn: (e: number, f: Bar[]) => fixedHold(e, f, 20) },
  { key: 'trail10',    name: 'トレーリング-10%',    fn: (e: number, f: Bar[]) => trailingStop(e, f, 10) },
  { key: 'downstreak', name: '連続陰線で売(F)',    fn: (e: number, f: Bar[]) => consecutiveDownExit(e, f, 3, 5) },
  { key: 'target10_5', name: '+10利確/-5損切',    fn: (e: number, f: Bar[]) => fixedTargetExit(e, f, 10, -5) },
  { key: 'target15_8', name: '+15利確/-8損切',    fn: (e: number, f: Bar[]) => fixedTargetExit(e, f, 15, -8) },
]

// ===== ボラティリティ計算 =====
function calcVolatility(pastBars: Bar[]): number {
  if (pastBars.length < 2) return 0
  const returns: number[] = []
  for (let i = 1; i < pastBars.length; i++) {
    returns.push((pastBars[i].close - pastBars[i - 1].close) / pastBars[i - 1].close)
  }
  const mean = returns.reduce((s, v) => s + v, 0) / returns.length
  const variance = returns.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / returns.length
  return Math.sqrt(variance) * 100 // % per day
}

// ===== セグメント分類 =====
function priceTier(price: number): string {
  if (price < 1000) return '1_低位 (<1000)'
  if (price < 3000) return '2_中位 (1000-3000)'
  return '3_高位 (3000+)'
}
function volTier(vol: number): string {
  if (vol < 2) return '1_低ボラ (<2%/日)'
  if (vol < 4) return '2_中ボラ (2-4%)'
  return '3_高ボラ (4%+)'
}

interface SignalCase {
  ticker: string
  signal_date: string
  entry: number
  forward: Bar[]
  vol: number
  priceTier: string
  volTier: string
}

interface SegmentResult {
  segment: string
  priceTier: string
  volTier: string
  n: number
  best: { key: string; name: string; avgReturn: number; medianReturn: number; winRate: number }
  all: { key: string; name: string; avgReturn: number; medianReturn: number; winRate: number; bigLossRate: number }[]
}

export async function GET() {
  // fired signal を取得
  const { data: signals } = await adminSupabase
    .from('backtest_signals')
    .select('ticker, signal_date, price_at_signal')
    .eq('claude_fire', true)
    .not('price_at_signal', 'is', null)
    .limit(2000)

  if (!signals || signals.length === 0) {
    return NextResponse.json({ message: 'no fired signals' })
  }

  // OHLCV キャッシュ一括取得 + Yahoo フォールバック
  // J-Quants Free プランは12週間遅延でバックテスト用銘柄はキャッシュにない場合が多い
  // → Yahoo Finance から直接取得する
  const tickers = [...new Set(signals.map(s => s.ticker))]
  const { data: cacheRows } = await adminSupabase
    .from('jquants_ohlcv_cache')
    .select('ticker, bars')
    .in('ticker', tickers)
  const barsMap = new Map<string, OHLCVBar[]>()
  for (const r of cacheRows ?? []) barsMap.set(r.ticker, r.bars as OHLCVBar[])

  // キャッシュに無い銘柄を Yahoo から並列取得 (5並列)
  const missingTickers = tickers.filter(t => !barsMap.has(t))
  if (missingTickers.length > 0) {
    const PARALLEL = 5
    for (let i = 0; i < missingTickers.length; i += PARALLEL) {
      const batch = missingTickers.slice(i, i + PARALLEL)
      const results = await Promise.all(
        batch.map(async ticker => {
          // Yahoo bars には AdjC が無いので株式分割銘柄は注意。
          // バックテスト用途では各シグナル日近辺の連続性が大事なので close を使う
          const bars = await fetchYahooBars(ticker, '1y')
          return { ticker, bars: bars as OHLCVBar[] }
        })
      )
      for (const { ticker, bars } of results) {
        if (bars.length > 0) barsMap.set(ticker, bars)
      }
    }
  }

  // 各 signal を SignalCase に変換しつつセグメント分類
  const cases: SignalCase[] = []
  for (const s of signals) {
    const bars = barsMap.get(s.ticker)
    if (!bars) continue
    const entry = Number(s.price_at_signal)
    if (!entry || entry <= 0) continue
    const signalIdx = bars.findIndex(b => b.date === s.signal_date)
    if (signalIdx < 20) continue // 過去20日が必要
    const pastBars = bars.slice(signalIdx - 20, signalIdx)
    const forward = bars.filter(b => b.date > s.signal_date).slice(0, 30)
    if (forward.length < 10) continue
    const vol = calcVolatility(pastBars)
    cases.push({
      ticker: s.ticker, signal_date: s.signal_date, entry, forward,
      vol, priceTier: priceTier(entry), volTier: volTier(vol),
    })
  }

  // セグメント別集計
  const segments: SegmentResult[] = []
  const allTiers: [string, string][] = []
  for (const p of ['1_低位 (<1000)', '2_中位 (1000-3000)', '3_高位 (3000+)']) {
    for (const v of ['1_低ボラ (<2%/日)', '2_中ボラ (2-4%)', '3_高ボラ (4%+)']) {
      allTiers.push([p, v])
    }
  }

  for (const [pt, vt] of allTiers) {
    const segCases = cases.filter(c => c.priceTier === pt && c.volTier === vt)
    if (segCases.length < 5) continue // サンプル少なすぎは除外

    const strategyResults = STRATEGIES.map(strat => {
      const results = segCases.map(c => strat.fn(c.entry, c.forward)).filter((r): r is ExitResult => r !== null)
      const returns = results.map(r => r.returnPct).sort((a, b) => a - b)
      const avg = returns.reduce((s, v) => s + v, 0) / (returns.length || 1)
      const med = returns[Math.floor(returns.length / 2)] ?? 0
      const wins = returns.filter(r => r >= 0).length
      const bigLoss = returns.filter(r => r <= -10).length
      return {
        key: strat.key, name: strat.name,
        avgReturn: Math.round(avg * 10) / 10,
        medianReturn: Math.round(med * 10) / 10,
        winRate: Math.round((wins / (returns.length || 1)) * 1000) / 10,
        bigLossRate: Math.round((bigLoss / (returns.length || 1)) * 1000) / 10,
      }
    })

    strategyResults.sort((a, b) => b.avgReturn - a.avgReturn)
    segments.push({
      segment: `${pt} × ${vt}`,
      priceTier: pt,
      volTier: vt,
      n: segCases.length,
      best: strategyResults[0],
      all: strategyResults,
    })
  }

  return NextResponse.json({
    totalCases: cases.length,
    segmentCount: segments.length,
    segments,
    note: '価格帯(3) × ボラ(3) = 9セグメントで分析。各セグメントで最適戦略が異なる可能性を検証',
  })
}
