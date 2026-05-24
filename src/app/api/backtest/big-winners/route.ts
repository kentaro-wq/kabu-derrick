/**
 * 爆上がり分析 API
 *
 * +10% 以上の急騰銘柄を抽出して、Claudeが捕捉できたか/見逃したかを可視化。
 * AIによるAI固有の判断能力を磨くためのデータ基盤。
 *
 * 目的:
 *  - 普通の上昇 (+5%) ではなく、爆上がり (+10〜30%) を狙うエンジンへ
 *  - 爆上がり群の共通因子を発見してプロンプトに反映
 *  - 「凡庸な上昇候補」を切り捨てて精度を上げる
 */
import { NextResponse } from 'next/server'
import { adminSupabase } from '@/lib/supabase'

interface BigWinner {
  id: string
  ticker: string
  name: string | null
  signal_date: string
  claude_score: number | null
  claude_fire: boolean | null
  conditions_met: string[] | null
  reasoning: string | null
  volume_ratio: number | null
  rsi14: number | null
  golden_cross: boolean | null
  above_ma25: boolean | null
  above_ma75: boolean | null
  ma5: number | null
  ma25: number | null
  ma75: number | null
  price_at_signal: number | null
  pct_5d: number | null
  pct_10d: number | null
  pct_20d: number | null
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const threshold = parseFloat(searchParams.get('threshold') ?? '10')  // %
  const horizon = (searchParams.get('horizon') ?? '20d') as '5d' | '10d' | '20d'

  // 該当する pct カラムを動的指定
  const pctCol = horizon === '5d' ? 'pct_5d' : horizon === '10d' ? 'pct_10d' : 'pct_20d'

  const { data, error } = await adminSupabase
    .from('backtest_signals')
    .select('id, ticker, name, signal_date, claude_score, claude_fire, conditions_met, reasoning, volume_ratio, rsi14, golden_cross, above_ma25, above_ma75, ma5, ma25, ma75, price_at_signal, pct_5d, pct_10d, pct_20d')
    .gte(pctCol, threshold)
    .not(pctCol, 'is', null)
    .order(pctCol, { ascending: false })
    .limit(500)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const winners = (data ?? []) as BigWinner[]
  const caught = winners.filter(w => w.claude_fire === true)
  const missed = winners.filter(w => w.claude_fire === false)

  // 共通因子分析: 捕捉群 vs 見逃し群 で各条件の保有率を比較
  const factorAnalysis = (key: keyof BigWinner) => {
    const caughtTrue = caught.filter(w => w[key] === true).length
    const missedTrue = missed.filter(w => w[key] === true).length
    return {
      caughtRate: caught.length > 0 ? Math.round((caughtTrue / caught.length) * 1000) / 10 : null,
      missedRate: missed.length > 0 ? Math.round((missedTrue / missed.length) * 1000) / 10 : null,
    }
  }

  // 数値条件の平均値比較
  const numericAvg = (key: keyof BigWinner, group: BigWinner[]) => {
    const vals = group.map(w => w[key]).filter(v => typeof v === 'number') as number[]
    if (vals.length === 0) return null
    return Math.round((vals.reduce((s, v) => s + v, 0) / vals.length) * 10) / 10
  }

  // 全体ベースライン: 全 backtest_signals でこれらの条件保有率
  const { data: baseData } = await adminSupabase
    .from('backtest_signals')
    .select('volume_ratio, rsi14, golden_cross, above_ma25, above_ma75')
    .not('pct_20d', 'is', null)
    .limit(10000)
  const baseAll = (baseData ?? []) as Partial<BigWinner>[]
  const baseRate = (key: keyof BigWinner) =>
    baseAll.length > 0
      ? Math.round((baseAll.filter(w => w[key] === true).length / baseAll.length) * 1000) / 10
      : null

  return NextResponse.json({
    threshold,
    horizon,
    totalWinners: winners.length,
    caught: caught.length,
    missed: missed.length,
    captureRate: winners.length > 0 ? Math.round((caught.length / winners.length) * 1000) / 10 : null,

    // 共通因子分析
    factors: {
      golden_cross: { ...factorAnalysis('golden_cross'), baseline: baseRate('golden_cross') },
      above_ma25:   { ...factorAnalysis('above_ma25'),   baseline: baseRate('above_ma25') },
      above_ma75:   { ...factorAnalysis('above_ma75'),   baseline: baseRate('above_ma75') },
    },

    // 数値指標の平均
    numericFactors: {
      volume_ratio: {
        caught: numericAvg('volume_ratio', caught),
        missed: numericAvg('volume_ratio', missed),
      },
      rsi14: {
        caught: numericAvg('rsi14', caught),
        missed: numericAvg('rsi14', missed),
      },
      [`avg_${horizon}_pct`]: {
        caught: numericAvg(pctCol as keyof BigWinner, caught),
        missed: numericAvg(pctCol as keyof BigWinner, missed),
      },
    },

    // 上位の爆上がり詳細（最大30件）
    winners: winners.slice(0, 30).map(w => ({
      ticker: w.ticker,
      name: w.name,
      date: w.signal_date,
      claudeFire: w.claude_fire,
      claudeScore: w.claude_score,
      pct5d: w.pct_5d,
      pct10d: w.pct_10d,
      pct20d: w.pct_20d,
      volumeRatio: w.volume_ratio,
      rsi14: w.rsi14,
      goldenCross: w.golden_cross,
      aboveMa25: w.above_ma25,
      aboveMa75: w.above_ma75,
      reasoning: w.reasoning,
      conditionsMet: w.conditions_met,
    })),
  })
}
