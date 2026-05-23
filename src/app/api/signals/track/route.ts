/**
 * シグナル結果追跡（毎日の自動実行）
 *
 * 設計方針:
 * - J-Quants からシグナル銘柄の OHLCV 履歴を取得し、
 *   シグナル日から5/10/20営業日後の「実際の終値」を記録する
 *   （kabutanの現在価格を使うとN日経過とずれて精度が壊れる）
 * - 「N日前のシグナル」ではなく「未追跡のシグナル全部」を対象に経過日数で判断
 *   これにより祝日でcronがスキップされても追跡漏れしない
 * - 的中判定:
 *    5日後 +3%以上 = hit_5d
 *   10日後 +5%以上 = hit_10d
 *   20日後 +5%以上 = hit_20d
 * - UPSERT で重複行を防ぐ（signal_id に UNIQUE 制約あり）
 */
import { NextResponse } from 'next/server'
import { adminSupabase } from '@/lib/supabase'
import { fetchOHLCVHistory, getIdToken } from '@/lib/jquants'
import type { OHLCVBar } from '@/lib/technicals'

export const maxDuration = 300

/** signal_date以降のN営業日後（インデックスN-1）の終値を返す。データ不足ならnull */
function priceNDaysAfter(bars: OHLCVBar[], signalDate: string, n: number): number | null {
  const afterSignal = bars.filter(b => b.date > signalDate)
  if (afterSignal.length < n) return null
  return afterSignal[n - 1].close
}

export async function POST() {
  // 過去40日以内のシグナルを対象（最大で20営業日後まで追跡するため余裕を持たせる）
  const cutoff = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)

  const { data: signals, error: sigErr } = await adminSupabase
    .from('prediction_signals')
    .select('id, ticker, name, price_at_signal, signal_date')
    .gte('signal_date', cutoff)
    .order('signal_date', { ascending: false })

  if (sigErr) {
    return NextResponse.json({ error: sigErr.message }, { status: 500 })
  }

  if (!signals || signals.length === 0) {
    return NextResponse.json({ ok: true, updatedCount: 0, details: [] })
  }

  // 既存outcomeを一括取得
  const signalIds = signals.map(s => s.id)
  const { data: existingOutcomes } = await adminSupabase
    .from('signal_outcomes')
    .select('id, signal_id, price_5d, pct_5d, hit_5d, price_10d, pct_10d, hit_10d, price_20d, pct_20d, hit_20d')
    .in('signal_id', signalIds)

  const outcomeMap = new Map((existingOutcomes ?? []).map(o => [o.signal_id, o]))

  // まだ全部埋まっていないシグナルだけを処理対象に絞る
  const pending = signals.filter(s => {
    const ex = outcomeMap.get(s.id)
    return !(ex?.pct_5d != null && ex?.pct_10d != null && ex?.pct_20d != null)
  })

  if (pending.length === 0) {
    return NextResponse.json({ ok: true, updatedCount: 0, details: [] })
  }

  // J-Quants トークンを1回だけ取得
  const idToken = await getIdToken()
  if (!idToken) {
    return NextResponse.json({ error: 'J-Quants認証失敗' }, { status: 503 })
  }

  // 銘柄ごとに OHLCV を1回ずつ取得（重複ticker回避）
  const uniqueTickers = [...new Set(pending.map(s => s.ticker))]
  const barsMap = new Map<string, OHLCVBar[]>()

  // 5並列で取得（J-Quantsへの過剰アクセス回避）
  const BATCH = 5
  for (let i = 0; i < uniqueTickers.length; i += BATCH) {
    const batch = uniqueTickers.slice(i, i + BATCH)
    const results = await Promise.all(
      batch.map(t => fetchOHLCVHistory(t, 60, idToken).then(b => [t, b] as const))
    )
    for (const [t, b] of results) barsMap.set(t, b)
  }

  const updated: string[] = []

  for (const signal of pending) {
    const { id, ticker, price_at_signal, signal_date } = signal
    if (!price_at_signal) continue

    const bars = barsMap.get(ticker)
    if (!bars || bars.length === 0) {
      console.error(`[signals/track] ${ticker} OHLCV取得失敗`)
      continue
    }

    const existing = outcomeMap.get(id)
    const pAtSignal = Number(price_at_signal)
    if (!pAtSignal || pAtSignal <= 0) {
      console.error(`[signals/track] ${ticker} 不正な price_at_signal: ${price_at_signal}`)
      continue
    }

    // J-Quants から N営業日後の終値を取得
    const p5  = priceNDaysAfter(bars, signal_date, 5)
    const p10 = priceNDaysAfter(bars, signal_date, 10)
    const p20 = priceNDaysAfter(bars, signal_date, 20)

    // 既存で埋まっていない & データが取得できた分だけ更新
    const need5  = existing?.pct_5d  == null && p5  != null
    const need10 = existing?.pct_10d == null && p10 != null
    const need20 = existing?.pct_20d == null && p20 != null

    if (!need5 && !need10 && !need20) continue

    const calcPct = (p: number) => Math.round(((p - pAtSignal) / pAtSignal) * 1000) / 10

    const upsertRow: Record<string, unknown> = {
      signal_id: id,
      ticker,
      signal_date,
      updated_at: new Date().toISOString(),
    }

    // 新規N日後を書き込み
    if (need5)  { upsertRow.price_5d  = p5;  upsertRow.pct_5d  = calcPct(p5!);  upsertRow.hit_5d  = calcPct(p5!)  >= 3.0 }
    if (need10) { upsertRow.price_10d = p10; upsertRow.pct_10d = calcPct(p10!); upsertRow.hit_10d = calcPct(p10!) >= 5.0 }
    if (need20) { upsertRow.price_20d = p20; upsertRow.pct_20d = calcPct(p20!); upsertRow.hit_20d = calcPct(p20!) >= 5.0 }

    // 既存値を維持（UPSERTは未指定カラムをNULL上書きするため）
    if (existing?.pct_5d != null && !need5) {
      upsertRow.price_5d = existing.price_5d
      upsertRow.pct_5d = existing.pct_5d
      upsertRow.hit_5d = existing.hit_5d
    }
    if (existing?.pct_10d != null && !need10) {
      upsertRow.price_10d = existing.price_10d
      upsertRow.pct_10d = existing.pct_10d
      upsertRow.hit_10d = existing.hit_10d
    }
    if (existing?.pct_20d != null && !need20) {
      upsertRow.price_20d = existing.price_20d
      upsertRow.pct_20d = existing.pct_20d
      upsertRow.hit_20d = existing.hit_20d
    }

    const { error: upErr } = await adminSupabase
      .from('signal_outcomes')
      .upsert(upsertRow, { onConflict: 'signal_id' })

    if (upErr) {
      console.error(`[signals/track] upsert error for ${ticker}:`, upErr.message)
      continue
    }

    const segments: string[] = []
    if (need5)  segments.push(`5d:${calcPct(p5!)  >= 0 ? '+' : ''}${calcPct(p5!)}%`)
    if (need10) segments.push(`10d:${calcPct(p10!) >= 0 ? '+' : ''}${calcPct(p10!)}%`)
    if (need20) segments.push(`20d:${calcPct(p20!) >= 0 ? '+' : ''}${calcPct(p20!)}%`)
    updated.push(`${ticker} (${segments.join(', ')})`)
  }

  return NextResponse.json({
    ok: true,
    updatedCount: updated.length,
    totalPending: pending.length,
    details: updated,
    timestamp: new Date().toISOString(),
  })
}

export async function GET() {
  return POST()
}
