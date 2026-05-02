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

const EMPTY_FORM = {
  name: '', ticker: '', order_type: 'buy' as 'buy' | 'sell',
  order_method: 'limit' as 'limit' | 'market',
  price: '', quantity: '', account_type: 'nisa_growth',
  deadline: '', notes: '', order_number: '',
}

export default function OrdersPage() {
  const [orders, setOrders] = useState<Order[]>([])
  const [loading, setLoading] = useState(true)
  const [updating, setUpdating] = useState<string | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState(EMPTY_FORM)
  const [submitting, setSubmitting] = useState(false)

  const reload = () =>
    fetch('/api/orders').then(r => r.json()).then(d => { setOrders(Array.isArray(d) ? d : []); setLoading(false) })

  useEffect(() => { reload() }, [])

  const updateStatus = async (id: string, status: Order['status']) => {
    setUpdating(id)
    await fetch('/api/orders', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, status }) })
    await reload()
    setUpdating(null)
  }

  const submitOrder = async () => {
    if (!form.name.trim() || !form.quantity) return
    setSubmitting(true)
    const body = {
      name: form.name.trim(),
      ticker: form.ticker.trim() || null,
      order_type: form.order_type,
      order_method: form.order_method,
      price: form.price ? Number(form.price) : null,
      quantity: Number(form.quantity),
      account_type: form.account_type,
      deadline: form.deadline || null,
      notes: form.notes.trim() || null,
      order_number: form.order_number.trim() || null,
      status: 'active',
      alert_days: [],
    }
    await fetch('/api/orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    await reload()
    setForm(EMPTY_FORM)
    setShowForm(false)
    setSubmitting(false)
  }

  const active = orders.filter(o => o.status === 'active')
  const inactive = orders.filter(o => o.status !== 'active')

  if (loading) {
    return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100dvh', color: 'var(--muted)' }}>読み込み中...</div>
  }

  const inputStyle = { width: '100%', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 8, padding: '9px 12px', color: 'var(--text)', fontSize: 14, outline: 'none', boxSizing: 'border-box' as const }
  const selectStyle = { ...inputStyle, appearance: 'none' as const }

  return (
    <div style={{ maxWidth: 480, margin: '0 auto', padding: '16px 12px 80px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Link href="/" style={{ color: 'var(--muted)', textDecoration: 'none', fontSize: 20 }}>←</Link>
          <div>
            <div style={{ fontSize: 11, color: 'var(--muted)' }}>マイ株デリック</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--accent)' }}>注文タスク管理</div>
          </div>
        </div>
        <button
          onClick={() => setShowForm(!showForm)}
          style={{ fontSize: 13, fontWeight: 600, padding: '7px 14px', borderRadius: 8, border: 'none', background: showForm ? 'var(--surface2)' : 'var(--accent)', color: showForm ? 'var(--muted)' : '#fff', cursor: 'pointer' }}
        >
          {showForm ? 'キャンセル' : '＋ 注文追加'}
        </button>
      </div>

      {/* 新規注文フォーム */}
      {showForm && (
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, padding: 16, marginBottom: 20 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--accent)', marginBottom: 14 }}>新規注文を登録</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <div>
                <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 4 }}>売買</div>
                <select value={form.order_type} onChange={e => setForm(f => ({ ...f, order_type: e.target.value as 'buy' | 'sell' }))} style={selectStyle}>
                  <option value="buy">買い</option>
                  <option value="sell">売り</option>
                </select>
              </div>
              <div>
                <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 4 }}>注文方法</div>
                <select value={form.order_method} onChange={e => setForm(f => ({ ...f, order_method: e.target.value as 'limit' | 'market' }))} style={selectStyle}>
                  <option value="limit">指値</option>
                  <option value="market">成行</option>
                </select>
              </div>
            </div>
            <div>
              <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 4 }}>銘柄名 *</div>
              <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="例: 川崎重工業" style={inputStyle} />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <div>
                <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 4 }}>証券コード</div>
                <input value={form.ticker} onChange={e => setForm(f => ({ ...f, ticker: e.target.value }))} placeholder="7012" style={inputStyle} />
              </div>
              <div>
                <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 4 }}>口座</div>
                <select value={form.account_type} onChange={e => setForm(f => ({ ...f, account_type: e.target.value }))} style={selectStyle}>
                  <option value="nisa_growth">NISA成長</option>
                  <option value="nisa_tsumitate">つみたて</option>
                  <option value="tokutei">特定</option>
                  <option value="dc">DC</option>
                </select>
              </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <div>
                <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 4 }}>指値（円）{form.order_method === 'market' ? '—' : '*'}</div>
                <input type="number" value={form.price} onChange={e => setForm(f => ({ ...f, price: e.target.value }))} placeholder="3500" disabled={form.order_method === 'market'} style={{ ...inputStyle, opacity: form.order_method === 'market' ? 0.4 : 1 }} />
              </div>
              <div>
                <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 4 }}>数量（株）*</div>
                <input type="number" value={form.quantity} onChange={e => setForm(f => ({ ...f, quantity: e.target.value }))} placeholder="100" style={inputStyle} />
              </div>
            </div>
            <div>
              <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 4 }}>期限</div>
              <input type="date" value={form.deadline} onChange={e => setForm(f => ({ ...f, deadline: e.target.value }))} style={inputStyle} />
            </div>
            <div>
              <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 4 }}>注文番号</div>
              <input value={form.order_number} onChange={e => setForm(f => ({ ...f, order_number: e.target.value }))} placeholder="楽天証券の注文番号" style={inputStyle} />
            </div>
            <div>
              <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 4 }}>メモ</div>
              <input value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} placeholder="判断理由など" style={inputStyle} />
            </div>
            <button
              onClick={submitOrder}
              disabled={submitting || !form.name.trim() || !form.quantity}
              style={{ width: '100%', padding: 12, borderRadius: 10, border: 'none', background: 'var(--accent)', color: '#fff', fontSize: 14, fontWeight: 600, cursor: 'pointer', opacity: !form.name.trim() || !form.quantity ? 0.5 : 1 }}
            >
              {submitting ? '登録中...' : '✅ 注文を登録する'}
            </button>
          </div>
        </div>
      )}

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

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 10 }}>
                {o.order_method === 'limit' && (
                  <div style={{ background: 'var(--surface2)', borderRadius: 8, padding: '8px 10px' }}>
                    <div style={{ fontSize: 10, color: 'var(--muted)', marginBottom: 2 }}>指値</div>
                    <div style={{ fontSize: 18, fontWeight: 700 }}>{o.price?.toLocaleString()}円</div>
                  </div>
                )}
                <div style={{ background: 'var(--surface2)', borderRadius: 8, padding: '8px 10px' }}>
                  <div style={{ fontSize: 10, color: 'var(--muted)', marginBottom: 2 }}>数量</div>
                  <div style={{ fontSize: 18, fontWeight: 700 }}>{o.quantity.toLocaleString()}株</div>
                </div>
                {o.price && o.quantity && (
                  <div style={{ background: 'var(--surface2)', borderRadius: 8, padding: '8px 10px' }}>
                    <div style={{ fontSize: 10, color: 'var(--muted)', marginBottom: 2 }}>概算金額</div>
                    <div style={{ fontSize: 14, fontWeight: 700 }}>{(o.price * o.quantity).toLocaleString()}円</div>
                  </div>
                )}
              </div>

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
          { href: '/rules', label: 'ルール', icon: '📌' },
          { href: '/chat', label: 'AI相談', icon: '💬' },
          { href: '/settings', label: '設定', icon: '⚙️' },
        ].map(item => (
          <Link key={item.href} href={item.href} style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3,
            color: item.href === '/orders' ? 'var(--accent)' : 'var(--muted)', textDecoration: 'none', fontSize: 10, fontWeight: 500,
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
