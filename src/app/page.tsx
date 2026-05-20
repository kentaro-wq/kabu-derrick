'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import type { Holding, Order, Profile } from '@/types'
import type { Alert } from '@/app/api/alerts/route'

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

function AssetChart({ snapshots }: { snapshots: { snapshot_date: string; total_assets: number }[] }) {
  const W = 340, H = 80, PAD = { top: 8, bottom: 20, left: 0, right: 0 }
  const vals = snapshots.map(s => s.total_assets)
  const min = Math.min(...vals)
  const max = Math.max(...vals)
  const range = max - min || 1
  const pts = snapshots.map((s, i) => {
    const x = PAD.left + (i / (snapshots.length - 1)) * (W - PAD.left - PAD.right)
    const y = PAD.top + (1 - (s.total_assets - min) / range) * (H - PAD.top - PAD.bottom)
    return `${x},${y}`
  })
  const first = snapshots[0].total_assets, last = snapshots[snapshots.length - 1].total_assets
  const diff = last - first
  const color = diff >= 0 ? '#34d399' : '#f87171'
  const firstDate = snapshots[0].snapshot_date.slice(5)
  const lastDate = snapshots[snapshots.length - 1].snapshot_date.slice(5)

  return (
    <div>
      <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ display: 'block' }}>
        <polyline points={pts.join(' ')} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        {snapshots.map((s, i) => {
          const x = PAD.left + (i / (snapshots.length - 1)) * (W - PAD.left - PAD.right)
          const y = PAD.top + (1 - (s.total_assets - min) / range) * (H - PAD.top - PAD.bottom)
          return <circle key={i} cx={x} cy={y} r="2.5" fill={color} />
        })}
      </svg>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--muted)', marginTop: 2 }}>
        <span>{firstDate}</span>
        <span style={{ color, fontWeight: 600 }}>{diff >= 0 ? '+' : ''}{(diff / 10000).toFixed(0)}万円</span>
        <span>{lastDate}</span>
      </div>
    </div>
  )
}

function accountLabel(type: string) {
  if (type === 'nisa_growth') return 'NISA成長'
  if (type === 'nisa_tsumitate') return 'つみたてNISA'
  if (type === 'old_tsumitate') return '旧つみたてNISA'
  if (type === 'tokutei') return '特定口座'
  if (type === 'mochikabu') return '持株会'
  if (type === 'dc') return 'DC'
  return type
}

interface Snapshot {
  snapshot_date: string
  total_assets: number
}

export default function Dashboard() {
  const [holdings, setHoldings] = useState<Holding[]>([])
  const [orders, setOrders] = useState<Order[]>([])
  const [profile, setProfile] = useState<Profile | null>(null)
  const [tsumitate, setTsumitate] = useState<{ name: string; monthly_amount: number }[]>([])
  const [snapshots, setSnapshots] = useState<Snapshot[]>([])
  const [alerts, setAlerts] = useState<Alert[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    Promise.all([
      fetch('/api/holdings').then(r => r.json()),
      fetch('/api/orders').then(r => r.json()),
      fetch('/api/profile').then(r => r.json()),
      fetch('/api/tsumitate').then(r => r.json()).catch(() => ({ settings: [] })),
      fetch('/api/snapshots').then(r => r.json()).catch(() => ({ snapshots: [] })),
      fetch('/api/alerts').then(r => r.json()).catch(() => ({ alerts: [] })),
    ]).then(([h, o, p, t, s, al]) => {
      setHoldings(Array.isArray(h) ? h : [])
      setOrders(Array.isArray(o) ? o : [])
      setProfile(p?.id ? p : null)
      setTsumitate(Array.isArray(t?.settings) ? t.settings : [])
      setSnapshots(Array.isArray(s?.snapshots) ? s.snapshots : [])
      setAlerts(Array.isArray(al?.alerts) ? al.alerts : [])
      setLoading(false)
    })
  }, [])

  const totalInvested = holdings.reduce((s, h) => s + (h.evaluation_amount ?? 0), 0)
  const totalGain = holdings.reduce((s, h) => s + (h.unrealized_gain ?? 0), 0)
  const bankBalance = profile?.bank_balance ?? 0
  const dcBalance = profile?.dc_balance ?? 0
  const totalAssets = totalInvested + dcBalance
  const targetAmount = profile?.target_amount ?? 30000000
  // 目標はDC別・現金別なので投資資産のみで進捗計算
  const progressPct = Math.min(100, Math.round((totalInvested / targetAmount) * 100))

  const nisaUsed = profile?.nisa_growth_used ?? 0
  const nisaLimit = profile?.nisa_growth_limit ?? 2400000
  const nisaRemaining = Math.max(0, nisaLimit - nisaUsed)
  const nisaPct = Math.round((nisaUsed / nisaLimit) * 100)
  const nisaMonthsLeft = Math.max(1, 12 - new Date().getMonth())
  const nisaMonthlyTarget = Math.ceil(nisaRemaining / nisaMonthsLeft)
  const nisaPriorityMessage = nisaRemaining > 0
    ? nisaMonthsLeft <= 4
      ? `NISA優先で枠を使い切る必要があります。残り${nisaMonthsLeft}ヶ月で月${nisaMonthlyTarget.toLocaleString()}円の投資ペース。`
      : `NISA枠の残り${(nisaRemaining / 10000).toFixed(1)}万円。年内に使い切る計画を。`
    : '今年のNISA枠は使い切り済みです。'

  // つみたてNISA残り（楽天と同じ: 利用済 + 利用予定を引く）
  const tsumitateMonthly = tsumitate.reduce((s, t) => s + t.monthly_amount, 0)
  const tsumitateMonthsLeft = Math.max(1, 12 - new Date().getMonth())
  const tsumitateScheduled = tsumitateMonthly * tsumitateMonthsLeft
  const tsumitateUsed = profile?.nisa_tsumitate_used ?? 0
  const tsumitateLimit = profile?.nisa_tsumitate_limit ?? 1200000
  const tsumitateRemaining = Math.max(0, tsumitateLimit - tsumitateUsed - tsumitateScheduled)
  const tsumitatePct = Math.round(((tsumitateUsed + tsumitateScheduled) / tsumitateLimit) * 100)

  const activeOrders = orders.filter(o => o.status === 'active' && o.deadline)
  const urgentOrders = activeOrders.filter(o => daysUntil(o.deadline!) <= 7)

  // 今日のスナップショットを自動保存（データ読み込み後に一度だけ）
  useEffect(() => {
    if (loading || totalAssets === 0) return
    fetch('/api/snapshots', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        total_evaluation: totalInvested,
        total_unrealized_gain: totalGain,
        bank_balance: bankBalance,
        dc_balance: dcBalance,
        total_assets: totalAssets,
      }),
    }).then(r => r.json()).then(saved => {
      if (saved?.snapshot_date) {
        setSnapshots(prev => {
          const filtered = prev.filter(s => s.snapshot_date !== saved.snapshot_date)
          return [...filtered, { snapshot_date: saved.snapshot_date, total_assets: saved.total_assets }]
            .sort((a, b) => a.snapshot_date.localeCompare(b.snapshot_date))
        })
      }
    }).catch(() => {})
  }, [loading]) // eslint-disable-line react-hooks/exhaustive-deps

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

      {/* アラート */}
      {alerts.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
          {alerts.map(alert => {
            const isHigh = alert.level === 'high'
            const isMed = alert.level === 'medium'
            const bg = isHigh ? '#3b1515' : isMed ? '#2d1e00' : '#1a1a2e'
            const border = isHigh ? '#7f1d1d' : isMed ? '#78350f' : '#1e3a5f'
            const titleColor = isHigh ? '#f87171' : isMed ? '#fbbf24' : '#60a5fa'
            const bodyColor = isHigh ? '#fca5a5' : isMed ? '#fde68a' : '#93c5fd'
            const icon = isHigh ? '🔴' : isMed ? '🟡' : '🔵'
            return (
              <div key={alert.id} style={{ background: bg, border: `1px solid ${border}`, borderRadius: 12, padding: 12 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: titleColor }}>{icon} {alert.title}</div>
                <div style={{ fontSize: 11, color: bodyColor, marginTop: 3 }}>{alert.body}</div>
              </div>
            )
          })}
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
        {/* 内訳 */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginTop: 14 }}>
          {[
            { label: '投資資産', sub: 'NISA・特定・持株会', value: totalInvested, highlight: true },
            { label: 'DC・iDeCo', sub: '別管理', value: dcBalance, highlight: false },
          ].map(item => (
            <div key={item.label} style={{
              background: item.highlight ? 'rgba(99,102,241,0.12)' : 'var(--surface2)',
              border: item.highlight ? '1px solid rgba(99,102,241,0.3)' : '1px solid transparent',
              borderRadius: 8, padding: '8px 10px'
            }}>
              <div style={{ fontSize: 10, color: item.highlight ? 'var(--accent)' : 'var(--muted)', marginBottom: 1, fontWeight: item.highlight ? 600 : 400 }}>{item.label}</div>
              <div style={{ fontSize: 9, color: 'var(--muted)', marginBottom: 3 }}>{item.sub}</div>
              <div style={{ fontSize: 13, fontWeight: 600 }}>{(item.value / 10000).toFixed(0)}万</div>
            </div>
          ))}
        </div>
        {/* 目標プログレスバー（投資資産のみ） */}
        <div style={{ marginTop: 14 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--muted)', marginBottom: 6 }}>
            <span>目標 {(targetAmount / 10000).toFixed(0)}万円 <span style={{ fontSize: 10 }}>（投資資産のみ）</span></span>
            <span style={{ color: 'var(--accent)', fontWeight: 600 }}>{progressPct}% 達成</span>
          </div>
          <div style={{ height: 6, background: 'var(--surface2)', borderRadius: 99, overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${progressPct}%`, background: 'var(--accent)', borderRadius: 99 }} />
          </div>
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
        <div style={{ marginTop: 10, padding: '10px 12px', background: 'rgba(59,130,246,0.08)', borderRadius: 10, fontSize: 12, color: 'var(--text)', lineHeight: 1.5 }}>
          <strong style={{ color: '#2563eb' }}>NISA優先</strong> {nisaPriorityMessage}
        </div>
        <div style={{ marginTop: 12, display: 'flex', justifyContent: 'flex-end' }}>
          <Link href="/strategy" style={{ color: '#2563eb', textDecoration: 'none', fontSize: 13, fontWeight: 700 }}>
            📈 戦略提案を確認する
          </Link>
        </div>
      </div>

      {/* 総資産推移グラフ */}
      {snapshots.length >= 2 && (
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 16, padding: 16, marginBottom: 14 }}>
          <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 12 }}>総資産推移（過去90日）</div>
          <AssetChart snapshots={snapshots} />
        </div>
      )}

      {/* NISA積立 */}
      {tsumitate.length > 0 && (
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 16, padding: 16, marginBottom: 14 }}>
          <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 10 }}>つみたてNISA枠（今年）</div>
          {/* 残り枠表示 */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 8 }}>
            <div>
              <span style={{ fontSize: 11, color: 'var(--muted)' }}>残り </span>
              <span style={{ fontSize: 22, fontWeight: 700, color: '#34d399' }}>
                {tsumitateRemaining.toLocaleString()}円
              </span>
            </div>
            <div style={{ fontSize: 11, color: 'var(--muted)' }}>利用済 {(tsumitateUsed / 10000).toFixed(0)}万 / 予定 {(tsumitateScheduled / 10000).toFixed(0)}万</div>
          </div>
          <div style={{ height: 6, background: 'var(--surface2)', borderRadius: 99, overflow: 'hidden', marginBottom: 12 }}>
            <div style={{ height: '100%', width: `${Math.min(100, tsumitatePct)}%`, background: '#10b981', borderRadius: 99 }} />
          </div>
          {/* 銘柄別積立額 */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {tsumitate.map((t, i) => (
              <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 13, color: 'var(--text)' }}>{t.name}</span>
                <span style={{ fontSize: 13, fontWeight: 600, color: '#34d399' }}>月 {t.monthly_amount.toLocaleString()}円</span>
              </div>
            ))}
            {tsumitate.length > 1 && (
              <div style={{ borderTop: '1px solid var(--border)', paddingTop: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 11, color: 'var(--muted)' }}>合計</span>
                <span style={{ fontSize: 13, fontWeight: 700 }}>月 {tsumitateMonthly.toLocaleString()}円</span>
              </div>
            )}
          </div>
          <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 8 }}>
            年間上限 {(tsumitateLimit / 10000).toFixed(0)}万円
          </div>
        </div>
      )}

      {/* 保有銘柄 */}
      <div style={{ marginBottom: 14 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--muted)' }}>保有銘柄</div>
          <a href="/portfolio/update" style={{ fontSize: 11, color: 'var(--accent)', textDecoration: 'none', padding: '4px 10px', border: '1px solid rgba(99,102,241,0.4)', borderRadius: 99 }}>
            📷 更新
          </a>
        </div>
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
                  background:
                    h.account_type === 'tokutei' ? '#2d1b4e' :
                    h.account_type === 'mochikabu' ? '#1c2e1c' :
                    h.account_type === 'dc' ? '#1a3a2a' : '#1e3a5f',
                  color:
                    h.account_type === 'tokutei' ? '#c084fc' :
                    h.account_type === 'mochikabu' ? '#86efac' :
                    h.account_type === 'dc' ? '#4ade80' : '#60a5fa',
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
          { href: '/strategy', label: '戦略', icon: '🧭' },
          { href: '/settings', label: '設定', icon: '⚙️' },
        ].map(item => (
          <Link key={item.href} href={item.href} style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3,
            color: item.href === '/' ? 'var(--accent)' : 'var(--muted)', textDecoration: 'none', fontSize: 10, fontWeight: 500,
            padding: '4px 10px',
          }}>
            <span style={{ fontSize: 20 }}>{item.icon}</span>
            {item.label}
          </Link>
        ))}
      </nav>
    </div>
  )
}
