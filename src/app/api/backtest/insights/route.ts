/**
 * バックテスト分析API — 条件別の打率を集計
 *
 * 蓄積データから「どの指標条件が打率に効くか」を可視化
 * Phase 3 軽量版: 個別条件のヒストグラム集計
 */
import { NextResponse } from 'next/server'
import { adminSupabase } from '@/lib/supabase'

interface BSig {
  volume_ratio: number | null
  rsi14: number | null
  golden_cross: boolean | null
  above_ma25: boolean | null
  above_ma75: boolean | null
  claude_score: number | null
  pct_10d: number | null
  hit_10d: boolean | null
}

interface ConditionStat {
  label: string
  count: number
  hits: number
  hitRate: number
  avgReturn: number
}

function buildStat(label: string, rows: BSig[]): ConditionStat {
  const tracked = rows.filter(r => r.hit_10d !== null && r.pct_10d !== null)
  const hits = tracked.filter(r => r.hit_10d === true).length
  const sumPct = tracked.reduce((s, r) => s + (r.pct_10d ?? 0), 0)
  return {
    label,
    count: tracked.length,
    hits,
    hitRate: tracked.length > 0 ? Math.round((hits / tracked.length) * 1000) / 10 : 0,
    avgReturn: tracked.length > 0 ? Math.round((sumPct / tracked.length) * 10) / 10 : 0,
  }
}

export async function GET() {
  // 発火シグナルかつ10日後結果ありを対象
  const { data } = await adminSupabase
    .from('backtest_signals')
    .select('volume_ratio, rsi14, golden_cross, above_ma25, above_ma75, claude_score, pct_10d, hit_10d')
    .eq('claude_fire', true)
    .not('pct_10d', 'is', null)
    .limit(5000)

  const rows = (data ?? []) as BSig[]

  if (rows.length === 0) {
    return NextResponse.json({
      totalFired: 0,
      message: 'まだ十分なデータがありません。スプリント実行後に再度確認してください。',
      conditions: [],
    })
  }

  // 単一条件の集計
  const stats: ConditionStat[] = []

  // 出来高比率レンジ
  stats.push(buildStat('出来高 < 2倍', rows.filter(r => r.volume_ratio != null && r.volume_ratio < 2)))
  stats.push(buildStat('出来高 2〜3倍', rows.filter(r => r.volume_ratio != null && r.volume_ratio >= 2 && r.volume_ratio < 3)))
  stats.push(buildStat('出来高 3〜5倍', rows.filter(r => r.volume_ratio != null && r.volume_ratio >= 3 && r.volume_ratio < 5)))
  stats.push(buildStat('出来高 5倍以上', rows.filter(r => r.volume_ratio != null && r.volume_ratio >= 5)))

  // RSIレンジ
  stats.push(buildStat('RSI < 40', rows.filter(r => r.rsi14 != null && r.rsi14 < 40)))
  stats.push(buildStat('RSI 40〜55', rows.filter(r => r.rsi14 != null && r.rsi14 >= 40 && r.rsi14 < 55)))
  stats.push(buildStat('RSI 55〜65', rows.filter(r => r.rsi14 != null && r.rsi14 >= 55 && r.rsi14 < 65)))
  stats.push(buildStat('RSI 65以上', rows.filter(r => r.rsi14 != null && r.rsi14 >= 65)))

  // テクニカル単一条件
  stats.push(buildStat('ゴールデンクロス あり', rows.filter(r => r.golden_cross === true)))
  stats.push(buildStat('ゴールデンクロス なし', rows.filter(r => r.golden_cross === false)))
  stats.push(buildStat('MA25上抜け あり', rows.filter(r => r.above_ma25 === true)))
  stats.push(buildStat('MA75上抜け あり', rows.filter(r => r.above_ma75 === true)))

  // Claudeスコア別
  stats.push(buildStat('Claude スコア 4', rows.filter(r => r.claude_score === 4)))
  stats.push(buildStat('Claude スコア 5', rows.filter(r => r.claude_score === 5)))

  // 組み合わせ条件（強いシグナル候補）
  stats.push(buildStat(
    '【複合】出来高3倍↑ + GC',
    rows.filter(r => r.volume_ratio != null && r.volume_ratio >= 3 && r.golden_cross === true)
  ))
  stats.push(buildStat(
    '【複合】MA25↑ + MA75↑ + RSI40-65',
    rows.filter(r => r.above_ma25 === true && r.above_ma75 === true && r.rsi14 != null && r.rsi14 >= 40 && r.rsi14 < 65)
  ))
  stats.push(buildStat(
    '【複合】スコア5 + 出来高3倍↑',
    rows.filter(r => r.claude_score === 5 && r.volume_ratio != null && r.volume_ratio >= 3)
  ))

  // 「全体平均」より高い打率の条件だけハイライト
  const overallHitRate = buildStat('全体', rows).hitRate

  return NextResponse.json({
    totalFired: rows.length,
    overallHitRate,
    conditions: stats.filter(s => s.count >= 5), // サンプル5未満は除外（ノイズ排除）
  })
}
