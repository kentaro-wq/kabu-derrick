'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import type { Holding, Profile } from '@/types'
import { getNisaStatus } from '@/lib/nisa'

interface HoldingRule {
  ticker: string
  name: string
  sell_conditions: string | null
  timeline_notes: string | null
}

interface Order {
  id: string
  ticker: string
  name: string
  order_type: string
  price: number
  quantity: number
  deadline: string | null
  status: string
}

interface TsumitateSetting {
  id: string
  name: string
  monthly_amount: number
  account_type: string
}

function toMan(yen: number) {
  const man = Math.round(yen / 10000)
  return man >= 10000 ? `${(man / 10000).toFixed(1)}億円` : `${man}万円`
}

function isFund(h: Holding) {
  return h.account_type === 'nisa_tsumitate' || h.account_type === 'old_tsumitate' || h.account_type === 'nisa_tsumitate_old'
}

function statusLight(h: Holding): { icon: string; color: string; label: string } {
  if (isFund(h)) return { icon: '⚪', color: 'var(--muted)', label: '積立継続' }
  const pct = h.unrealized_gain_pct ?? 0
  if (pct <= -10) return { icon: '🔴', color: '#f87171', label: '要確認' }
  if (pct < -3) return { icon: '🟡', color: '#fbbf24', label: '注視' }
  if (pct >= 20) return { icon: '🟡', color: '#fbbf24', label: '利確検討' }
  return { icon: '🟢', color: '#4ade80', label: '問題なし' }
}

function NisaBar({ used, limit, label }: { used: number; limit: number; label: string }) {
  const pct = Math.min(100, Math.round((used / limit) * 100))
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
        <span style={{ fontSize: 11, color: 'var(--muted)' }}>{label}</span>
        <span style={{ fontSize: 11, color: 'var(--muted)' }}>使用 {toMan(used)} / {toMan(limit)}</span>
      </div>
      <div style={{ height: 5, background: 'var(--surface2)', borderRadius: 99, overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${pct}%`, background: pct >= 90 ? '#f87171' : pct >= 70 ? '#fbbf24' : 'var(--accent)', borderRadius: 99, transition: 'width 0.4s' }} />
      </div>
    </div>
  )
}

export default function StrategyPage() {
  const [holdings, setHoldings] = useState<Holding[]>([])
  const [ruleMap, setRuleMap] = useState<Map<string, HoldingRule>>(new Map())
  const [orders, setOrders] = useState<Order[]>([])
  const [profile, setProfile] = useState<Profile | null>(null)
  const [tsumitate, setTsumitate] = useState<TsumitateSetting[]>([])
  const [loading, setLoading] = useState(true)

  const [comment, setComment] = useState<string | null>(null)
  const [focusPoint, setFocusPoint] = useState<string | null>(null)
  const [commentAt, setCommentAt] = useState<string | null>(null)
  const [generating, setGenerating] = useState(false)

  useEffect(() => {
    Promise.all([
      fetch('/api/holdings').then(r => r.json()),
      fetch('/api/holding-rules').then(r => r.json()),
      fetch('/api/orders').then(r => r.json()),
      fetch('/api/profile').then(r => r.json()),
      fetch('/api/tsumitate').then(r => r.json()),
      fetch('/api/strategy/history').then(r => r.json()),
    ]).then(([h, r, o, p, t, hist]) => {
      setHoldings(Array.isArray(h) ? h : [])
      const rm = new Map<string, HoldingRule>()
      ;(Array.isArray(r) ? r : []).forEach((rule: HoldingRule) => rm.set(rule.ticker, rule))
      setRuleMap(rm)
      setOrders((Array.isArray(o) ? o : []).filter((ord: Order) => ord.status === 'active'))
      if (p && !p.error) setProfile(p as Profile)
      setTsumitate(t?.settings ?? [])
      if (hist?.history?.length > 0) {
        const latest = hist.history[0]
        if (latest.raw_response) {
          try {
            const parsed = JSON.parse(latest.raw_response)
            if (parsed.comment) {
              setComment(parsed.comment)
              setFocusPoint(parsed.focusPoint ?? latest.headline ?? null)
              setCommentAt(latest.created_at)
            }
          } catch { /* ignore */ }
        }
      }
    }).finally(() => setLoading(false))
  }, [])

  const generateComment = async () => {
    setGenerating(true)
    try {
      const res = await fetch('/api/strategy/proposal', { method: 'POST' })
      const data = await res.json()
      if (data.proposal?.comment) {
        setComment(data.proposal.comment)
        setFocusPoint(data.proposal.focusPoint ?? null)
        setCommentAt(new Date().toISOString())
      }
    } catch { /* ignore */ }
    setGenerating(false)
  }

  const tsumitateMonthly = tsumitate.reduce((s, t) => s + t.monthly_amount, 0)
  const nisaStatus = profile ? getNisaStatus(profile, tsumitateMonthly) : null

  if (loading) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100dvh', color: 'var(--muted)' }}>
      読み込み中...
    </div>
  )

  return (
    <div style={{ maxWidth: 480, margin: '0 auto', padding: '16px 12px 80px' }}>

      {/* ヘッダー */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
        <Link href="/" style={{ color: 'var(--muted)', textDecoration: 'none', fontSize: 20 }}>←</Link>
        <div>
          <div style={{ fontSize: 11, color: 'var(--muted)' }}>マイ株デリック</div>
          <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--accent)' }}>運用状況</div>
        </div>
      </div>

      {/* NISA今年の計画 */}
      {nisaStatus && profile && (
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, padding: '14px 16px', marginBottom: 12 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--muted)', marginBottom: 12 }}>📈 NISA今年の計画</div>

          <NisaBar used={profile.nisa_growth_used} limit={profile.nisa_growth_limit} label="成長枠" />
          <NisaBar used={profile.nisa_tsumitate_used} limit={profile.nisa_tsumitate_limit} label="つみたて枠" />

          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            {nisaStatus.growthRemaining > 0 ? (
              <div style={{ flex: 1, background: 'rgba(99,102,241,0.08)', borderRadius: 10, padding: '10px 12px' }}>
                <div style={{ fontSize: 10, color: 'var(--muted)', marginBottom: 2 }}>成長枠 残枠</div>
                <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--accent)' }}>{toMan(nisaStatus.growthRemaining)}</div>
                <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 2 }}>
                  残{nisaStatus.growthMonthsLeft}ヶ月 ÷ 月{toMan(nisaStatus.growthMonthlyTarget)}
                </div>
              </div>
            ) : (
              <div style={{ flex: 1, background: 'rgba(74,222,128,0.08)', borderRadius: 10, padding: '10px 12px' }}>
                <div style={{ fontSize: 10, color: 'var(--muted)', marginBottom: 2 }}>成長枠</div>
                <div style={{ fontSize: 14, fontWeight: 700, color: '#4ade80' }}>✅ 今年分完了</div>
              </div>
            )}
            <div style={{ flex: 1, background: 'rgba(99,102,241,0.08)', borderRadius: 10, padding: '10px 12px' }}>
              <div style={{ fontSize: 10, color: 'var(--muted)', marginBottom: 2 }}>つみたて枠 残枠</div>
              <div style={{ fontSize: 16, fontWeight: 700, color: nisaStatus.tsumitateRemaining > 0 ? 'var(--accent)' : '#4ade80' }}>
                {nisaStatus.tsumitateRemaining > 0 ? toMan(nisaStatus.tsumitateRemaining) : '✅ 完了'}
              </div>
              <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 2 }}>
                積立{toMan(tsumitateMonthly)}/月 自動消化中
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 銘柄ステータス */}
      {holdings.length > 0 && (
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, padding: '14px 16px', marginBottom: 12 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--muted)', marginBottom: 12 }}>📊 銘柄ステータス</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
            {holdings.map((h, idx) => {
              const rule = ruleMap.get(h.ticker)
              const status = statusLight(h)
              const pct = h.unrealized_gain_pct
              const fund = isFund(h)
              const isLast = idx === holdings.length - 1
              return (
                <div key={h.id} style={{ paddingBottom: isLast ? 0 : 10, marginBottom: isLast ? 0 : 10, borderBottom: isLast ? 'none' : '1px solid var(--border)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 0 }}>
                      <span style={{ fontSize: 15, flexShrink: 0 }}>{status.icon}</span>
                      <div style={{ minWidth: 0 }}>
                        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>{h.name}</span>
                        <span style={{ fontSize: 10, color: 'var(--muted)', marginLeft: 5 }}>{h.ticker}</span>
                      </div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                      {!fund && pct != null && (
                        <span style={{ fontSize: 12, fontWeight: 700, color: pct >= 0 ? '#4ade80' : '#f87171' }}>
                          {pct >= 0 ? '+' : ''}{pct.toFixed(1)}%
                        </span>
                      )}
                      <span style={{ fontSize: 10, color: status.color, fontWeight: 600 }}>{status.label}</span>
                    </div>
                  </div>
                  {rule?.sell_conditions && (
                    <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4, marginLeft: 21, lineHeight: 1.5 }}>
                      {rule.sell_conditions.slice(0, 70)}{rule.sell_conditions.length > 70 ? '…' : ''}
                    </div>
                  )}
                  {!rule?.sell_conditions && fund && (
                    <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4, marginLeft: 21 }}>
                      積立継続・売却条件なし
                    </div>
                  )}
                  {rule?.timeline_notes && (
                    <div style={{ fontSize: 11, color: '#f59e0b', marginTop: 3, marginLeft: 21 }}>
                      ⏰ {rule.timeline_notes.slice(0, 60)}{rule.timeline_notes.length > 60 ? '…' : ''}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* 注文中 */}
      {orders.length > 0 && (
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, padding: '14px 16px', marginBottom: 12 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--muted)', marginBottom: 10 }}>📋 注文中</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {orders.map(o => (
              <div key={o.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <span style={{ fontSize: 13, fontWeight: 600 }}>{o.name}</span>
                  <span style={{ fontSize: 12, color: o.order_type === 'buy' ? '#4ade80' : '#f87171', marginLeft: 8, fontWeight: 600 }}>
                    {o.order_type === 'buy' ? '買' : '売'} {o.price.toLocaleString()}円 × {o.quantity}株
                  </span>
                </div>
                {o.deadline && (
                  <span style={{ fontSize: 11, color: 'var(--muted)' }}>
                    {new Date(o.deadline).toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric' })}まで
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* AI一言 */}
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, padding: '14px 16px', marginBottom: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: comment ? 10 : 0 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--muted)' }}>🤖 AI一言コメント</div>
          <button
            onClick={generateComment}
            disabled={generating}
            style={{
              fontSize: 11, padding: '4px 12px', borderRadius: 6,
              border: `1px solid ${generating ? 'var(--border)' : 'rgba(99,102,241,0.4)'}`,
              background: 'none',
              color: generating ? 'var(--muted)' : 'var(--accent)',
              cursor: generating ? 'not-allowed' : 'pointer',
            }}
          >
            {generating ? '分析中...' : comment ? '更新' : '聞く'}
          </button>
        </div>
        {comment ? (
          <>
            {focusPoint && (
              <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--accent)', marginBottom: 6 }}>
                📍 {focusPoint}
              </div>
            )}
            <div style={{ fontSize: 13, color: 'var(--text)', lineHeight: 1.75 }}>{comment}</div>
            {commentAt && (
              <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 8 }}>
                {new Date(commentAt).toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} 時点
              </div>
            )}
          </>
        ) : !generating ? (
          <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6, lineHeight: 1.6 }}>
            「聞く」で現在の保有状況・ルールをもとにAIが2〜3文でコメントします
          </div>
        ) : null}
        {generating && (
          <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6 }}>
            保有状況・ルールを分析中...
          </div>
        )}
      </div>

      {/* ボトムナビ */}
      <nav style={{ position: 'fixed', bottom: 0, left: 0, right: 0, background: 'var(--surface)', borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'space-around', padding: '10px 0 max(10px, env(safe-area-inset-bottom))' }}>
        {[
          { href: '/', label: 'ホーム', icon: '📊' },
          { href: '/orders', label: '注文', icon: '📋' },
          { href: '/rules', label: 'ルール', icon: '📌' },
          { href: '/strategy', label: '運用', icon: '🧭' },
          { href: '/settings', label: '設定', icon: '⚙️' },
        ].map(item => (
          <Link key={item.href} href={item.href} style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3,
            color: item.href === '/strategy' ? 'var(--accent)' : 'var(--muted)',
            textDecoration: 'none', fontSize: 10, fontWeight: 500, padding: '4px 10px',
          }}>
            <span style={{ fontSize: 20 }}>{item.icon}</span>
            {item.label}
          </Link>
        ))}
      </nav>
    </div>
  )
}
