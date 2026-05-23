/**
 * シグナル結果追跡（毎日の自動実行）
 *
 * prediction_signals に対し、5日後・10日後・20日後の
 * 実際の株価を取得して signal_outcomes を更新する。
 * 的中判定: 10日後に+5%以上 = hit_10d: true
 */
import { NextResponse } from 'next/server'
import { adminSupabase } from '@/lib/supabase'
import { fetchStockInfo } from '@/lib/kabutan'

export const maxDuration = 120

/** 営業日ベースでN日前の日付を返す（簡易版：土日のみ考慮、祝日除く） */
function businessDaysAgo(days: number): string {
  const d = new Date()
  let counted = 0
  while (counted < days) {
    d.setDate(d.getDate() - 1)
    const dow = d.getDay()
    if (dow !== 0 && dow !== 6) counted++
  }
  return d.toISOString().slice(0, 10)
}

export async function POST() {
  const updated: string[] = []

  // 5日前・10日前・20日前の日付を計算
  const date5ago = businessDaysAgo(5)
  const date10ago = businessDaysAgo(10)
  const date20ago = businessDaysAgo(20)

  // 5日前のシグナルで pct_5d がまだ null のものを取得
  const { data: pending5 } = await adminSupabase
    .from('prediction_signals')
    .select('id, ticker, name, price_at_signal, signal_date')
    .eq('signal_date', date5ago)
    .not('id', 'in',
      `(SELECT signal_id FROM signal_outcomes WHERE pct_5d IS NOT NULL)`
    )

  // 10日前のシグナル
  const { data: pending10 } = await adminSupabase
    .from('prediction_signals')
    .select('id, ticker, name, price_at_signal, signal_date')
    .eq('signal_date', date10ago)

  // 20日前のシグナル
  const { data: pending20 } = await adminSupabase
    .from('prediction_signals')
    .select('id, ticker, name, price_at_signal, signal_date')
    .eq('signal_date', date20ago)

  const allPending = [...(pending5 ?? []), ...(pending10 ?? []), ...(pending20 ?? [])]
    .filter((s, i, arr) => arr.findIndex(x => x.id === s.id) === i)

  for (const signal of allPending) {
    const { id, ticker, price_at_signal, signal_date } = signal
    if (!price_at_signal) continue

    const info = await fetchStockInfo(ticker)
    if (!info?.price) continue

    const currentPrice = info.price
    const daysElapsed = Math.round(
      (Date.now() - new Date(signal_date).getTime()) / (1000 * 60 * 60 * 24)
    )

    // 既存の outcome を確認
    const { data: existingOutcome } = await adminSupabase
      .from('signal_outcomes')
      .select('id, pct_5d, pct_10d, pct_20d')
      .eq('signal_id', id)
      .single()

    const pct = Math.round(((currentPrice - price_at_signal) / price_at_signal) * 1000) / 10
    const hit = pct >= 5.0  // +5%以上で的中

    if (existingOutcome) {
      // 更新
      const updates: Record<string, unknown> = { updated_at: new Date().toISOString() }
      if (daysElapsed >= 5 && existingOutcome.pct_5d == null) {
        updates.price_5d = currentPrice; updates.pct_5d = pct; updates.hit_5d = pct >= 3.0
      }
      if (daysElapsed >= 10 && existingOutcome.pct_10d == null) {
        updates.price_10d = currentPrice; updates.pct_10d = pct; updates.hit_10d = hit
      }
      if (daysElapsed >= 20 && existingOutcome.pct_20d == null) {
        updates.price_20d = currentPrice; updates.pct_20d = pct; updates.hit_20d = hit
      }
      if (Object.keys(updates).length > 1) {
        await adminSupabase.from('signal_outcomes').update(updates).eq('id', existingOutcome.id)
        updated.push(`${ticker} (${daysElapsed}日後: ${pct >= 0 ? '+' : ''}${pct}%)`)
      }
    } else {
      // 新規作成
      const row: Record<string, unknown> = {
        signal_id: id,
        ticker,
        signal_date,
      }
      if (daysElapsed >= 5)  { row.price_5d = currentPrice;  row.pct_5d = pct;  row.hit_5d = pct >= 3.0 }
      if (daysElapsed >= 10) { row.price_10d = currentPrice; row.pct_10d = pct; row.hit_10d = hit }
      if (daysElapsed >= 20) { row.price_20d = currentPrice; row.pct_20d = pct; row.hit_20d = hit }

      await adminSupabase.from('signal_outcomes').insert(row)
      updated.push(`${ticker} 新規記録 (${daysElapsed}日後: ${pct >= 0 ? '+' : ''}${pct}%)`)
    }

    await new Promise(r => setTimeout(r, 300))
  }

  return NextResponse.json({
    ok: true,
    updatedCount: updated.length,
    details: updated,
    timestamp: new Date().toISOString(),
  })
}

export async function GET() {
  return POST()
}
