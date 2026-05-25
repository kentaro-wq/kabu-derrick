/**
 * 出口戦略シミュレーション API
 *
 * 既存の発火シグナル(claude_fire=true) + OHLCVキャッシュを使い、
 * 複数の出口戦略を後付けでシミュレートして平均リターンを比較する。
 *
 * 目的: ユーザー仮説「上がり続ける銘柄を下がるまで持ち続けるのが最強」を実データで検証。
 *
 * AI不要・追加データ取得不要。既存データだけで答えが出る分析。
 */
import { NextResponse } from 'next/server'
import { adminSupabase } from '@/lib/supabase'
import type { OHLCVBar } from '@/lib/technicals'

export const maxDuration = 60

interface Bar { date: string; open: number; high: number; low: number; close: number; volume: number }

/** signal_date 以降の bars を返す */
function forwardBars(allBars: Bar[], signalDate: string, maxDays = 30): Bar[] {
  return allBars.filter(b => b.date > signalDate).slice(0, maxDays)
}

// ===== 出口戦略の定義 =====

interface ExitResult {
  exitDay: number      // 何日後に売却したか (1-indexed)
  exitPrice: number
  returnPct: number    // (exit - entry) / entry * 100
}

/** A: 固定N日保有 */
function fixedHold(entry: number, forward: Bar[], days: number): ExitResult | null {
  if (forward.length < days) return null
  const bar = forward[days - 1]
  return { exitDay: days, exitPrice: bar.close, returnPct: (bar.close - entry) / entry * 100 }
}

/** D/E: トレーリングストップ — 高値からX%下げたら売る */
function trailingStop(entry: number, forward: Bar[], dropPct: number): ExitResult | null {
  if (forward.length === 0) return null
  let peak = entry
  for (let i = 0; i < forward.length; i++) {
    const b = forward[i]
    if (b.high > peak) peak = b.high
    const stopLevel = peak * (1 - dropPct / 100)
    if (b.low <= stopLevel) {
      // ストップに掛かったとして stopLevel で売れたと仮定（保守的）
      return { exitDay: i + 1, exitPrice: stopLevel, returnPct: (stopLevel - entry) / entry * 100 }
    }
  }
  // 最後まで掛からなければ最終日の終値で売る
  const last = forward[forward.length - 1]
  return { exitDay: forward.length, exitPrice: last.close, returnPct: (last.close - entry) / entry * 100 }
}

/** F: 連続陰線検知 — 利益が出てから N 日連続陰線で売る (ユーザー仮説に最近い) */
function consecutiveDownExit(entry: number, forward: Bar[], requireConsecutive = 3, minGainBeforeSell = 5): ExitResult | null {
  if (forward.length === 0) return null
  let downStreak = 0
  let everGained = false
  for (let i = 0; i < forward.length; i++) {
    const b = forward[i]
    const gainPct = (b.close - entry) / entry * 100
    if (gainPct >= minGainBeforeSell) everGained = true

    // 陰線判定 (close < open)
    if (b.close < b.open) downStreak++
    else downStreak = 0

    if (everGained && downStreak >= requireConsecutive) {
      return { exitDay: i + 1, exitPrice: b.close, returnPct: (b.close - entry) / entry * 100 }
    }
  }
  // 検知無しなら最終日で売る
  const last = forward[forward.length - 1]
  return { exitDay: forward.length, exitPrice: last.close, returnPct: (last.close - entry) / entry * 100 }
}

/** G: 利確+10% / 損切り-5% (固定目標) */
function fixedTargetExit(entry: number, forward: Bar[], takeProfit = 10, stopLoss = -5): ExitResult | null {
  if (forward.length === 0) return null
  const tpLevel = entry * (1 + takeProfit / 100)
  const slLevel = entry * (1 + stopLoss / 100)
  for (let i = 0; i < forward.length; i++) {
    const b = forward[i]
    // 同日に両方ヒットなら保守的に損切り優先
    if (b.low <= slLevel) return { exitDay: i + 1, exitPrice: slLevel, returnPct: stopLoss }
    if (b.high >= tpLevel) return { exitDay: i + 1, exitPrice: tpLevel, returnPct: takeProfit }
  }
  const last = forward[forward.length - 1]
  return { exitDay: forward.length, exitPrice: last.close, returnPct: (last.close - entry) / entry * 100 }
}

/** H: MA5割れで売る (短期トレンドフォロー、ユーザー仮説の別実装) */
function maBreakdownExit(entry: number, forward: Bar[]): ExitResult | null {
  if (forward.length < 5) return null
  for (let i = 4; i < forward.length; i++) {
    const ma5 = forward.slice(i - 4, i + 1).reduce((s, b) => s + b.close, 0) / 5
    if (forward[i].close < ma5) {
      return { exitDay: i + 1, exitPrice: forward[i].close, returnPct: (forward[i].close - entry) / entry * 100 }
    }
  }
  const last = forward[forward.length - 1]
  return { exitDay: forward.length, exitPrice: last.close, returnPct: (last.close - entry) / entry * 100 }
}

// ===== 集計関数 =====

interface StrategyStats {
  name: string
  description: string
  n: number
  avgReturn: number
  medianReturn: number
  winRate: number       // returnPct >= 0 の割合
  big_win_rate: number  // returnPct >= 15 の割合
  big_loss_rate: number // returnPct <= -10 の割合
  avgHoldDays: number
  totalReturn: number   // 全シグナル合計（同額投資想定）
}

function aggregate(results: (ExitResult | null)[], name: string, desc: string): StrategyStats {
  const valid = results.filter((r): r is ExitResult => r !== null)
  const returns = valid.map(r => r.returnPct).sort((a, b) => a - b)
  const days = valid.map(r => r.exitDay)
  const avg = returns.reduce((s, v) => s + v, 0) / (returns.length || 1)
  const median = returns.length > 0 ? returns[Math.floor(returns.length / 2)] : 0
  const wins = returns.filter(r => r >= 0).length
  const bigWins = returns.filter(r => r >= 15).length
  const bigLosses = returns.filter(r => r <= -10).length
  const totalRet = returns.reduce((s, v) => s + v, 0)
  return {
    name, description: desc,
    n: valid.length,
    avgReturn: Math.round(avg * 10) / 10,
    medianReturn: Math.round(median * 10) / 10,
    winRate: Math.round((wins / (returns.length || 1)) * 1000) / 10,
    big_win_rate: Math.round((bigWins / (returns.length || 1)) * 1000) / 10,
    big_loss_rate: Math.round((bigLosses / (returns.length || 1)) * 1000) / 10,
    avgHoldDays: Math.round((days.reduce((s, v) => s + v, 0) / (days.length || 1)) * 10) / 10,
    totalReturn: Math.round(totalRet * 10) / 10,
  }
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
    return NextResponse.json({ message: 'fired signal が無いため検証不可', strategies: [] })
  }

  // 各 ticker の OHLCV キャッシュを一括取得
  const tickers = [...new Set(signals.map(s => s.ticker))]
  const { data: cacheRows } = await adminSupabase
    .from('jquants_ohlcv_cache')
    .select('ticker, bars')
    .in('ticker', tickers)

  const barsMap = new Map<string, OHLCVBar[]>()
  for (const r of cacheRows ?? []) {
    barsMap.set(r.ticker, r.bars as OHLCVBar[])
  }

  // 各 signal に対して、各戦略でシミュレート
  const resultsByStrategy: Record<string, (ExitResult | null)[]> = {
    'A_hold5':   [],
    'B_hold10':  [],
    'C_hold20':  [],
    'D_trail5':  [],
    'E_trail10': [],
    'F_downstreak': [],
    'G_target':  [],
    'H_ma5break': [],
  }

  let skipped = 0
  for (const s of signals) {
    const bars = barsMap.get(s.ticker)
    if (!bars) { skipped++; continue }
    const entry = Number(s.price_at_signal)
    if (!entry || entry <= 0) { skipped++; continue }
    const forward = forwardBars(bars, s.signal_date, 30)
    if (forward.length < 5) { skipped++; continue }

    resultsByStrategy.A_hold5.push(fixedHold(entry, forward, 5))
    resultsByStrategy.B_hold10.push(fixedHold(entry, forward, 10))
    resultsByStrategy.C_hold20.push(fixedHold(entry, forward, 20))
    resultsByStrategy.D_trail5.push(trailingStop(entry, forward, 5))
    resultsByStrategy.E_trail10.push(trailingStop(entry, forward, 10))
    resultsByStrategy.F_downstreak.push(consecutiveDownExit(entry, forward, 3, 5))
    resultsByStrategy.G_target.push(fixedTargetExit(entry, forward, 10, -5))
    resultsByStrategy.H_ma5break.push(maBreakdownExit(entry, forward))
  }

  const strategies = [
    aggregate(resultsByStrategy.A_hold5,      'A_hold5',      '固定5日保有'),
    aggregate(resultsByStrategy.B_hold10,     'B_hold10',     '固定10日保有'),
    aggregate(resultsByStrategy.C_hold20,     'C_hold20',     '固定20日保有'),
    aggregate(resultsByStrategy.D_trail5,     'D_trail5',     'トレーリングストップ -5%'),
    aggregate(resultsByStrategy.E_trail10,    'E_trail10',    'トレーリングストップ -10%'),
    aggregate(resultsByStrategy.F_downstreak, 'F_downstreak', '【ユーザー仮説】+5%利益後、3日連続陰線で売り'),
    aggregate(resultsByStrategy.G_target,     'G_target',     '固定: +10%利確 / -5%損切'),
    aggregate(resultsByStrategy.H_ma5break,   'H_ma5break',   'MA5割れで売り（短期トレンドフォロー）'),
  ]

  return NextResponse.json({
    totalSignals: signals.length,
    usableSignals: signals.length - skipped,
    skipped,
    strategies: strategies.sort((a, b) => b.avgReturn - a.avgReturn),
    note: 'fired signal を発注した想定で、複数の出口戦略を後付けシミュレート。totalReturn は全シグナルに同額投資した場合の通算リターン (%)。',
  })
}
