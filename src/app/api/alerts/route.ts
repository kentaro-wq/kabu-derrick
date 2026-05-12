import { NextResponse } from 'next/server'
import { adminSupabase } from '@/lib/supabase'
import { getNisaStatus } from '@/lib/nisa'

export interface Alert {
  id: string
  level: 'high' | 'medium' | 'low'
  type: 'sell_signal' | 'loss_warning' | 'order_deadline' | 'nisa_pace' | 'rule_reminder'
  title: string
  body: string
  ticker?: string
}

export async function GET() {
  const [holdingsRes, ordersRes, profileRes, tsumitateRes, rulesRes] = await Promise.all([
    adminSupabase.from('holdings').select('*'),
    adminSupabase.from('orders').select('*').eq('status', 'active'),
    adminSupabase.from('profile').select('*').single(),
    adminSupabase.from('tsumitate_settings').select('*'),
    adminSupabase.from('holding_rules')
      .select('ticker, name, sell_conditions, timeline_notes')
      .eq('is_active', true),
  ])

  const holdings = holdingsRes.data ?? []
  const orders = ordersRes.data ?? []
  const profile = profileRes.data
  const tsumitate = tsumitateRes.data ?? []
  const rules = rulesRes.data ?? []

  const alerts: Alert[] = []

  // ① 損益率アラート（個別株のみ）
  for (const h of holdings) {
    if (!/^\d{4}$/.test(h.ticker)) continue
    const pct = h.unrealized_gain_pct != null
      ? Number(h.unrealized_gain_pct)
      : h.unrealized_gain != null && h.evaluation_amount != null
        ? Math.round((Number(h.unrealized_gain) / (Number(h.evaluation_amount) - Number(h.unrealized_gain))) * 1000) / 10
        : null

    if (pct === null) continue

    if (pct >= 25) {
      alerts.push({
        id: `sell_${h.ticker}`,
        level: 'medium',
        type: 'sell_signal',
        title: `${h.name} +${pct}% — 利確検討`,
        body: `保有ルールの売却条件を確認してください。`,
        ticker: h.ticker,
      })
    } else if (pct <= -10) {
      alerts.push({
        id: `loss_${h.ticker}`,
        level: 'high',
        type: 'loss_warning',
        title: `${h.name} ${pct}% — 損切り確認`,
        body: `設定した損切りラインを超えていないか確認してください。`,
        ticker: h.ticker,
      })
    }
  }

  // ② 注文期限アラート（3日以内）
  const now = new Date()
  for (const o of orders) {
    if (!o.deadline) continue
    const days = Math.ceil((new Date(o.deadline).getTime() - now.getTime()) / 86400000)
    if (days <= 3 && days >= 0) {
      alerts.push({
        id: `deadline_${o.id}`,
        level: days === 0 ? 'high' : 'medium',
        type: 'order_deadline',
        title: `${o.name}の${o.order_type === 'sell' ? '売り' : '買い'}注文 期限${days === 0 ? '今日' : `あと${days}日`}`,
        body: `${o.price.toLocaleString()}円×${o.quantity}株。約定しない場合は延長・キャンセルを検討。`,
        ticker: o.ticker,
      })
    }
  }

  // ③ NISA成長枠ペースアラート
  if (profile) {
    const tsumitateMonthly = tsumitate.reduce((s: number, t: { monthly_amount: number }) => s + t.monthly_amount, 0)
    const nisaStatus = getNisaStatus(profile, tsumitateMonthly)

    if (nisaStatus.growthRemaining > 500000 && nisaStatus.growthMonthsLeft <= 3) {
      alerts.push({
        id: 'nisa_pace',
        level: 'high',
        type: 'nisa_pace',
        title: `NISA成長枠 残り${Math.round(nisaStatus.growthRemaining / 10000)}万円 — 残${nisaStatus.growthMonthsLeft}ヶ月`,
        body: `月${Math.round(nisaStatus.growthMonthlyTarget / 10000)}万円ペースで買わないと年内に使い切れません。`,
      })
    }
  }

  // ④ 銘柄ルールの売却条件リマインダー（条件が設定されている銘柄）
  for (const rule of rules) {
    if (!rule.sell_conditions || rule.sell_conditions === 'なし') continue
    const holding = holdings.find((h: { ticker: string }) => h.ticker === rule.ticker)
    if (!holding) continue
    const pct = holding.unrealized_gain_pct != null ? Number(holding.unrealized_gain_pct) : null
    // 含み益がある銘柄でルールがある場合にリマインド
    if (pct != null && pct > 5) {
      alerts.push({
        id: `rule_${rule.ticker}`,
        level: 'low',
        type: 'rule_reminder',
        title: `${rule.name} ルール確認`,
        body: `売却条件: ${rule.sell_conditions}`,
        ticker: rule.ticker,
      })
    }
  }

  // レベル順にソート: high → medium → low
  const levelOrder = { high: 0, medium: 1, low: 2 }
  alerts.sort((a, b) => levelOrder[a.level] - levelOrder[b.level])

  return NextResponse.json({ alerts })
}
