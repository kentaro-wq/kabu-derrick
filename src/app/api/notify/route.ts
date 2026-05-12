import { NextResponse } from 'next/server'
import { adminSupabase } from '@/lib/supabase'
import { sendLineMessage, formatImportantNotification } from '@/lib/line'
import { getNisaStatus } from '@/lib/nisa'

function daysUntil(dateStr: string): number {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const target = new Date(dateStr)
  target.setHours(0, 0, 0, 0)
  return Math.ceil((target.getTime() - today.getTime()) / (1000 * 60 * 60 * 24))
}

export async function POST(req: Request) {
  const authHeader = req.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.APP_SECRET}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const url = new URL(req.url)
  const isTest = url.searchParams.get('test') === 'true'

  const [holdingsRes, ordersRes, profileRes] = await Promise.all([
    adminSupabase.from('holdings').select('*'),
    adminSupabase.from('orders').select('*').eq('status', 'active'),
    adminSupabase.from('profile').select('*').single(),
  ])

  const holdings = holdingsRes.data ?? []
  const orders = ordersRes.data ?? []
  const profile = profileRes.data

  const totalAssets = holdings.reduce((s, h) => s + (h.evaluation_amount ?? 0), 0)
  const totalGain = holdings.reduce((s, h) => s + (h.unrealized_gain ?? 0), 0)

  const alerts: string[] = []
  const activeOrders = orders
    .filter(o => o.deadline)
    .map(o => {
      const daysLeft = daysUntil(o.deadline!)
      if (daysLeft <= 7) {
        alerts.push(`${o.name} ${o.order_type === 'sell' ? '売り' : '買い'}注文の期限まで${daysLeft}日`)
      }
      return { name: o.name, deadline: o.deadline!, daysLeft, price: o.price ?? 0 }
    })

  if (profile) {
    const nisaStatus = getNisaStatus(profile)
    if (nisaStatus.growthRemaining > 0 && nisaStatus.growthMonthsLeft <= 4) {
      alerts.push(`NISA成長枠 残り${nisaStatus.growthRemaining.toLocaleString()}円（残り${nisaStatus.growthMonthsLeft}ヶ月、月${nisaStatus.growthMonthlyTarget.toLocaleString()}円ペース）`)
    }
    if (nisaStatus.tsumitateRemaining > 0 && nisaStatus.tsumitateMonthsLeft <= 4) {
      alerts.push(`つみたてNISA残り${nisaStatus.tsumitateRemaining.toLocaleString()}円（残り${nisaStatus.tsumitateMonthsLeft}ヶ月、月${nisaStatus.tsumitateMonthlyTarget.toLocaleString()}円ペース）`)
    }
  }

  const hasImportantEvents = alerts.length > 0 || activeOrders.some(o => o.daysLeft <= 7)
  const date = new Date().toLocaleDateString('ja-JP', { month: 'long', day: 'numeric', weekday: 'short' })

  if (!isTest && !hasImportantEvents) {
    return NextResponse.json({ success: false, skipped: true, message: '重要な通知はありませんでした' })
  }

  let message: string
  if (isTest) {
    if (hasImportantEvents) {
      message = formatImportantNotification({
        title: '重要通知（テスト）',
        summary: '現在の重要アラートです。',
        details: [...alerts],
      })
    } else {
      message = `🔧 マイ株デリック LINE送信テスト\n${date}\n\nLINE通知が正常に届いています。`
    }
  } else {
    message = formatImportantNotification({
      title: '重要通知',
      summary: '現在の重要アラートです。',
      details: [...alerts],
    })
  }

  const sent = await sendLineMessage(message)
  return NextResponse.json({
    success: sent,
    skipped: !hasImportantEvents && !isTest,
    totalAssets,
    totalGain,
    message,
  })
}
