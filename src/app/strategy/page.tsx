'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import type { StrategyProposal } from '@/types'

interface StrategyHistoryItem extends StrategyProposal {
  id: string
  created_at: string
}

export default function StrategyPage() {
  const [proposal, setProposal] = useState<StrategyProposal | null>(null)
  const [history, setHistory] = useState<StrategyHistoryItem[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadHistory = async () => {
    try {
      const res = await fetch('/api/strategy/history')
      const data = await res.json()
      if (Array.isArray(data.history)) {
        setHistory(data.history)
      }
    } catch {
      // 履歴取得失敗は非致命
    }
  }

  useEffect(() => {
    const fetchHistory = async () => {
      try {
        const res = await fetch('/api/strategy/history')
        const data = await res.json()
        if (Array.isArray(data.history)) {
          setHistory(data.history)
        }
      } catch {
        // 履歴取得失敗は非致命
      }
    }

    void fetchHistory()
  }, [])

  const generateProposal = async () => {
    setLoading(true)
    setError(null)
    setProposal(null)

    try {
      const res = await fetch('/api/strategy/proposal', { method: 'POST' })
      const data = await res.json()
      if (!res.ok || data.error) {
        setError(data.error ?? '戦略提案の生成に失敗しました。')
      } else if (data.proposal) {
        setProposal(data.proposal as StrategyProposal)
        loadHistory()
      } else {
        setError('不明な応答を受け取りました。')
      }
    } catch {
      setError('通信エラーが発生しました。')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{ maxWidth: 480, margin: '0 auto', padding: '16px 12px 80px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20 }}>
        <Link href="/" style={{ color: 'var(--muted)', textDecoration: 'none', fontSize: 20 }}>←</Link>
        <div>
          <div style={{ fontSize: 11, color: 'var(--muted)' }}>マイ株デリック</div>
          <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--accent)' }}>戦略提案</div>
        </div>
      </div>

      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 16, padding: 16, marginBottom: 14 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)', marginBottom: 8 }}>現在値・NISA状況を踏まえたAI提案</div>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 12, lineHeight: 1.6 }}>
          保有銘柄と現在のNISA残枠をもとに、今取るべき投資戦略を提案します。
        </div>
        <button onClick={generateProposal} disabled={loading} style={{ width: '100%', padding: 12, borderRadius: 10, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text)', fontSize: 14, cursor: 'pointer' }}>
          {loading ? '生成中...' : '戦略提案を生成する'}
        </button>
        {error && <div style={{ marginTop: 12, fontSize: 13, color: '#f87171', textAlign: 'center' }}>{error}</div>}
      </div>

      {proposal && (
        <div style={{ display: 'grid', gap: 14, marginBottom: 14 }}>
          <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, padding: 16 }}>
            <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 10 }}>{proposal.headline}</div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 12 }}>AIが生成した戦略の概要です。</div>
            <div style={{ fontSize: 13, lineHeight: 1.7, whiteSpace: 'pre-wrap' }}>{proposal.nisaStrategy}</div>
          </div>
          <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, padding: 16 }}>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>特定口座補完戦略</div>
            <div style={{ fontSize: 13, lineHeight: 1.7, whiteSpace: 'pre-wrap' }}>{proposal.tokuteiStrategy}</div>
          </div>
          <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, padding: 16 }}>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>次のアクション</div>
            <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.7 }}>
              {proposal.nextActions.map((item, index) => (
                <li key={index}>{item}</li>
              ))}
            </ul>
          </div>
          <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, padding: 16 }}>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>リスク注意点</div>
            <div style={{ fontSize: 13, lineHeight: 1.7, whiteSpace: 'pre-wrap' }}>{proposal.riskNotes}</div>
          </div>
        </div>
      )}

      {history.length > 0 && (
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, padding: 16, marginBottom: 14 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)', marginBottom: 10 }}>最新の戦略履歴</div>
          {history.slice(0, 2).map(item => (
            <div key={item.id} style={{ marginBottom: 12, paddingBottom: 12, borderBottom: '1px solid var(--border)' }}>
              <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 6 }}>{new Date(item.created_at).toLocaleString('ja-JP')}</div>
              <div style={{ fontSize: 13, lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{item.headline}</div>
            </div>
          ))}
          {history.length > 2 && (
            <div style={{ textAlign: 'right' }}>
              <Link href="/strategy" style={{ fontSize: 12, color: 'var(--accent)', textDecoration: 'none' }}>履歴をもっと見る</Link>
            </div>
          )}
        </div>
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
