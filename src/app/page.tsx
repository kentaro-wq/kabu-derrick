'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import type { Holding, Order, Profile } from '@/types'

function daysUntil(dateStr: string): number {
  const today = new Date(); today.setHours(0,0,0,0)
  const t = new Date(dateStr); t.setHours(0,0,0,0)
  return Math.ceil((t.getTime() - today.getTime()) / 86400000)
}

function fmt(n: number | null | undefined) {
  if (n == null) return '—'
  return n.toLocaleString('ja-JP') + '円'
}

function fmtGain(n: number | null | undefined) {
  if (n == null) return '—'
  const sign = n >= 0 ? '+' : ''
  return sign + n.toLocaleString('ja-JP') + '円'
}

function accountLabel(type: string) {
  if (type === 'nisa_growth') return 'NISA成長'
  if (type === 'nisa_tsumitate' || type === 'nisa_tsumitate_old') return 'つみたてNISA'
  if (type === 'tokutei') return '特定'
  if (type === 'dc') return 'DC'
  return type
}

export default function Dashboard() {
  const [holdings, setHoldings] = useState<Holding[]>([])
  const [orders, setOrders] = useState<Order[]>([])
  const [profile, setProfile] = useState<Profile | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    Promise.all([
      fetch('/api/holdings').then(r => r.json()),
      fetch('/api/orders').then(r => r.json()),
      fetch('/api/profile').then(r => r.json()),
    ]).then(([h, o, p]) => {
      setHoldings(Array.isArray(h) ? h : [])
      setOrders(Array.isArray(o) ? o : [])
      setProfile(p?.id ? p : null)
      setLoading(false)
    })
  }, [])

  const totalInvested = holdings.reduce((s, h) => s + (h.evaluation_amount ?? 0), 0)
  const totalGain = holdings.reduce((s, h) => s + (h.unrealized_gain ?? 0), 0)
  const bankBalance = profile?.bank_balance ?? 0
  const dcBalance = profile?.dc_balance ?? 0
  const totalAssets = totalInvested + bankBalance + dcBalance
  const targetAmount = profile?.target_amount ?? 30000000
  const progressPct = Math.min(100, Math.round((totalAssets / targetAmount) * 100))

  const nisaUsed = profile?.nisa_growth_used ?? 0
  const nisaLimit = profile?.nisa_growth_limit ?? 2400000
  const nisaRemaining = nisaLimit - nisaUsed
  const nisaPct = Math.round((nisaUsed / nisaLimit) * 100)

  const activeOrders = orders.filter(o => o.status === 'active' && o.deadline)
  const urgentOrders = activeOrders.filter(o => daysUntil(o.deadline!) <= 7)

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100dvh', color: 'var(--muted)' }}>
        読み込み中...
      </div>
    )
  }

  return (
    <div style={{ maxWidth: 480, margin: '0 auto', padding: '16px 12px 80px' }}>
      {/* ヘッダー */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <div>
          <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 2 }}>マイ株デリック</div>
          <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--accent)' }}>ダッシュボード</div>
        </div>
        <div style={{ fontSize: 11, color: 'var(--muted)' }}>
          {new Date().toLocaleDateString('ja-JP', { month: 'long', day: 'numeric', weekday: 'short' })}
        </div>
      </div>

      {/* 緊急アラート */}
      {urgentOrders.length > 0 && (
        <div style={{ background: '#3b1515', border: '1px solid #7f1d1d', borderRadius: 12, padding: 14, marginBottom: 16 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#f87171', marginBottom: 8 }}>⚠️ 要確認</div>
          {urgentOrders.map(o => (
            <div key={o.id} style={{ fontSize: 13, color: '#fca5a5', marginBottom: 4 }}>
              {o.name} {o.order_type === 'sell' ? '売り' : '買い'}注文 — 期限まであと<strong>{daysUntil(o.deadline!)}日</strong>
            </div>
          ))}
          <Link href="/orders" style={{ fontSize: 11, color: '#f87171', textDecoration: 'underline' }}>
            注文を確認する →
          </Link>
        </div>
      )}

      {/* 総資産カード */}
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 16, padding: 20, marginBottom: 14 }}>
        <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 6 }}>総資産（概算）</div>
        <div style={{ fontSize: 32, fontWeight: 700, marginBottom: 4 }}>
          {totalAssets.toLocaleString()}円
        </div>
        <div style={{ fontSize: 13, color: totalGain >= 0 ? 'var(--green)' : 'var(--red)' }}>
          投資評価損益 {fmtGain(totalGain)}
        </div>
        {/* 3000万目標プログレスバー */}
        <div style={{ marginTop: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--muted)', marginBottom: 6 }}>
            <span>目標 {(targetAmount / 10000).toFixed(0)}万円</span>
            <span>{progressPct}% 達成</span>
          </div>
          <div style={{ height: 6, background: 'var(--surface2)', borderRadius: 99, overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${progressPct}%`, background: 'var(--accent)', borderRadius: 99 }} />
          </div>
        </div>
        {/* 内訳 */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginTop: 14 }}>
          {[
            { label: '楽天証券', value: totalInvested },
            { label: '銀行預金', value: bankBalance },
            { label: 'DC', value: dcBalance },
          ].map(item => (
            <div key={item.label} style={{ background: 'var(--surface2)', borderRadius: 8, padding: '8px 10px' }}>
              <div style={{ fontSize: 10, color: 'var(--muted)', marginBottom: 3 }}>{item.label}</div>
              <div style={{ fontSize: 13, fontWeight: 600 }}>{(item.value / 10000).toFixed(0)}万</div>
            </div>
          ))}
        </div>
      </div>

      {/* NISA枠 */}
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 16, padding: 16, marginBottom: 14 }}>
        <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 10 }}>NISA成長投資枠（今年）</div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 8 }}>
          <div>
            <span style={{ fontSize: 11, color: 'var(--muted)' }}>残り </span>
            <span style={{ fontSize: 22, fontWeight: 700, color: '#60a5fa' }}>
              {(nisaRemaining / 10000).toFixed(0)}万円
            </span>
          </div>
          <div style={{ fontSize: 11, color: 'var(--muted)' }}>利用済 {(nisaUsed / 10000).toFixed(0)}万</div>
        </div>
        <div style={{ height: 6, background: 'var(--surface2)', borderRadius: 99, overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${nisaPct}%`, background: '#3b82f6', borderRadius: 99 }} />
        </div>
        <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 6 }}>
          年間上限 {(nisaLimit / 10000).toFixed(0)}万円
        </div>
      </div>

      {/* 保有銘柄 */}
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--muted)', marginBottom: 10 }}>保有銘柄</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {holdings.map(h => (
            <div key={h.id} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: 14 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 6 }}>
                <div>
                  <span style={{ fontSize: 15, fontWeight: 600 }}>{h.name}</span>
                  <span style={{ fontSize: 11, color: 'var(--muted)', marginLeft: 6 }}>{h.ticker}</span>
                </div>
                <span style={{
                  fontSize: 10, fontWeight: 600, padding: '2px 7px', borderRadius: 99,
                  background: h.account_type === 'tokutei' ? '#2d1b4e' : h.account_type === 'dc' ? '#1a3a2a' : '#1e3a5f',
                  color: h.account_type === 'tokutei' ? '#c084fc' : h.account_type === 'dc' ? '#4ade80' : '#60a5fa',
                }}>
                  {accountLabel(h.account_type)}
                </span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                <div style={{ fontSize: 18, fontWeight: 700 }}>{fmt(h.evaluation_amount)}</div>
                <div style={{ fontSize: 13, color: (h.unrealized_gain ?? 0) >= 0 ? 'var(--green)' : 'var(--red)' }}>
                  {fmtGain(h.unrealized_gain)}
                  {h.unrealized_gain_pct != null && (
                    <span style={{ fontSize: 11, marginLeft: 4 }}>
                      ({h.unrealized_gain_pct >= 0 ? '+' : ''}{h.unrealized_gain_pct.toFixed(2)}%)
                    </span>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* ボトムナビ */}
      <nav style={{
        position: 'fixed', bottom: 0, left: 0, right: 0,
        background: 'var(--surface)', borderTop: '1px solid var(--border)',
        display: 'flex', justifyContent: 'space-around', padding: '10px 0 max(10px, env(safe-area-inset-bottom))',
      }}>
        {[
          { href: '/', label: 'ホーム', icon: '📊' },
          { href: '/orders', label: '注文', icon: '📋' },
          { href: '/chat', label: 'AI相談', icon: '💬' },
          { href: '/settings', label: '設定', icon: '⚙️' },
        ].map(item => (
          <Link key={item.href} href={item.href} style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3,
            color: 'var(--muted)', textDecoration: 'none', fontSize: 10, fontWeight: 500,
            padding: '4px 16px',
          }}>
            <span style={{ fontSize: 20 }}>{item.icon}</span>
            {item.label}
          </Link>
        ))}
      </nav>
    </div>
  )
}
