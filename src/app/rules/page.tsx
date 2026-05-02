'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import type { Holding } from '@/types'

interface HoldingRule {
  id: string
  ticker: string
  name: string
  purpose: string | null
  policy_basis: string | null
  sell_conditions: string | null
  dividend_notes: string | null
  timeline_notes: string | null
  raw_agreement: string | null
  is_active: boolean
}

interface CheckResult {
  triggered: { ticker: string; name: string; reason: string }[]
  summary: string
  checkedAt: string
}

const FIELDS = [
  { key: 'purpose', label: '購入目的', placeholder: '例: 長期配当収入、NISA成長枠活用で10年保有' },
  { key: 'policy_basis', label: '方針ベース', placeholder: '例: 高配当・連続増配銘柄への長期分散投資方針に基づく' },
  { key: 'sell_conditions', label: '売却条件', placeholder: '例: 含み益+30%超、配当利回り3%割れ、減配発表時' },
  { key: 'timeline_notes', label: '期限付きルール', placeholder: '例: 2025年3月末までに株価3500円超なら半分売却' },
  { key: 'dividend_notes', label: '配当メモ', placeholder: '例: 配当利回り4.2%、半期配当あり、配当目標1万円/年に貢献' },
  { key: 'raw_agreement', label: 'AIとの取り決め（原文）', placeholder: 'チャットで決めた内容をここに貼り付け' },
] as const

type FieldKey = typeof FIELDS[number]['key']

export default function RulesPage() {
  const [holdings, setHoldings] = useState<Holding[]>([])
  const [rules, setRules] = useState<HoldingRule[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<string | null>(null) // ticker
  const [draft, setDraft] = useState<Partial<HoldingRule>>({})
  const [saving, setSaving] = useState(false)
  const [checking, setChecking] = useState(false)
  const [checkResult, setCheckResult] = useState<CheckResult | null>(null)
  const [extracting, setExtracting] = useState<string | null>(null) // ticker
  const [extractMsg, setExtractMsg] = useState<Record<string, string>>({})

  useEffect(() => {
    Promise.all([
      fetch('/api/holdings').then(r => r.json()),
      fetch('/api/holding-rules').then(r => r.json()),
    ]).then(([h, r]) => {
      setHoldings(Array.isArray(h) ? h : [])
      setRules(Array.isArray(r) ? r : [])
      setLoading(false)
    })
  }, [])

  const ruleMap = new Map(rules.map(r => [r.ticker, r]))

  const startEdit = (h: Holding) => {
    const existing = ruleMap.get(h.ticker)
    setDraft(existing ?? { ticker: h.ticker, name: h.name })
    setEditing(h.ticker)
  }

  const cancelEdit = () => { setEditing(null); setDraft({}) }

  const saveRule = async () => {
    if (!draft.ticker || !draft.name) return
    setSaving(true)
    const res = await fetch('/api/holding-rules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(draft),
    })
    const saved = await res.json()
    setRules(prev => {
      const filtered = prev.filter(r => r.ticker !== saved.ticker)
      return [...filtered, saved]
    })
    setEditing(null)
    setDraft({})
    setSaving(false)
  }

  const runCheck = async () => {
    setChecking(true)
    setCheckResult(null)
    try {
      const res = await fetch('/api/holding-rules/check', { method: 'POST' })
      const data = await res.json()
      setCheckResult(data)
    } catch {
      setCheckResult({ triggered: [], summary: 'チェック失敗', checkedAt: new Date().toISOString() })
    }
    setChecking(false)
  }

  const extractFromChat = async (h: Holding, force = false) => {
    setExtracting(h.ticker)
    setExtractMsg(prev => ({ ...prev, [h.ticker]: '' }))
    try {
      const res = await fetch('/api/holding-rules/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticker: h.ticker, name: h.name, force }),
      })
      const data = await res.json()
      if (data.saved) {
        setRules(prev => {
          const filtered = prev.filter(r => r.ticker !== data.rule.ticker)
          return [...filtered, data.rule]
        })
        setExtractMsg(prev => ({ ...prev, [h.ticker]: `✅ ${data.sessionCount}件の会話から抽出しました` }))
      } else {
        setExtractMsg(prev => ({ ...prev, [h.ticker]: `— ${data.reason ?? '抽出できませんでした'}` }))
      }
    } catch {
      setExtractMsg(prev => ({ ...prev, [h.ticker]: '⚠️ 抽出失敗' }))
    }
    setExtracting(null)
  }

  const hasRule = (ticker: string) => ruleMap.has(ticker) &&
    Object.values(ruleMap.get(ticker)!).some(v => v && typeof v === 'string' && v.length > 0)

  if (loading) {
    return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100dvh', color: 'var(--muted)' }}>読み込み中...</div>
  }

  return (
    <div style={{ maxWidth: 480, margin: '0 auto', padding: '16px 12px 80px' }}>
      {/* ヘッダー */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Link href="/" style={{ color: 'var(--muted)', textDecoration: 'none', fontSize: 20 }}>←</Link>
          <div>
            <div style={{ fontSize: 11, color: 'var(--muted)' }}>マイ株デリック</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--accent)' }}>銘柄ルール管理</div>
          </div>
        </div>
        <button
          onClick={runCheck}
          disabled={checking || rules.length === 0}
          style={{
            fontSize: 12, fontWeight: 600, padding: '7px 12px', borderRadius: 8, border: 'none',
            background: checking ? 'var(--surface2)' : 'rgba(99,102,241,0.8)',
            color: checking ? 'var(--muted)' : '#fff', cursor: 'pointer',
          }}
        >
          {checking ? '⏳ 判定中...' : '🔍 今すぐ確認'}
        </button>
      </div>

      {/* チェック結果 */}
      {checkResult && (
        <div style={{
          background: checkResult.triggered.length > 0 ? '#3b1515' : '#0f2a1a',
          border: `1px solid ${checkResult.triggered.length > 0 ? '#7f1d1d' : '#14532d'}`,
          borderRadius: 12, padding: 14, marginBottom: 16,
        }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: checkResult.triggered.length > 0 ? '#f87171' : '#4ade80', marginBottom: 8 }}>
            {checkResult.triggered.length > 0 ? `⚡ ${checkResult.triggered.length}件のアクションが必要です` : '✅ 全ルール問題なし'}
          </div>
          {checkResult.triggered.map(t => (
            <div key={t.ticker} style={{ background: 'rgba(0,0,0,0.3)', borderRadius: 8, padding: '10px 12px', marginBottom: 8 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: '#fca5a5', marginBottom: 4 }}>{t.name}（{t.ticker}）</div>
              <div style={{ fontSize: 12, color: '#fca5a5', lineHeight: 1.6 }}>{t.reason}</div>
            </div>
          ))}
          {checkResult.summary && (
            <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>{checkResult.summary}</div>
          )}
        </div>
      )}

      {/* ルール説明 */}
      <div style={{ background: 'rgba(99,102,241,0.08)', border: '1px solid rgba(99,102,241,0.2)', borderRadius: 12, padding: 12, marginBottom: 16 }}>
        <div style={{ fontSize: 12, color: 'var(--text)', lineHeight: 1.7 }}>
          📋 各銘柄の<strong>購入目的・売却条件・期限ルール</strong>をここに記録します。<br />
          「今すぐ確認」でAIが現在の株価・損益とルールを照合し、<strong>条件に該当する場合はLINE通知</strong>します。
        </div>
      </div>

      {/* 銘柄一覧 */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {holdings.map(h => {
          const rule = ruleMap.get(h.ticker)
          const isEditing = editing === h.ticker
          const ruleCount = rule ? FIELDS.filter(f => rule[f.key]).length : 0
          const gain = h.unrealized_gain ?? 0
          const triggered = checkResult?.triggered.some(t => t.ticker === h.ticker)

          return (
            <div key={h.ticker} style={{
              background: 'var(--surface)', border: `1px solid ${triggered ? '#ef444466' : 'var(--border)'}`,
              borderRadius: 14, overflow: 'hidden',
            }}>
              {/* 銘柄ヘッダー */}
              <div
                onClick={() => isEditing ? cancelEdit() : startEdit(h)}
                style={{ padding: '14px 16px', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
              >
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 15, fontWeight: 700 }}>{h.name}</span>
                    <span style={{ fontSize: 11, color: 'var(--muted)' }}>{h.ticker}</span>
                    {triggered && <span style={{ fontSize: 10, color: '#f87171', fontWeight: 600 }}>⚡ 要確認</span>}
                  </div>
                  <div style={{ fontSize: 12, color: gain >= 0 ? 'var(--green)' : 'var(--red)', marginTop: 3 }}>
                    {gain >= 0 ? '+' : ''}{gain.toLocaleString()}円
                    {h.unrealized_gain_pct != null && ` (${h.unrealized_gain_pct >= 0 ? '+' : ''}${h.unrealized_gain_pct.toFixed(2)}%)`}
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  {ruleCount > 0
                    ? <span style={{ fontSize: 10, color: 'var(--accent)', background: 'rgba(99,102,241,0.15)', padding: '2px 8px', borderRadius: 99 }}>{ruleCount}項目設定済</span>
                    : <span style={{ fontSize: 10, color: 'var(--muted)' }}>未設定</span>
                  }
                  <button
                    onClick={e => { e.stopPropagation(); extractFromChat(h, ruleCount > 0) }}
                    disabled={extracting === h.ticker}
                    title="チャット履歴からルールを自動抽出"
                    style={{ fontSize: 11, padding: '3px 7px', borderRadius: 6, border: '1px solid rgba(245,158,11,0.4)', background: 'none', color: '#f59e0b', cursor: 'pointer', flexShrink: 0 }}
                  >
                    {extracting === h.ticker ? '⏳' : '📝'}
                  </button>
                  <span style={{ fontSize: 12, color: 'var(--muted)' }}>{isEditing ? '▲' : '▼'}</span>
                </div>
              </div>

              {/* 編集フォーム */}
              {isEditing && (
                <div style={{ borderTop: '1px solid var(--border)', padding: 16 }}>
                  {FIELDS.map(({ key, label, placeholder }) => (
                    <div key={key} style={{ marginBottom: 12 }}>
                      <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 4 }}>{label}</div>
                      <textarea
                        value={(draft[key] as string) ?? ''}
                        onChange={e => setDraft(d => ({ ...d, [key]: e.target.value }))}
                        placeholder={placeholder}
                        rows={key === 'raw_agreement' ? 5 : 2}
                        style={{
                          width: '100%', background: 'var(--surface2)', border: '1px solid var(--border)',
                          borderRadius: 8, padding: '9px 12px', color: 'var(--text)', fontSize: 13,
                          resize: 'none', outline: 'none', lineHeight: 1.6, boxSizing: 'border-box',
                        }}
                      />
                    </div>
                  ))}
                  <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                    <button
                      onClick={saveRule}
                      disabled={saving}
                      style={{ flex: 1, padding: 10, borderRadius: 8, border: 'none', background: 'var(--accent)', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}
                    >
                      {saving ? '保存中...' : '✅ 保存する'}
                    </button>
                    <button
                      onClick={cancelEdit}
                      style={{ padding: '10px 14px', borderRadius: 8, border: '1px solid var(--border)', background: 'none', color: 'var(--muted)', fontSize: 13, cursor: 'pointer' }}
                    >
                      閉じる
                    </button>
                  </div>
                </div>
              )}

              {/* 抽出結果メッセージ */}
              {extractMsg[h.ticker] && (
                <div style={{ padding: '6px 16px', fontSize: 11, color: extractMsg[h.ticker].startsWith('✅') ? 'var(--green)' : 'var(--muted)', borderTop: '1px solid var(--border)', background: 'var(--surface2)' }}>
                  {extractMsg[h.ticker]}
                </div>
              )}

              {/* ルール内容プレビュー（編集中でない場合） */}
              {!isEditing && hasRule(h.ticker) && (
                <div style={{ borderTop: '1px solid var(--border)', padding: '10px 16px', background: 'var(--surface2)' }}>
                  {FIELDS.filter(f => rule?.[f.key]).map(({ key, label }) => (
                    <div key={key} style={{ marginBottom: 6 }}>
                      <span style={{ fontSize: 10, color: 'var(--muted)' }}>{label}　</span>
                      <span style={{ fontSize: 12, color: 'var(--text)', lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{rule![key]}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {holdings.length === 0 && (
        <div style={{ textAlign: 'center', color: 'var(--muted)', fontSize: 13, padding: '40px 0' }}>
          保有銘柄がありません。<br />
          <Link href="/portfolio/update" style={{ color: 'var(--accent)' }}>ポートフォリオを更新</Link>してください。
        </div>
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
            color: item.href === '/rules' ? 'var(--accent)' : 'var(--muted)', textDecoration: 'none', fontSize: 10, fontWeight: 500,
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
