/**
 * シグナル結果追跡（毎日の自動実行）
 *
 * 設計方針:
 * - 「N日前のシグナル」ではなく「未追跡のシグナル全部」を対象に経過日数で判断
 * - これにより祝日でcronがスキップされても追跡漏れしない
 * - 的中判定:
 *    5日後 +3%以上 = hit_5d
 *   10日後 +5%以上 = hit_10d
 *   20日後 +5%以上 = hit_20d
 * - UPSERT で重複行を防ぐ（signal_id に UNIQUE 制約あり）
 */
import { NextResponse } from 'next/server'
import { adminSupabase } from '@/lib/supabase'
import { fetchStockInfo } from '@/lib/kabutan'

export const maxDuration = 300

/** JST基準で経過日数（暦日）を計算 */
function daysElapsedJST(signalDate: string): number {
  const jstNow = new Date(Date.now() + 9 * 60 * 60 * 1000)
  const signalDay = new Date(signalDate + 'T00:00:00Z')
  return Math.floor((jstNow.getTime() - signalDay.getTime()) / (1000 * 60 * 60 * 24))
}

export async function POST() {
  // 過去30日以内のシグナルを全部取得（既にoutcomeがあるかは後で判定）
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)

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

  // 既存のoutcomeを一括取得（N+1クエリ回避）
  const signalIds = signals.map(s => s.id)
  const { data: existingOutcomes } = await adminSupabase
    .from('signal_outcomes')
    .select('id, signal_id, price_5d, pct_5d, hit_5d, price_10d, pct_10d, hit_10d, price_20d, pct_20d, hit_20d')
    .in('signal_id', signalIds)

  const outcomeMap = new Map(
    (existingOutcomes ?? []).map(o => [o.signal_id, o])
  )

  const updated: string[] = []

  for (const signal of signals) {
    const { id, ticker, price_at_signal, signal_date } = signal
    if (!price_at_signal) continue

    const elapsed = daysElapsedJST(signal_date)

    // 5日も経っていなければスキップ
    if (elapsed < 5) continue

    const existing = outcomeMap.get(id)

    // 既存outcomeで20日分埋まっていればスキップ
    if (existing?.pct_5d != null && existing?.pct_10d != null && existing?.pct_20d != null) {
      continue
    }

    // 経過日数に対して既に埋まっているのは更新しない
    const need5 = elapsed >= 5 && existing?.pct_5d == null
    const need10 = elapsed >= 10 && existing?.pct_10d == null
    const need20 = elapsed >= 20 && existing?.pct_20d == null

    if (!need5 && !need10 && !need20) continue

    // 現在価格を取得
    const info = await fetchStockInfo(ticker)
    if (!info?.price) {
      console.error(`[signals/track] ${ticker} 株価取得失敗`)
      continue
    }

    const currentPrice = info.price
    const pct = Math.round(((currentPrice - Number(price_at_signal)) / Number(price_at_signal)) * 1000) / 10

    // UPSERT で重複防止
    const upsertRow: Record<string, unknown> = {
      signal_id: id,
      ticker,
      signal_date,
      updated_at: new Date().toISOString(),
    }

    // 既存値があれば維持、新規/未埋めの場合のみ更新
    if (need5)  { upsertRow.price_5d = currentPrice;  upsertRow.pct_5d = pct;  upsertRow.hit_5d = pct >= 3.0 }
    if (need10) { upsertRow.price_10d = currentPrice; upsertRow.pct_10d = pct; upsertRow.hit_10d = pct >= 5.0 }
    if (need20) { upsertRow.price_20d = currentPrice; upsertRow.pct_20d = pct; upsertRow.hit_20d = pct >= 5.0 }

    // 既存値を維持するため、existing から既に埋まっている値を全カラム分コピー
    // （UPSERTは未指定カラムを NULL で上書きするため）
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
    if (need5) segments.push(`5d:${pct >= 0 ? '+' : ''}${pct}%`)
    if (need10) segments.push(`10d:${pct >= 0 ? '+' : ''}${pct}%`)
    if (need20) segments.push(`20d:${pct >= 0 ? '+' : ''}${pct}%`)
    updated.push(`${ticker} (${segments.join(', ')})`)

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
