/**
 * バックテスト自動実行 cron
 *
 * 設計:
 * - 毎日1回実行（深夜帯）
 * - 時代を3つローテーション（直近3ヶ月 → 3-6ヶ月前 → 6-12ヶ月前）
 *   日付の mod 3 で決まる → 3日かけて全時代を1周
 * - 小サイズ（5日 × 5候補 = 25評価）で「無理なく」走る
 * - bot_rules.backtest_auto_enabled = 'false' なら起動しない
 *
 * 停止: スキャナー/バックテスト画面のトグルから即停止可能
 * 1ヶ月後の蓄積: 25評価/日 × 30日 × 3時代 = 各時代250評価ずつ
 */
import { NextResponse } from 'next/server'
import { adminSupabase } from '@/lib/supabase'
import { PERIOD_PRESETS, periodToDateRange } from '@/lib/backtest'

export const maxDuration = 60

export async function GET() {
  return POST()
}

export async function POST() {
  // 停止フラグチェック
  const { data: rule } = await adminSupabase
    .from('bot_rules')
    .select('rule_value')
    .eq('rule_key', 'backtest_auto_enabled')
    .single()

  const enabled = rule?.rule_value !== 'false'
  if (!enabled) {
    return NextResponse.json({ skipped: true, reason: 'auto disabled' })
  }

  // 時代ローテーション: 日付(day of year)の mod で決定
  const dayOfYear = Math.floor(
    (Date.now() - new Date(new Date().getFullYear(), 0, 0).getTime()) / (24 * 60 * 60 * 1000)
  )
  const presetIdx = dayOfYear % PERIOD_PRESETS.length
  const preset = PERIOD_PRESETS[presetIdx]
  const range = periodToDateRange(preset)

  // 自身の /api/backtest/run を呼び出し（無理ない小サイズ）
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://kabu-derrick.vercel.app'
  const runRes = await fetch(`${baseUrl}/api/backtest/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: `[Auto] ${range.label}`,
      sampleSize: 5,             // 1日5サンプル → 軽量
      maxCandidatesPerDay: 5,    // 25評価で約$0.03
      periodLabel: range.label,
      dateFrom: range.from,
      dateTo: range.to,
      trigger: 'cron',
    }),
  })

  const data = await runRes.json()
  return NextResponse.json({
    ok: runRes.ok,
    period: range.label,
    dateRange: { from: range.from, to: range.to },
    runResult: data,
  })
}
