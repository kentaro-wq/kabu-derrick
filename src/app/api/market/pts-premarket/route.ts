/**
 * 前夜PTSギャップアップ予兆の検知・通知エンドポイント
 * Vercel Cron: 平日夜 22:00 JST（13:00 UTC）に自動実行を想定
 * 手動: POST /api/market/pts-premarket
 *
 * 目的（2段構えの1段目=予兆）:
 *   日本株は Yahoo に寄り前気配が無い（hasPrePostMarketData: false）。
 *   翌朝の寄りギャップを「前夜のうちに」掴むため、kabutan の PTS（夜間取引）価格を使う。
 *   即売却可能な保有（nisa_growth/tokutei）+ active売り注文の銘柄で、
 *   PTS が前日終値比 +7%以上 = 翌朝の寄りで跳ねる可能性 → 予兆を記録し LINE 通知。
 *
 * 緊急ではない（前夜なので考える時間がある）。「明日寄りで跳ねるかも。今夜のうちに
 * 売り方針を AI相談で固めては」という"準備"の通知。翌朝 9:05 の pts-confirm が
 * 実際の寄り値で答え合わせ（確報 or 撤回）する。silent skip 禁止のため、予兆を
 * 出した銘柄は翌朝必ず確報/撤回まで通知する。
 */
import { NextResponse } from 'next/server'
import { adminSupabase } from '@/lib/supabase'
import { sendLineMessage } from '@/lib/line'
import { fetchPtsQuote } from '@/lib/stock-price'

export const maxDuration = 60

const GAP_THRESHOLD_PCT = 7  // PTS 前日終値比 +7%以上を予兆とする

// 翌営業日（土日をまたぐ場合を考慮）。月〜木→翌日、金→月曜。
function nextBusinessDateJst(): string {
  const jst = new Date(Date.now() + 9 * 3600 * 1000)
  const day = jst.getUTCDay() // JST基準の曜日（getUTCで9h加算済みのため）
  let add = 1
  if (day === 5) add = 3       // 金 → 月
  else if (day === 6) add = 2  // 土 → 月
  else if (day === 0) add = 1  // 日 → 月
  const next = new Date(jst.getTime() + add * 24 * 3600 * 1000)
  return next.toISOString().slice(0, 10)
}

export async function POST() {
  const [holdingsRes, ordersRes] = await Promise.all([
    adminSupabase.from('holdings').select('ticker, name, account_type'),
    adminSupabase.from('orders').select('ticker, name, order_type, status').eq('status', 'active'),
  ])
  const holdings = (holdingsRes.data ?? []).filter(
    h => /^\d{4}$/.test(h.ticker ?? '') && ['nisa_growth', 'tokutei'].includes(h.account_type)
  )
  const sellOrders = (ordersRes.data ?? []).filter(
    o => /^\d{4}$/.test(o.ticker ?? '') && o.order_type === 'sell'
  )

  const targets = new Map<string, string>()  // ticker -> name
  for (const h of holdings) targets.set(h.ticker!, h.name)
  for (const o of sellOrders) if (!targets.has(o.ticker!)) targets.set(o.ticker!, o.name)
  if (targets.size === 0) return NextResponse.json({ ok: true, signals: 0, reason: '対象銘柄なし' })

  const signalDate = nextBusinessDateJst()
  const detected: Array<{ ticker: string; name: string; pct: number; pts: number; time: string }> = []

  for (const [ticker, name] of targets) {
    try {
      const q = await fetchPtsQuote(ticker)
      if (!q || q.changePct < GAP_THRESHOLD_PCT) continue
      // 記録（同一銘柄・同日は upsert で1件に）
      const { error } = await adminSupabase.from('pts_premarket_signals').upsert({
        ticker, name,
        signal_date: signalDate,
        pts_price: q.ptsPrice,
        prev_close: q.prevClose,
        pts_change_pct: Math.round(q.changePct * 10) / 10,
        pts_time: q.ptsTime,
      }, { onConflict: 'ticker,signal_date' })
      if (error) { console.error(`[pts-premarket] ${ticker} 記録失敗: ${error.message}`); continue }
      detected.push({ ticker, name, pct: q.changePct, pts: q.ptsPrice, time: q.ptsTime })
    } catch (e) {
      console.error(`[pts-premarket] ${ticker} 取得失敗(スキップ): ${e instanceof Error ? e.message : e}`)
    }
  }

  if (detected.length === 0) return NextResponse.json({ ok: true, signals: 0 })

  detected.sort((a, b) => b.pct - a.pct)
  let msg = `🌙 前夜の出口予兆（PTS夜間取引）\n\n`
  msg += `明日(${signalDate})の寄りで跳ねる可能性。今夜のうちに売り方針を固めておけます（AI相談推奨）。\n\n`
  for (const d of detected) {
    msg += `🟢 ${d.name}(${d.ticker}) PTS ${Math.round(d.pts).toLocaleString()}円 前日比+${d.pct.toFixed(1)}%（${d.time}）\n`
  }
  msg += `\n※ これは予兆。明日の寄りで実際に上がるかは別途「確報/撤回」を朝に通知します。`
  await sendLineMessage(msg).catch(() => {})

  return NextResponse.json({ ok: true, signals: detected.length, signalDate, detected })
}

export async function GET() { return POST() }
