'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import type { Order } from '@/types'

function daysUntil(dateStr: string): number {
  const today = new Date(); today.setHours(0,0,0,0)
  const t = new Date(dateStr); t.setHours(0,0,0,0)
  return Math.ceil((t.getTime() - today.getTime()) / 86400000)
}

function urgencyColor(days: number) {
  if (days <= 3) return '#ef4444'
  if (days <= 7) return '#f59e0b'
  return '#22c55e'
}

function urgencyBg(days: number) {
  if (days <= 3) return '#3b1515'
  if (days <= 7) return '#2d1f0a'
  return '#0f2a1a'
}

export default function OrdersPage() {
  const [orders, setOrders] = useState<Order[]>([])
  const [loading, setLoading] = useState(true)
  const [updating, setUpdating] = useState<string | null>(null)

  const reload = () =>
    fetch('/api/orders').then(r => r.json()).then(d => { setOrders(Array.isArray(d) ? d : []); setLoading(false) })

  useEffect(() => { reload() }, [])

  const updateStatus = async (id: string, status: Order['status']) => {
    setUpdating(id)
    await fetch('/api/orders', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, status }) })
    await reload()
    setUpdating(null)
  }

  const active = orders.filter(o => o.status === 'active')
  const inactive = orders.filter(o => o.status !== 'active')

  if (loading) {
    return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100dvh', color: 'var(--muted)' }}>読み込み中...</div>
  }

  return (
    <div style={{ maxWidth: 480, margin: '0 auto', padding: '16px 12px 80px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20 }}>
        <Link href="/" style={{ color: 'var(--muted)', textDecoration: 'none', fontSize: 20 }}>←</Link>
        <div>
          <div style={{ fontSize: 11, color: 'var(--muted)' }}>マイ株デリック</div>
          <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--accent)' }}>注文タスク管理</div>
        </div>
      </div>

      {/* 執行中 */}
      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)', marginBottom: 10 }}>
        執行中 ({active.length}件)
      </div>
      {active.length === 0 && (
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: 20, textAlign: 'center', color: 'var(--muted)', fontSize: 13, marginBottom: 20 }}>
          執行中の注文はありません
        </div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 24 }}>
        {active.map(o => {
          const days = o.deadline ? daysUntil(o.deadline) : null
          return (
            <div key={o.id} style={{ background: 'var(--surface)', border: `1px solid ${days != null && days <= 7 ? urgencyColor(days) + '66' : 'var(--border)'}`, borderRadius: 14, padding: 16 }}>
              {/* 銘柄・口座 */}
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10 }}>
                <div>
                  <span style={{ fontSize: 16, fontWeight: 700 }}>{o.name}</span>
                  <span style={{ fontSize: 11, color: 'var(--muted)', marginLeft: 6 }}>{o.ticker}</span>
                </div>
                <span style={{
                  padding: '2px 8px', borderRadius: 99, fontSize: 10, fontWeight: 600,
                  background: o.order_type === 'sell' ? '#3b1515' : '#1a3a2a',
                  color: o.order_type === 'sell' ? '#f87171' : '#4ade80',
                }}>
                  {o.order_type === 'sell' ? '売り' : '買い'} {o.order_method === 'limit' ? '指値' : '成行'}
                </span>
              </div>

              {/* 注文詳細 */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 10 }}>
                <div style={{ background: 'var(--surface2)', borderRadius: 8, padding: '8px 10px' }}>
                  <div style={{ fontSize: 10, color: 'var(--muted)', marginBottom: 2 }}>指値</div>
                  <div style={{ fontSize: 18, fontWeight: 700 }}>{o.price?.toLocaleString()}円</div>
                </div>
                <div style={{ background: 'var(--surface2)', borderRadius: 8, padding: '8px 10px' }}>
                  <div style={{ fontSize: 10, color: 'var(--muted)', marginBottom: 2 }}>数量</div>
                  <div style={{ fontSize: 18, fontWeight: 700 }}>{o.quantity.toLocaleString()}株</div>
                </div>
              </div>

              {/* 期限 */}
              {o.deadline && days != null && (
                <div style={{ background: urgencyBg(days), border: `1px solid ${urgencyColor(days)}33`, borderRadius: 8, padding: '10px 12px', marginBottom: 10 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      <div style={{ fontSize: 10, color: 'var(--muted)', marginBottom: 2 }}>期限</div>
                      <div style={{ fontSize: 14, fontWeight: 600 }}>{o.deadline}</div>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <div style={{ fontSize: 10, color: 'var(--muted)', marginBottom: 2 }}>残り</div>
                      <div style={{ fontSize: 22, fontWeight: 700, color: urgencyColor(days) }}>
                        {days}日
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {o.notes && (
                <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 10, padding: '0 2px' }}>{o.notes}</div>
              )}

              {o.order_number && (
                <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 10 }}>注文番号: {o.order_number}</div>
              )}

              {/* アクションボタン */}
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  onClick={() => updateStatus(o.id, 'executed')}
                  disabled={updating === o.id}
                  style={{ flex: 1, padding: '9px', borderRadius: 8, border: 'none', background: '#1a3a2a', color: '#4ade80', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
                >
                  ✓ 約定済み
                </button>
                <button
                  onClick={() => updateStatus(o.id, 'expired')}
                  disabled={updating === o.id}
                  style={{ flex: 1, padding: '9px', borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', color: 'var(--muted)', fontSize: 12, cursor: 'pointer' }}
                >
                  期限切れ
                </button>
                <button
                  onClick={() => updateStatus(o.id, 'cancelled')}
                  disabled={updating === o.id}
                  style={{ padding: '9px 12px', borderRadius: 8, border: '1px solid #3b1515', background: 'transparent', color: '#f87171', fontSize: 12, cursor: 'pointer' }}
                >
                  取消
                </button>
              </div>
            </div>
          )
        })}
      </div>

      {/* 完了済み */}
      {inactive.length > 0 && (
        <>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)', marginBottom: 10 }}>完了・キャンセル済み</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {inactive.map(o => (
              <div key={o.id} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: 14, opacity: 0.6 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ fontSize: 14, fontWeight: 600 }}>{o.name}</span>
                  <span style={{ fontSize: 11, color: 'var(--muted)' }}>
                    {o.status === 'executed' ? '✓ 約定' : o.status === 'expired' ? '期限切れ' : 'キャンセル'}
                  </span>
                </div>
                {o.deadline && <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>期限: {o.deadline}</div>}
              </div>
            ))}
          </div>
        </>
      )}

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
            color: item.href === '/orders' ? 'var(--accent)' : 'var(--muted)', textDecoration: 'none', fontSize: 10, fontWeight: 500,
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
