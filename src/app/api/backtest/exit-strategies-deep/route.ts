/**
 * 出口戦略の深掘り検証 — 中位×中ボラセグメントで「もっと持つ」戦略を比較
 *
 * 動機: 「+15%で売る」が本当に最強か、+20/+25/+30 まで持つほうが
 * 儲かるかをバックテストで検証する。
 */
import { NextResponse } from 'next/server'
import { adminSupabase } from '@/lib/supabase'
import type { OHLCVBar } from '@/lib/technicals'
import { classifyPriceTier, classifyVolTier, calcVolatility } from '@/lib/segment'

export const maxDuration = 60

interface Bar { date: string; open: number; high: number; low: number; close: number; volume: number }
interface ExitResult { exitDay: number; exitPrice: number; returnPct: number }

function fixedTarget(entry: number, forward: Bar[], tp: number, sl: number): ExitResult | null {
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

/**
 * Adaptive AI Exit (機械ルール近似版)
 * -8% 損切 + 含み益+5%超でモメンタム機械判定 → 死亡で売却
 *
 * AI判定の近似ロジック:
 *  ・終値 < MA5 → モメンタム死亡
 *  ・RSI(14) >= 75 → 過熱で売却
 *  ・2日連続陰線 → 売却
 *  上記いずれも該当しなければ hold
 */
function adaptiveExit(entry: number, forward: Bar[]): ExitResult | null {
  if (forward.length === 0) return null
  const slLv = entry * 0.92  // -8%
  for (let i = 0; i < forward.length; i++) {
    const b = forward[i]
    // 損切（日中安値到達でも発動）
    if (b.low <= slLv) {
      return { exitDay: i + 1, exitPrice: slLv, returnPct: -8 }
    }
    const gain = (b.close - entry) / entry * 100
    // 利確判定
    if (gain >= 5 && i >= 4) {
      // MA5計算（過去5日終値）
      const ma5 = forward.slice(i - 4, i + 1).reduce((s, b) => s + b.close, 0) / 5
      // RSI(14): 14日変化＝15バー必要
      if (i < 14) continue
      const window = forward.slice(i - 14, i + 1)  // 15バー
      const ups: number[] = [], downs: number[] = []
      for (let j = 1; j < window.length; j++) {
        const diff = window[j].close - window[j - 1].close
        if (diff > 0) ups.push(diff)
        else if (diff < 0) downs.push(-diff)
      }
      const avgGain = ups.reduce((s, v) => s + v, 0) / 14
      const avgLoss = downs.reduce((s, v) => s + v, 0) / 14
      const rs = avgLoss > 0 ? avgGain / avgLoss : 100
      const rsi = avgLoss > 0 ? 100 - 100 / (1 + rs) : 100

      // 連続陰線判定（直近2日）
      const consecutiveDown =
        i >= 1 &&
        forward[i].close < forward[i].open &&
        forward[i - 1].close < forward[i - 1].open

      // モメンタム判定
      const belowMA5 = b.close < ma5
      const overheated = rsi >= 75
      const momentumDead = belowMA5 || overheated || consecutiveDown

      if (momentumDead) {
        return { exitDay: i + 1, exitPrice: b.close, returnPct: gain }
      }
    }
  }
  // 最後まで持つ
  const last = forward[forward.length - 1]
  return { exitDay: forward.length, exitPrice: last.close, returnPct: (last.close - entry) / entry * 100 }
}

/** +15%超えた後、高値から指定%下落で売る (利確以降のトレーリング) */
function trailingAfterProfit(entry: number, forward: Bar[], activatePct: number, trailPct: number, sl: number): ExitResult | null {
  if (forward.length === 0) return null
  const slLv = entry * (1 + sl / 100)
  let activated = false
  let peak = entry
  for (let i = 0; i < forward.length; i++) {
    const b = forward[i]
    if (b.low <= slLv && !activated) return { exitDay: i + 1, exitPrice: slLv, returnPct: sl }
    if (!activated) {
      const gain = (b.high - entry) / entry * 100
      if (gain >= activatePct) {
        activated = true
        peak = Math.max(peak, b.high)
      }
    } else {
      if (b.high > peak) peak = b.high
      const trailStop = peak * (1 - trailPct / 100)
      if (b.low <= trailStop) return { exitDay: i + 1, exitPrice: trailStop, returnPct: (trailStop - entry) / entry * 100 }
    }
  }
  const last = forward[forward.length - 1]
  return { exitDay: forward.length, exitPrice: last.close, returnPct: (last.close - entry) / entry * 100 }
}

const STRATEGIES = [
  { key: 'A_15_8',  name: 'A: +15%利確/-8%損切 (旧)',  fn: (e: number, f: Bar[]) => fixedTarget(e, f, 15, -8) },
  { key: 'B_20_8',  name: 'B: +20%利確/-8%損切',          fn: (e: number, f: Bar[]) => fixedTarget(e, f, 20, -8) },
  { key: 'C_25_8',  name: 'C: +25%利確/-8%損切',          fn: (e: number, f: Bar[]) => fixedTarget(e, f, 25, -8) },
  { key: 'D_30_10', name: 'D: +30%利確/-10%損切',         fn: (e: number, f: Bar[]) => fixedTarget(e, f, 30, -10) },
  { key: 'E_50_10', name: 'E: +50%利確/-10%損切',         fn: (e: number, f: Bar[]) => fixedTarget(e, f, 50, -10) },
  { key: 'F_trail_15_5_8',  name: 'F: +15%到達後 高値-5%で売 (-8%損切)',  fn: (e: number, f: Bar[]) => trailingAfterProfit(e, f, 15, 5, -8) },
  { key: 'G_trail_15_10_8', name: 'G: +15%到達後 高値-10%で売 (-8%損切)', fn: (e: number, f: Bar[]) => trailingAfterProfit(e, f, 15, 10, -8) },
  { key: 'H_trail_20_5_8',  name: 'H: +20%到達後 高値-5%で売 (-8%損切)',  fn: (e: number, f: Bar[]) => trailingAfterProfit(e, f, 20, 5, -8) },
  { key: 'I_adaptive', name: 'I: Adaptive AI Exit (現行/-8損切+モメンタム判定)', fn: (e: number, f: Bar[]) => adaptiveExit(e, f) },
]

export async function GET() {
  const { data: signals } = await adminSupabase
    .from('backtest_signals')
    .select('ticker, signal_date, price_at_signal')
    .eq('claude_fire', true)
    .not('price_at_signal', 'is', null)
    .limit(2000)

  if (!signals || signals.length === 0) return NextResponse.json({ message: 'no signals' })

  const tickers = [...new Set(signals.map(s => s.ticker))]
  const { data: cacheRows } = await adminSupabase
    .from('jquants_ohlcv_cache')
    .select('ticker, bars')
    .in('ticker', tickers)
  const barsMap = new Map<string, OHLCVBar[]>()
  for (const r of cacheRows ?? []) barsMap.set(r.ticker, r.bars as OHLCVBar[])

  // 中位×中ボラ のみを抽出
  const midmidCases: { entry: number; forward: Bar[] }[] = []
  for (const s of signals) {
    const bars = barsMap.get(s.ticker)
    if (!bars) continue
    const entry = Number(s.price_at_signal)
    if (!entry || entry <= 0) continue
    const idx = bars.findIndex(b => b.date === s.signal_date)
    if (idx < 20) continue
    const pastBars = bars.slice(idx - 20, idx)
    const vol = calcVolatility(pastBars)
    if (classifyPriceTier(entry) !== 'mid' || classifyVolTier(vol) !== 'mid') continue
    const forward = bars.filter(b => b.date > s.signal_date).slice(0, 60)
    if (forward.length < 20) continue
    midmidCases.push({ entry, forward })
  }

  const strategies = STRATEGIES.map(strat => {
    const results = midmidCases.map(c => strat.fn(c.entry, c.forward)).filter((r): r is ExitResult => r !== null)
    const returns = results.map(r => r.returnPct).sort((a, b) => a - b)
    const days = results.map(r => r.exitDay)
    const avg = returns.reduce((s, v) => s + v, 0) / (returns.length || 1)
    const med = returns[Math.floor(returns.length / 2)] ?? 0
    const wins = returns.filter(r => r >= 0).length
    const bigWins = returns.filter(r => r >= 25).length
    const losses = returns.filter(r => r <= -5).length
    return {
      key: strat.key,
      name: strat.name,
      n: results.length,
      avgReturn: Math.round(avg * 10) / 10,
      medianReturn: Math.round(med * 10) / 10,
      winRate: Math.round((wins / (returns.length || 1)) * 1000) / 10,
      bigWinRate: Math.round((bigWins / (returns.length || 1)) * 1000) / 10,
      lossRate: Math.round((losses / (returns.length || 1)) * 1000) / 10,
      avgHoldDays: Math.round((days.reduce((s, v) => s + v, 0) / (days.length || 1)) * 10) / 10,
    }
  }).sort((a, b) => b.avgReturn - a.avgReturn)

  return NextResponse.json({
    segment: '中位×中ボラ🔥（黄金セグメント）',
    totalCases: midmidCases.length,
    strategies,
    note: '+15%固定利確が本当に最強か検証。もっと持つ vs 早く確定 のトレードオフを実データで比較。',
  })
}
