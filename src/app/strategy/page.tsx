'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'

interface Proposal {
  headline?: string
  // 新形式
  nisaPoints?: string[]
  tokuteiPoints?: string[]
  riskPoints?: string[]
  urgency?: 'high' | 'medium' | 'low'
  // 旧形式フォールバック
  nisaStrategy?: string
  tokuteiStrategy?: string
  riskNotes?: string
  // 共通
  nextActions?: string[]
}

interface HistoryItem {
  id: string
  created_at: string
  headline: string | null
  nisa_strategy: string | null
  tokutei_strategy: string | null
  next_actions: string[] | null
  risk_notes: string | null
  raw_response: string | null
}

function historyToProposal(item: HistoryItem): Proposal {
  let raw: Proposal = {}
  if (item.raw_response) {
    try { raw = JSON.parse(item.raw_response) } catch { /* ignore */ }
  }
  return {
    headline: item.headline ?? raw.headline,
    nisaPoints: raw.nisaPoints ?? (item.nisa_strategy ? item.nisa_strategy.split('\n').filter(Boolean) : undefined),
    tokuteiPoints: raw.tokuteiPoints ?? (item.tokutei_strategy ? item.tokutei_strategy.split('\n').filter(Boolean) : undefined),
    riskPoints: raw.riskPoints ?? (item.risk_notes ? item.risk_notes.split('\n').filter(Boolean) : undefined),
    nextActions: item.next_actions ?? raw.nextActions ?? [],
    urgency: raw.urgency,
    nisaStrategy: raw.nisaStrategy,
    tokuteiStrategy: raw.tokuteiStrategy,
    riskNotes: raw.riskNotes,
  }
}

function urgencyColor(u?: string) {
  if (u === 'high') return { bg: 'rgba(248,113,113,0.12)', color: '#f87171', label: '🔴 要対応' }
  if (u === 'low') return { bg: 'rgba(52,211,153,0.12)', color: '#34d399', label: '🟢 余裕あり' }
  return { bg: 'rgba(251,191,36,0.12)', color: '#fbbf24', label: '🟡 通常' }
}

function BulletList({ items, color }: { items: string[]; color?: string }) {
  return (
    <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 6 }}>
      {items.map((item, i) => (
        <li key={i} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13, lineHeight: 1.6 }}>
          <span style={{ color: color ?? 'var(--accent)', flexShrink: 0, marginTop: 2 }}>▸</span>
          <span style={{ color: 'var(--text)' }}>{item}</span>
        </li>
      ))}
    </ul>
  )
}

function ActionList({ items }: { items: string[] }) {
  return (
    <ol style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 8 }}>
      {items.map((item, i) => (
        <li key={i} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
          <span style={{
            width: 22, height: 22, borderRadius: '50%',
            background: 'rgba(99,102,241,0.18)', color: 'var(--accent)',
            fontSize: 11, fontWeight: 700, flexShrink: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>{i + 1}</span>
          <span style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--text)', paddingTop: 2 }}>{item}</span>
        </li>
      ))}
    </ol>
  )
}

function ProposalView({ proposal, generatedAt }: { proposal: Proposal; generatedAt?: string }) {
  const urg = urgencyColor(proposal.urgency)
  const nisaItems = proposal.nisaPoints ?? (proposal.nisaStrategy ? [proposal.nisaStrategy] : [])
  const tokuteiItems = proposal.tokuteiPoints ?? (proposal.tokuteiStrategy ? [proposal.tokuteiStrategy] : [])
  const riskItems = proposal.riskPoints ?? (proposal.riskNotes ? [proposal.riskNotes] : [])
  const actions = proposal.nextActions ?? []

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      {/* ヘッドライン + 緊急度 */}
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, padding: '14px 16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          {proposal.urgency && (
            <span style={{ fontSize: 11, fontWeight: 600, color: urg.color, background: urg.bg, padding: '2px 8px', borderRadius: 6 }}>
              {urg.label}
            </span>
          )}
          {generatedAt && (
            <span style={{ fontSize: 10, color: 'var(--muted)', marginLeft: 'auto' }}>
              {new Date(generatedAt).toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
            </span>
          )}
        </div>
        <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--text)', lineHeight: 1.4 }}>
          {proposal.headline}
        </div>
      </div>

      {/* 今週のアクション */}
      {actions.length > 0 && (
        <div style={{ background: 'var(--surface)', border: '1px solid rgba(99,102,241,0.35)', borderRadius: 14, padding: '14px 16px' }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--accent)', marginBottom: 10, display: 'flex', alignItems: 'center', gap: 6 }}>
            ✅ 今週やること
          </div>
          <ActionList items={actions} />
        </div>
      )}

      {/* NISA戦略 */}
      {nisaItems.length > 0 && (
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, padding: '14px 16px' }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--muted)', marginBottom: 10 }}>📈 NISA戦略</div>
          <BulletList items={nisaItems} color="#6366f1" />
        </div>
      )}

      {/* 特定口座 */}
      {tokuteiItems.length > 0 && (
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, padding: '14px 16px' }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--muted)', marginBottom: 10 }}>🏦 特定口座方針</div>
          <BulletList items={tokuteiItems} color="#a78bfa" />
        </div>
      )}

      {/* リスク */}
      {riskItems.length > 0 && (
        <div style={{ background: 'var(--surface)', border: '1px solid rgba(251,191,36,0.3)', borderRadius: 14, padding: '14px 16px' }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#fbbf24', marginBottom: 10 }}>⚠️ リスク・注意点</div>
          <BulletList items={riskItems} color="#fbbf24" />
        </div>
      )}
    </div>
  )
}

export default function StrategyPage() {
  const [proposal, setProposal] = useState<Proposal | null>(null)
  const [generatedAt, setGeneratedAt] = useState<string | undefined>()
  const [loading, setLoading] = useState(false)
  const [initialLoading, setInitialLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // 起動時: 最新の保存済み戦略を表示
  useEffect(() => {
    fetch('/api/strategy/history')
      .then(r => r.json())
      .then(data => {
        if (Array.isArray(data.history) && data.history.length > 0) {
          const latest = data.history[0] as HistoryItem
          setProposal(historyToProposal(latest))
          setGeneratedAt(latest.created_at)
        }
      })
      .catch(() => {})
      .finally(() => setInitialLoading(false))
  }, [])

  const generateProposal = async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/strategy/proposal', { method: 'POST' })
      const data = await res.json()
      if (!res.ok || data.error) {
        setError(data.error ?? '生成に失敗しました。')
      } else if (data.proposal) {
        setProposal(data.proposal as Proposal)
        setGeneratedAt(new Date().toISOString())
      }
    } catch {
      setError('通信エラーが発生しました。')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{ maxWidth: 480, margin: '0 auto', padding: '16px 12px 80px' }}>
      {/* ヘッダー */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Link href="/" style={{ color: 'var(--muted)', textDecoration: 'none', fontSize: 20 }}>←</Link>
          <div>
            <div style={{ fontSize: 11, color: 'var(--muted)' }}>マイ株デリック</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--accent)' }}>戦略提案</div>
          </div>
        </div>
        <button
          onClick={generateProposal}
          disabled={loading}
          style={{
            padding: '8px 14px', borderRadius: 10,
            border: `1px solid ${loading ? 'var(--border)' : 'var(--accent)'}`,
            background: loading ? 'var(--surface2)' : 'rgba(99,102,241,0.12)',
            color: loading ? 'var(--muted)' : 'var(--accent)',
            fontSize: 12, fontWeight: 600, cursor: loading ? 'not-allowed' : 'pointer',
          }}
        >
          {loading ? '生成中...' : proposal ? '🔄 再生成' : '✨ 生成する'}
        </button>
      </div>

      {error && (
        <div style={{ marginBottom: 12, padding: '10px 14px', background: 'rgba(248,113,113,0.1)', border: '1px solid rgba(248,113,113,0.3)', borderRadius: 10, fontSize: 13, color: '#f87171' }}>
          {error}
        </div>
      )}

      {initialLoading && (
        <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--muted)', fontSize: 13 }}>読み込み中...</div>
      )}

      {!initialLoading && !proposal && !loading && (
        <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--muted)' }}>
          <div style={{ fontSize: 36, marginBottom: 12 }}>🧭</div>
          <div style={{ fontSize: 14, marginBottom: 6 }}>戦略提案がまだありません</div>
          <div style={{ fontSize: 12, marginBottom: 20 }}>保有銘柄・NISA残枠をもとにAIが分析します</div>
          <button
            onClick={generateProposal}
            style={{ padding: '10px 24px', borderRadius: 10, border: '1px solid var(--accent)', background: 'rgba(99,102,241,0.12)', color: 'var(--accent)', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}
          >
            ✨ 戦略を生成する
          </button>
        </div>
      )}

      {loading && (
        <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--muted)', fontSize: 13 }}>
          <div style={{ fontSize: 28, marginBottom: 8 }}>🤖</div>
          保有銘柄・NISA状況を分析中...
        </div>
      )}

      {!loading && proposal && (
        <ProposalView proposal={proposal} generatedAt={generatedAt} />
      )}

      <nav style={{ position: 'fixed', bottom: 0, left: 0, right: 0, background: 'var(--surface)', borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'space-around', padding: '10px 0 max(10px, env(safe-area-inset-bottom))' }}>
        {[
          { href: '/', label: 'ホーム', icon: '📊' },
          { href: '/orders', label: '注文', icon: '📋' },
          { href: '/rules', label: 'ルール', icon: '📌' },
          { href: '/strategy', label: '戦略', icon: '🧭' },
          { href: '/settings', label: '設定', icon: '⚙️' },
        ].map(item => (
          <Link key={item.href} href={item.href} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, color: item.href === '/strategy' ? 'var(--accent)' : 'var(--muted)', textDecoration: 'none', fontSize: 10, fontWeight: 500, padding: '4px 10px' }}>
            <span style={{ fontSize: 20 }}>{item.icon}</span>
            {item.label}
          </Link>
        ))}
      </nav>
    </div>
  )
}
