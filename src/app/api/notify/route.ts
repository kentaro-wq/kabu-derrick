/**
 * LINE通知エンドポイント
 * 朝8:30 JST (23:30 UTC): 今日・明日が期限の注文のみ → ?type=morning
 * 夕15:45 JST (06:45 UTC): 損益・NISA・期限2〜3日アラート → ?type=evening
 * Vercel Cron から GET、手動は POST (Authorization: Bearer APP_SECRET)
 */
import { NextResponse } from 'next/server'
import { adminSupabase } from '@/lib/supabase'
import { sendLineMessage } from '@/lib/line'
import { getNisaStatus } from '@/lib/nisa'
import { fetchDividendInfo } from '@/lib/stock-price'
import { fetchEarningsInfo } from '@/lib/kabutan'

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土']

function jstNow(): Date {
  return new Date(Date.now() + 9 * 60 * 60 * 1000)
}

function jstDateLabel(jst: Date): string {
  return `${jst.getUTCMonth() + 1}月${jst.getUTCDate()}日（${WEEKDAYS[jst.getUTCDay()]}）`
}

function daysUntil(dateStr: string): number {
  const jst = jstNow()
  jst.setUTCHours(0, 0, 0, 0)
  const target = new Date(dateStr)
  target.setUTCHours(0, 0, 0, 0)
  return Math.round((target.getTime() - jst.getTime()) / (1000 * 60 * 60 * 24))
}

// ── 配当カレンダー: 権利確定日が30日以内の銘柄を抽出 ─────────────────
// Yahoo の dividend events は「過去の権利確定日」を返すため、
// 日本株の半期周期（3月/9月決算が多い）を使って次回権利日を推定。
async function dividendCalendar(): Promise<{
  reminders: string[]; annualForecastYen: number
}> {
  const { data: holdings } = await adminSupabase.from('holdings').select('ticker, name, quantity')
  if (!holdings) return { reminders: [], annualForecastYen: 0 }
  const targets = holdings.filter(h => /^\d{4}$/.test(h.ticker ?? ''))

  const dividendInfos = await Promise.all(
    targets.map(async h => ({ h, info: await fetchDividendInfo(h.ticker) }))
  )

  const reminders: string[] = []
  let annualForecastYen = 0
  const today = jstNow()
  today.setUTCHours(0, 0, 0, 0)

  for (const { h, info } of dividendInfos) {
    if (!info || info.annualDividend <= 0) continue
    const qty = Number(h.quantity ?? 0)
    if (qty > 0) annualForecastYen += info.annualDividend * qty

    // 次回権利日推定 (直近 + 6ヶ月)。過ぎていれば 12ヶ月後で再評価
    const lastEx = new Date(info.lastExDate)
    lastEx.setUTCHours(0, 0, 0, 0)
    const nextEx = new Date(lastEx)
    nextEx.setUTCMonth(nextEx.getUTCMonth() + 6)
    if (nextEx.getTime() < today.getTime()) {
      nextEx.setUTCMonth(nextEx.getUTCMonth() + 6) // 1年後
    }
    const daysToNext = Math.round((nextEx.getTime() - today.getTime()) / 86400000)

    if (daysToNext >= 0 && daysToNext <= 30) {
      const expected = info.annualDividend * 0.5 * qty // 半期想定
      reminders.push(
        `📅 ${h.name}(${h.ticker}) 権利確定日推定: ${nextEx.toISOString().slice(0, 10)} (あと${daysToNext}日)\n  推定受取: ${Math.round(expected).toLocaleString()}円 (利回り${info.yieldPct}%)`
      )
    }
  }
  return { reminders, annualForecastYen: Math.round(annualForecastYen) }
}

// ── 決算カレンダー: 次回決算発表が14日以内の銘柄を抽出 ─────────────────
async function earningsCalendar(): Promise<string[]> {
  const { data: holdings } = await adminSupabase.from('holdings').select('ticker, name')
  if (!holdings) return []
  const targets = holdings.filter(h => /^\d{4}$/.test(h.ticker ?? ''))

  const infos = await Promise.all(
    targets.map(async h => ({ h, info: await fetchEarningsInfo(h.ticker) }))
  )
  const reminders: string[] = []
  for (const { h, info } of infos) {
    if (!info) continue
    if (info.daysToNext >= 0 && info.daysToNext <= 14) {
      reminders.push(
        `📢 ${h.name}(${h.ticker}) 次回決算推定: ${info.nextEstimated} (あと${info.daysToNext}日)\n  値動き急変に注意。発表前後の急な売買判断は避ける`
      )
    }
  }
  return reminders
}

// ── 集中度警告: 自由売買口座で 30%/40% 超の銘柄を抽出 ─────────────────
// 集中度計算: 月次サマリー向けに上位銘柄の占有率を返す
async function concentrationSummary(): Promise<string[]> {
  const { data: holdings } = await adminSupabase.from('holdings').select('ticker, name, evaluation_amount, account_type')
  if (!holdings) return []
  // 持株会・積立NISAは即売却不可なので分母から除外
  const free = holdings.filter(h => ['nisa_growth', 'tokutei'].includes(h.account_type))
  const total = free.reduce((s, h) => s + Number(h.evaluation_amount ?? 0), 0)
  if (total <= 0) return []
  const lines: string[] = []
  const items = free
    .map(h => ({ h, pct: (Number(h.evaluation_amount ?? 0) / total) * 100 }))
    .filter(x => x.pct > 0)
    .sort((a, b) => b.pct - a.pct)
  for (const { h, pct } of items.slice(0, 3)) {
    const icon = pct >= 40 ? '🔴' : pct >= 30 ? '⚠️' : '🟢'
    lines.push(`${icon} ${h.name}(${h.ticker}): ${pct.toFixed(1)}%`)
  }
  return lines
}

// ── 朝通知: 注文期限 + 配当 + 決算 (集中度は月次に移動) ────────────────
// 集中度は変動が遅く日次で通知してもアクション可能性が低いため、月次サマリーに集約。
// AI 出口判定 (exit-judgment) の prompt には引き続き集中度が含まれるので、
// 売買判断時には反映される。
async function morningCheck(): Promise<string | null> {
  const [orderRes, divResult, earningsReminders] = await Promise.all([
    adminSupabase.from('orders').select('*').eq('status', 'active'),
    dividendCalendar(),
    earningsCalendar(),
  ])

  const urgent = (orderRes.data ?? []).filter(o => {
    if (!o.deadline) return false
    const days = daysUntil(o.deadline)
    return days >= 0 && days <= 1
  })

  // 何もなければ通知スキップ
  if (urgent.length === 0 && divResult.reminders.length === 0 && earningsReminders.length === 0) return null

  const dateLabel = jstDateLabel(jstNow())
  let msg = `🌅 朝レポート｜${dateLabel}\n\n`

  if (urgent.length > 0) {
    msg += `⏰ 注文期限アラート\n`
    urgent.forEach(o => {
      const days = daysUntil(o.deadline!)
      const typeLabel = o.order_type === 'sell' ? '売り' : '買い'
      msg += `${days === 0 ? '🔴 今日が期限' : '🟡 明日が期限'}\n`
      msg += `${o.name} ${typeLabel}指値 ${Number(o.price).toLocaleString()}円 × ${o.quantity}株\n\n`
    })
  }

  if (earningsReminders.length > 0) {
    msg += `📢 決算発表リマインダー (14日以内)\n`
    earningsReminders.forEach(r => { msg += `${r}\n` })
    msg += `\n`
  }

  if (divResult.reminders.length > 0) {
    msg += `💰 配当権利日リマインダー (30日以内)\n`
    divResult.reminders.forEach(r => { msg += `${r}\n` })
    if (divResult.annualForecastYen > 0) {
      msg += `\n年間配当予測合計: ${divResult.annualForecastYen.toLocaleString()}円\n`
    }
  }

  if (urgent.length > 0) msg += `\n約定しない場合は延長またはキャンセルを。`
  return msg
}

// ── 夕通知: 損益・NISA・期限2〜3日（ルールリマインドは除外） ─────────
async function eveningCheck(): Promise<string | null> {
  const [holdingsRes, ordersRes, profileRes, tsumitateRes] = await Promise.all([
    adminSupabase.from('holdings').select('*'),
    adminSupabase.from('orders').select('*').eq('status', 'active'),
    adminSupabase.from('profile').select('*').single(),
    adminSupabase.from('tsumitate_settings').select('*'),
  ])

  const holdings = holdingsRes.data ?? []
  const orders = ordersRes.data ?? []
  const profile = profileRes.data
  const tsumitate = tsumitateRes.data ?? []

  const lines: string[] = []

  // ① 損益アラート（個別株のみ）
  for (const h of holdings) {
    if (!/^\d{4}$/.test(h.ticker ?? '')) continue
    const pct = h.unrealized_gain_pct != null ? Number(h.unrealized_gain_pct) : null
    if (pct === null) continue
    if (pct <= -10) {
      lines.push(`🔴 ${h.name} ${pct}% — 損切り確認`)
    } else if (pct >= 25) {
      lines.push(`🟡 ${h.name} +${pct}% — 利確検討`)
    }
  }

  // ② 注文期限（2〜3日以内のみ。今日・明日は朝に通知済み）
  for (const o of orders) {
    if (!o.deadline) continue
    const days = daysUntil(o.deadline)
    if (days >= 2 && days <= 3) {
      const typeLabel = o.order_type === 'sell' ? '売り' : '買い'
      lines.push(`🟡 ${o.name} ${typeLabel}注文 あと${days}日で期限`)
    }
  }

  // ③ NISAペースアラート
  if (profile) {
    const tsumitateMonthly = tsumitate.reduce(
      (s: number, t: { monthly_amount: number }) => s + t.monthly_amount, 0
    )
    const nisaStatus = getNisaStatus(profile, tsumitateMonthly)
    if (nisaStatus.growthRemaining > 500000 && nisaStatus.growthMonthsLeft <= 3) {
      lines.push(
        `🔴 NISA成長枠 残り${Math.round(nisaStatus.growthRemaining / 10000)}万円 — 残${nisaStatus.growthMonthsLeft}ヶ月`
      )
    }
  }

  if (lines.length === 0) return null

  const dateLabel = jstDateLabel(jstNow())
  let msg = `📊 株デリック 夕アラート｜${dateLabel}\n\n`
  msg += lines.join('\n')
  msg += `\n\nアプリで確認 →`
  return msg
}

// ── 月次パフォーマンスサマリー: 月初1日に当月実績 + 年初来累積を通知 ─────
async function monthlyCheck(): Promise<string | null> {
  const now = jstNow()
  const currentYear = now.getUTCFullYear()
  const currentMonth = now.getUTCMonth() + 1
  // 「先月分」のサマリーを月初に出す
  const targetYear = currentMonth === 1 ? currentYear - 1 : currentYear
  const targetMonth = currentMonth === 1 ? 12 : currentMonth - 1
  const monthStart = `${targetYear}-${String(targetMonth).padStart(2, '0')}-01`
  const monthEnd = `${targetYear}-${String(targetMonth).padStart(2, '0')}-${new Date(targetYear, targetMonth, 0).getDate()}`
  const yearStart = `${currentYear}-01-01`

  const [holdingsRes, monthRealizedRes, ytdRealizedRes, profileRes] = await Promise.all([
    adminSupabase.from('holdings').select('*'),
    adminSupabase.from('realized_trades').select('*').gte('sell_date', monthStart).lte('sell_date', monthEnd),
    adminSupabase.from('realized_trades').select('*').gte('sell_date', yearStart),
    adminSupabase.from('profile').select('*').single(),
  ])

  const holdings = holdingsRes.data ?? []
  const monthRealized = monthRealizedRes.data ?? []
  const ytdRealized = ytdRealizedRes.data ?? []
  const profile = profileRes.data

  const realizedGainOf = (t: { realized_gain: number | null; sell_price: number; buy_price: number | null; quantity: number }): number =>
    t.realized_gain != null ? Number(t.realized_gain)
      : (t.buy_price != null ? (t.sell_price - t.buy_price) * t.quantity : 0)

  const monthRealizedSum = monthRealized.reduce((s, t) => s + realizedGainOf(t), 0)
  const ytdRealizedSum = ytdRealized.reduce((s, t) => s + realizedGainOf(t), 0)
  const totalEval = holdings.reduce((s, h) => s + Number(h.evaluation_amount ?? 0), 0)
  const totalUnrealized = holdings.reduce((s, h) => s + Number(h.unrealized_gain ?? 0), 0)
  const totalAssets = totalEval + Number(profile?.bank_balance ?? 0) + Number(profile?.dc_balance ?? 0)

  const sign = (n: number) => n >= 0 ? '+' : ''

  const concentrationLines = await concentrationSummary()

  let msg = `📈 マイ株デリック 月次サマリー (${targetYear}年${targetMonth}月)\n\n`
  msg += `【先月の実績】\n`
  msg += `・実現損益: ${sign(monthRealizedSum)}${Math.round(monthRealizedSum).toLocaleString()}円\n`
  msg += `・売却件数: ${monthRealized.length}件\n\n`
  msg += `【年初来累積】\n`
  msg += `・実現損益: ${sign(ytdRealizedSum)}${Math.round(ytdRealizedSum).toLocaleString()}円\n`
  msg += `・取引件数: ${ytdRealized.length}件\n\n`
  msg += `【現状】\n`
  msg += `・総資産: ${Math.round(totalAssets).toLocaleString()}円\n`
  msg += `・評価額: ${Math.round(totalEval).toLocaleString()}円\n`
  msg += `・含み損益: ${sign(totalUnrealized)}${Math.round(totalUnrealized).toLocaleString()}円\n`

  if (concentrationLines.length > 0) {
    msg += `\n【上位銘柄の占有率 (自由売買口座)】\n`
    concentrationLines.forEach(l => { msg += `${l}\n` })
  }

  if (profile?.target_amount) {
    const target = Number(profile.target_amount)
    const progressPct = (totalAssets / target) * 100
    msg += `\n【目標進捗】\n`
    msg += `・目標 ${Math.round(target / 10000)}万円 / 進捗 ${progressPct.toFixed(1)}%\n`
  }

  return msg
}

// ── ハンドラ ─────────────────────────────────────────────────────────
async function handler(req: Request) {
  const isGet = req.method === 'GET'
  if (!isGet) {
    const authHeader = req.headers.get('authorization')
    if (authHeader !== `Bearer ${process.env.APP_SECRET}`) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    }
  }

  const url = new URL(req.url)
  const type = url.searchParams.get('type') ?? 'evening'

  // 朝通知 (8:30 JST) 時に AI出口判定も自動実行（取引開始前にギャップ対応）
  // fire-and-forget（待たない、別途LINE通知される）
  if (type === 'morning') {
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://kabu-derrick.vercel.app'
    fetch(`${baseUrl}/api/exit-judgment`, {
      method: 'POST',
      signal: AbortSignal.timeout(5000),
    }).catch(e => console.error('[notify/morning] exit-judgment trigger failed:', e))
  }

  const message = type === 'morning' ? await morningCheck()
    : type === 'monthly' ? await monthlyCheck()
    : await eveningCheck()

  if (!message) {
    return NextResponse.json({ success: false, skipped: true, type, reason: '通知条件なし' })
  }

  const sent = await sendLineMessage(message)
  return NextResponse.json({ success: sent, type, message })
}

export async function POST(req: Request) { return handler(req) }
export async function GET(req: Request) { return handler(req) }
