/**
 * 前夜PTS予兆の「答え合わせ」エンドポイント（2段構えの2段目=確報/撤回）
 * Vercel Cron: 平日 9:05 JST（00:05 UTC）に自動実行を想定（寄り直後）
 * 手動: POST /api/market/pts-confirm
 *
 * 前夜の pts-premarket が記録した本日分の予兆について、実際の寄り値で判定する:
 *   - 寄りも前日比 +7%以上 → confirmed（確報）: 「寄りで+X%。9:15までに動くなら今」
 *   - 寄りが失速（+7%未満）   → retracted（撤回）: 「PTSの予兆は寄りで剥落。慌てる局面でない」
 *
 * silent skip 禁止: 前夜に予兆を出した責任として、上がらなかった場合も必ず撤回通知する。
 * ユーザーは仕事中だが〜9:15は通勤電車で動けるため、寄り直後の確報が緊急の気づきになる。
 *
 * 寄り値の取得: Yahoo の 1d/range=2d 当日 bar の open。寄り直後は当日 bar が立つ。
 */
import { NextResponse } from 'next/server'
import { adminSupabase } from '@/lib/supabase'
import { sendLineMessage } from '@/lib/line'
import { fetchYahooBars } from '@/lib/stock-price'

export const maxDuration = 60

const GAP_THRESHOLD_PCT = 7

function todayJst(): string {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10)
}

interface SignalRow {
  id: string
  ticker: string
  name: string
  pts_change_pct: number
  prev_close: number
}

export async function POST() {
  const today = todayJst()
  const { data: rows } = await adminSupabase
    .from('pts_premarket_signals')
    .select('id, ticker, name, pts_change_pct, prev_close')
    .eq('signal_date', today)
    .is('resolution', null)

  if (!rows || rows.length === 0) {
    return NextResponse.json({ ok: true, resolved: 0, reason: '本日の未評価予兆なし' })
  }

  const confirmed: Array<{ name: string; ticker: string; pct: number; open: number }> = []
  const retracted: Array<{ name: string; ticker: string; ptsPct: number; openPct: number }> = []

  for (const r of rows as SignalRow[]) {
    try {
      const bars = await fetchYahooBars(r.ticker, '2d')
      const todayBar = bars[bars.length - 1]
      if (!todayBar || todayBar.open <= 0) continue  // 寄り未成立など。次回再評価
      const openPrice = todayBar.open
      const prevClose = Number(r.prev_close)
      const openPct = ((openPrice - prevClose) / prevClose) * 100
      const resolution = openPct >= GAP_THRESHOLD_PCT ? 'confirmed' : 'retracted'

      await adminSupabase.from('pts_premarket_signals').update({
        open_price: openPrice,
        open_change_pct: Math.round(openPct * 10) / 10,
        resolution,
        resolved_at: new Date().toISOString(),
      }).eq('id', r.id)

      if (resolution === 'confirmed') confirmed.push({ name: r.name, ticker: r.ticker, pct: openPct, open: openPrice })
      else retracted.push({ name: r.name, ticker: r.ticker, ptsPct: Number(r.pts_change_pct), openPct })
    } catch (e) {
      console.error(`[pts-confirm] ${r.ticker} 評価失敗(スキップ): ${e instanceof Error ? e.message : e}`)
    }
  }

  if (confirmed.length === 0 && retracted.length === 0) {
    return NextResponse.json({ ok: true, resolved: 0, reason: '寄り未成立・全スキップ' })
  }

  let msg = `🌅 寄りの答え合わせ（前夜PTS予兆）\n\n`
  if (confirmed.length > 0) {
    confirmed.sort((a, b) => b.pct - a.pct)
    msg += `✅ 確報：寄りで跳ねた。9:15までに動くなら今\n`
    for (const c of confirmed) {
      msg += `🟢 ${c.name}(${c.ticker}) 寄り${Math.round(c.open).toLocaleString()}円 前日比+${c.pct.toFixed(1)}%\n`
    }
    msg += `\n`
  }
  if (retracted.length > 0) {
    msg += `↩️ 撤回：PTSの予兆は寄りで剥落。慌てて売る局面ではない\n`
    for (const r of retracted) {
      msg += `・${r.name}(${r.ticker}) PTS+${r.ptsPct.toFixed(1)}% → 寄り${r.openPct >= 0 ? '+' : ''}${r.openPct.toFixed(1)}%\n`
    }
  }
  await sendLineMessage(msg).catch(() => {})

  return NextResponse.json({ ok: true, resolved: confirmed.length + retracted.length, confirmed, retracted })
}

export async function GET() { return POST() }
