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

// ── 朝通知: 今日・明日が期限の注文のみ ─────────────────────────────
async function morningCheck(): Promise<string | null> {
  const { data: orders } = await adminSupabase
    .from('orders').select('*').eq('status', 'active')

  const urgent = (orders ?? []).filter(o => {
    if (!o.deadline) return false
    const days = daysUntil(o.deadline)
    return days >= 0 && days <= 1
  })

  if (urgent.length === 0) return null

  const dateLabel = jstDateLabel(jstNow())
  let msg = `⏰ 注文期限アラート｜${dateLabel}\n\n`
  urgent.forEach(o => {
    const days = daysUntil(o.deadline!)
    const typeLabel = o.order_type === 'sell' ? '売り' : '買い'
    msg += `${days === 0 ? '🔴 今日が期限' : '🟡 明日が期限'}\n`
    msg += `${o.name} ${typeLabel}指値 ${Number(o.price).toLocaleString()}円 × ${o.quantity}株\n\n`
  })
  msg += `約定しない場合は延長またはキャンセルを。`
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

  const message = type === 'morning' ? await morningCheck() : await eveningCheck()

  if (!message) {
    return NextResponse.json({ success: false, skipped: true, type, reason: '通知条件なし' })
  }

  const sent = await sendLineMessage(message)
  return NextResponse.json({ success: sent, type, message })
}

export async function POST(req: Request) { return handler(req) }
export async function GET(req: Request) { return handler(req) }
