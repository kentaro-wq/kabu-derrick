import { NextResponse } from 'next/server'
import { adminSupabase } from '@/lib/supabase'
import { sendLineMessage, formatMorningReport } from '@/lib/line'

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
    const nisaRemaining = profile.nisa_growth_limit - profile.nisa_growth_used
    if (nisaRemaining > 0) {
      const monthsLeft = 12 - new Date().getMonth()
      const monthlyTarget = Math.round(nisaRemaining / monthsLeft)
      if (monthsLeft <= 3) {
        alerts.push(`NISA成長枠 残り${nisaRemaining.toLocaleString()}円 (月${monthlyTarget.toLocaleString()}円ペース)`)
      }
    }
  }

  const message = formatMorningReport({ totalAssets, totalGain, activeOrders, alerts })
  const sent = await sendLineMessage(message)

  return NextResponse.json({ success: sent, message })
}
