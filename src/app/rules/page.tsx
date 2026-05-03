'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import type { Holding } from '@/types'

interface CustomRule { label: string; value: string }

interface HoldingRule {
  id?: string
  ticker: string
  name: string
  purpose: string | null
  policy_basis: string | null
  sell_conditions: string | null
  dividend_notes: string | null
  timeline_notes: string | null
  raw_agreement: string | null
  custom_rules: CustomRule[]
  is_active?: boolean
}

interface CheckResult {
  triggered: { ticker: string; name: string; reason: string }[]
  summary: string
  checkedAt: string
}

const FIXED_FIELDS = [
  { key: 'purpose' as const, label: '購入目的', placeholder: '例: 長期配当収入、NISA成長枠活用で10年保有' },
  { key: 'policy_basis' as const, label: '方針ベース', placeholder: '例: 高配当・連続増配銘柄への長期分散投資方針' },
  { key: 'sell_conditions' as const, label: '売却・利確条件', placeholder: '例: 含み益+30%超、配当利回り3%割れ、減配発表時' },
  { key: 'timeline_notes' as const, label: '期限付きルール', placeholder: '例: 2025年3月末までに株価3500円超なら半分売却' },
  { key: 'dividend_notes' as const, label: '配当メモ', placeholder: '例: 配当利回り4.2%、配当目標1万円/年に貢献' },
  { key: 'raw_agreement' as const, label: 'AIとの取り決め要約', placeholder: 'チャットで合意した内容の要約' },
]

const emptyRule = (ticker: string, name: string): HoldingRule => ({
  ticker, name, purpose: null, policy_basis: null, sell_conditions: null,
  dividend_notes: null, timeline_notes: null, raw_agreement: null, custom_rules: [],
})

export default function RulesPage() {
  const [holdings, setHoldings] = useState<Holding[]>([])
  const [rules, setRules] = useState<HoldingRule[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<string | null>(null) // holding id
  const [draft, setDraft] = useState<HoldingRule>(emptyRule('', ''))
  const [saving, setSaving] = useState(false)
  const [suggesting, setSuggesting] = useState(false)
  const [checking, setChecking] = useState(false)
  const [checkResult, setCheckResult] = useState<CheckResult | null>(null)
  const [extracting, setExtracting] = useState<string | null>(null) // holding id
  const [extractMsg, setExtractMsg] = useState<Record<string, string>>({})
  const [fetchingPrices, setFetchingPrices] = useState(false)
  const [priceResult, setPriceResult] = useState<{ updated: number; failed: string[] } | null>(null)

  useEffect(() => {
    Promise.all([
      fetch('/api/holdings').then(r => r.json()),
      fetch('/api/holding-rules').then(r => r.json()),
    ]).then(([h, r]) => {
      const holdingList: Holding[] = Array.isArray(h) ? h : []
      const ruleList: HoldingRule[] = (Array.isArray(r) ? r : []).map(normalizeRule)
      setHoldings(holdingList)
      setRules(ruleList)
      setLoading(false)

      const ruleSet = new Set(ruleList.map(rule => rule.ticker))
      const noRule = holdingList.filter(hh => !ruleSet.has(hh.ticker))
      if (noRule.length > 0) {
        Promise.all(
          noRule.map(hh =>
            fetch('/api/holding-rules/extract', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ ticker: hh.ticker, name: hh.name }),
            }).then(res => res.json())
          )
        ).then(results => {
          const saved = results.filter(res => res.saved).map(res => normalizeRule(res.rule))
          if (saved.length > 0) {
            setRules(prev => {
              const map = new Map(prev.map(rule => [rule.ticker, rule]))
              saved.forEach(rule => map.set(rule.ticker, rule))
              return Array.from(map.values())
            })
          }
        }).catch(() => {})
      }
    })
  }, [])

  function normalizeRule(r: HoldingRule): HoldingRule {
    return { ...r, custom_rules: Array.isArray(r.custom_rules) ? r.custom_rules : [] }
  }

  const ruleMap = new Map(rules.map(r => [r.ticker, r]))

  const startEdit = (h: Holding) => {
    const existing = ruleMap.get(h.ticker)
    setDraft(existing ? normalizeRule(existing) : emptyRule(h.ticker, h.name))
    setEditing(h.id)
  }
  const cancelEdit = () => { setEditing(null) }

  const saveRule = async () => {
    if (!draft.ticker) return
    setSaving(true)
    const res = await fetch('/api/holding-rules', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(draft),
    })
    const saved = normalizeRule(await res.json())
    setRules(prev => { const m = new Map(prev.map(r => [r.ticker, r])); m.set(saved.ticker, saved); return Array.from(m.values()) })
    setEditing(null)
    setSaving(false)
  }

  const suggestRules = async () => {
    setSuggesting(true)
    try {
      const res = await fetch('/api/holding-rules/suggest', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticker: draft.ticker, name: draft.name }),
      })
      const data = await res.json()
      if (data.suggested) {
        setDraft(prev => ({
          ...prev,
          purpose: data.suggested.purpose ?? prev.purpose,
          policy_basis: data.suggested.policy_basis ?? prev.policy_basis,
          sell_conditions: data.suggested.sell_conditions ?? prev.sell_conditions,
          dividend_notes: data.suggested.dividend_notes ?? prev.dividend_notes,
          timeline_notes: data.suggested.timeline_notes ?? prev.timeline_notes,
          raw_agreement: data.suggested.raw_agreement ?? prev.raw_agreement,
          custom_rules: Array.isArray(data.suggested.custom_rules) ? data.suggested.custom_rules : prev.custom_rules,
        }))
      }
    } catch { /* ignore */ }
    setSuggesting(false)
  }

  const extractFromChat = async (h: Holding, force = false) => {
    setExtracting(h.id)
    setExtractMsg(prev => ({ ...prev, [h.id]: '' }))
    try {
      const res = await fetch('/api/holding-rules/extract', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticker: h.ticker, name: h.name, force }),
      })
      const data = await res.json()
      if (data.saved) {
        setRules(prev => { const m = new Map(prev.map(r => [r.ticker, r])); m.set(data.rule.ticker, normalizeRule(data.rule)); return Array.from(m.values()) })
        setExtractMsg(prev => ({ ...prev, [h.id]: `✅ ${data.sessionCount}件の会話から抽出` }))
      } else {
        setExtractMsg(prev => ({ ...prev, [h.id]: `— ${data.reason ?? '抽出できませんでした'}` }))
      }
    } catch {
      setExtractMsg(prev => ({ ...prev, [h.id]: '⚠️ 抽出失敗' }))
    }
    setExtracting(null)
  }

  const runCheck = async () => {
    setChecking(true); setCheckResult(null)
    try {
      const res = await fetch('/api/holding-rules/check', { method: 'POST' })
      setCheckResult(await res.json())
    } catch {
      setCheckResult({ triggered: [], summary: 'チェック失敗', checkedAt: new Date().toISOString() })
    }
    setChecking(false)
  }

  const fetchPricesAndCheck = async () => {
    setFetchingPrices(true); setPriceResult(null); setCheckResult(null)
    try {
      const res = await fetch('/api/prices', { method: 'POST' })
      const data = await res.json()
      setPriceResult({ updated: data.updated, failed: data.failed ?? [] })
      if (data.ruleCheck) setCheckResult(data.ruleCheck)
      const h = await fetch('/api/holdings').then(r => r.json())
      if (Array.isArray(h)) setHoldings(h)
    } catch { setPriceResult({ updated: 0, failed: [] }) }
    setFetchingPrices(false)
  }

  const addCustomRule = () => setDraft(d => ({ ...d, custom_rules: [...d.custom_rules, { label: '', value: '' }] }))
  const updateCustomRule = (i: number, field: 'label' | 'value', val: string) =>
    setDraft(d => { const cr = [...d.custom_rules]; cr[i] = { ...cr[i], [field]: val }; return { ...d, custom_rules: cr } })
  const removeCustomRule = (i: number) =>
    setDraft(d => ({ ...d, custom_rules: d.custom_rules.filter((_, idx) => idx !== i) }))

  const hasRule = (ticker: string) => {
    const r = ruleMap.get(ticker)
    if (!r) return false
    return FIXED_FIELDS.some(f => r[f.key]) || r.custom_rules.length > 0
  }
  const ruleCount = (ticker: string) => {
    const r = ruleMap.get(ticker)
    if (!r) return 0
    return FIXED_FIELDS.filter(f => r[f.key]).length + r.custom_rules.length
  }

  const taStyle = { width: '100%', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 8, padding: '9px 12px', color: 'var(--text)', fontSize: 13, resize: 'none' as const, outline: 'none', lineHeight: 1.6, boxSizing: 'border-box' as const }
  const inputStyle = { ...taStyle, resize: undefined }

  if (loading) return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100dvh', color: 'var(--muted)' }}>読み込み中...</div>

  return (
    <div style={{ maxWidth: 480, margin: '0 auto', padding: '16px 12px 80px' }}>
      {/* ヘッダー */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Link href="/" style={{ color: 'var(--muted)', textDecoration: 'none', fontSize: 20 }}>←</Link>
          <div>
            <div style={{ fontSize: 11, color: 'var(--muted)' }}>マイ株デリック</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--accent)' }}>銘柄ルール管理</div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button onClick={fetchPricesAndCheck} disabled={fetchingPrices || checking}
            style={{ fontSize: 12, fontWeight: 600, padding: '7px 10px', borderRadius: 8, border: 'none', background: fetchingPrices ? 'var(--surface2)' : '#0f2a1a', color: fetchingPrices ? 'var(--muted)' : '#4ade80', cursor: 'pointer' }}>
            {fetchingPrices ? '⏳' : '📡 株価更新'}
          </button>
          <button onClick={runCheck} disabled={checking || fetchingPrices || rules.length === 0}
            style={{ fontSize: 12, fontWeight: 600, padding: '7px 10px', borderRadius: 8, border: 'none', background: checking ? 'var(--surface2)' : 'rgba(99,102,241,0.8)', color: checking ? 'var(--muted)' : '#fff', cursor: 'pointer' }}>
            {checking ? '⏳' : '🔍 確認'}
          </button>
        </div>
      </div>

      {/* 株価更新結果 */}
      {priceResult && (
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, padding: '8px 12px', marginBottom: 10, fontSize: 12 }}>
          <span style={{ color: 'var(--green)', fontWeight: 600 }}>📡 {priceResult.updated}銘柄の株価を更新</span>
          {priceResult.failed.length > 0 && <span style={{ color: 'var(--muted)', marginLeft: 8 }}>取得失敗: {priceResult.failed.join(', ')}</span>}
        </div>
      )}

      {/* ルールチェック結果 */}
      {checkResult && (
        <div style={{ background: checkResult.triggered.length > 0 ? '#3b1515' : '#0f2a1a', border: `1px solid ${checkResult.triggered.length > 0 ? '#7f1d1d' : '#14532d'}`, borderRadius: 12, padding: 14, marginBottom: 14 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: checkResult.triggered.length > 0 ? '#f87171' : '#4ade80', marginBottom: 8 }}>
            {checkResult.triggered.length > 0 ? `⚡ ${checkResult.triggered.length}件のアクションが必要です` : '✅ 全ルール問題なし'}
          </div>
          {checkResult.triggered.map(t => (
            <div key={t.ticker} style={{ background: 'rgba(0,0,0,0.3)', borderRadius: 8, padding: '10px 12px', marginBottom: 8 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: '#fca5a5', marginBottom: 4 }}>{t.name}（{t.ticker}）</div>
              <div style={{ fontSize: 12, color: '#fca5a5', lineHeight: 1.6 }}>{t.reason}</div>
            </div>
          ))}
          {checkResult.summary && <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>{checkResult.summary}</div>}
        </div>
      )}

      {/* 説明 */}
      <div style={{ background: 'rgba(99,102,241,0.08)', border: '1px solid rgba(99,102,241,0.2)', borderRadius: 10, padding: 10, marginBottom: 14, fontSize: 12, color: 'var(--text)', lineHeight: 1.7 }}>
        📋 各銘柄の運用ルールを記録します。<strong>🤖 AI提案</strong>ボタンで方針・チャット履歴からルールを自動設計、<strong>カスタム項目</strong>で自由に追加できます。
      </div>

      {/* 銘柄一覧 */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {holdings.map(h => {
          const rule = ruleMap.get(h.ticker)
          const isEditing = editing === h.id
          const cnt = ruleCount(h.ticker)
          const triggered = checkResult?.triggered.some(t => t.ticker === h.ticker)

          return (
            <div key={h.id} style={{ background: 'var(--surface)', border: `1px solid ${triggered ? '#ef444466' : 'var(--border)'}`, borderRadius: 14, overflow: 'hidden' }}>
              {/* 銘柄ヘッダー */}
              <div onClick={() => isEditing ? cancelEdit() : startEdit(h)}
                style={{ padding: '12px 14px', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 15, fontWeight: 700 }}>{h.name}</span>
                    <span style={{ fontSize: 11, color: 'var(--muted)' }}>{h.ticker}</span>
                    {triggered && <span style={{ fontSize: 10, color: '#f87171', fontWeight: 600 }}>⚡ 要確認</span>}
                  </div>
                  <div style={{ fontSize: 12, color: (h.unrealized_gain ?? 0) >= 0 ? 'var(--green)' : 'var(--red)', marginTop: 2 }}>
                    {(h.unrealized_gain ?? 0) >= 0 ? '+' : ''}{(h.unrealized_gain ?? 0).toLocaleString()}円
                    {h.unrealized_gain_pct != null && ` (${h.unrealized_gain_pct >= 0 ? '+' : ''}${h.unrealized_gain_pct.toFixed(2)}%)`}
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  {cnt > 0
                    ? <span style={{ fontSize: 10, color: 'var(--accent)', background: 'rgba(99,102,241,0.15)', padding: '2px 8px', borderRadius: 99 }}>{cnt}項目</span>
                    : <span style={{ fontSize: 10, color: 'var(--muted)' }}>未設定</span>
                  }
                  <button onClick={e => { e.stopPropagation(); extractFromChat(h, cnt > 0) }} disabled={extracting === h.id}
                    title="チャット履歴から抽出"
                    style={{ fontSize: 11, padding: '3px 7px', borderRadius: 6, border: '1px solid rgba(245,158,11,0.4)', background: 'none', color: '#f59e0b', cursor: 'pointer' }}>
                    {extracting === h.id ? '⏳' : '📝'}
                  </button>
                  <span style={{ fontSize: 12, color: 'var(--muted)' }}>{isEditing ? '▲' : '▼'}</span>
                </div>
              </div>

              {/* 抽出メッセージ */}
              {extractMsg[h.id] && (
                <div style={{ padding: '5px 14px', fontSize: 11, color: extractMsg[h.id].startsWith('✅') ? 'var(--green)' : 'var(--muted)', borderTop: '1px solid var(--border)', background: 'var(--surface2)' }}>
                  {extractMsg[h.id]}
                </div>
              )}

              {/* 編集フォーム */}
              {isEditing && (
                <div style={{ borderTop: '1px solid var(--border)', padding: 14 }}>
                  {/* AI提案ボタン */}
                  <button onClick={suggestRules} disabled={suggesting}
                    style={{ width: '100%', padding: '10px', marginBottom: 14, borderRadius: 8, border: 'none', background: suggesting ? 'var(--surface2)' : 'rgba(245,158,11,0.15)', color: suggesting ? 'var(--muted)' : '#f59e0b', fontSize: 13, fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
                    {suggesting ? '⏳ AIがルールを設計中...' : '🤖 AIにルールを提案してもらう（方針・チャット履歴から）'}
                  </button>

                  {/* 固定項目 */}
                  {FIXED_FIELDS.map(({ key, label, placeholder }) => (
                    <div key={key} style={{ marginBottom: 10 }}>
                      <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 3 }}>{label}</div>
                      <textarea value={draft[key] ?? ''} onChange={e => setDraft(d => ({ ...d, [key]: e.target.value }))}
                        placeholder={placeholder} rows={key === 'raw_agreement' ? 4 : 2} style={taStyle} />
                    </div>
                  ))}

                  {/* カスタムルール項目 */}
                  <div style={{ marginTop: 14, marginBottom: 10 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--accent)' }}>カスタムルール項目</div>
                      <button onClick={addCustomRule}
                        style={{ fontSize: 11, padding: '4px 10px', borderRadius: 6, border: '1px solid rgba(99,102,241,0.4)', background: 'none', color: 'var(--accent)', cursor: 'pointer' }}>
                        ＋ 追加
                      </button>
                    </div>
                    {draft.custom_rules.length === 0 && (
                      <div style={{ fontSize: 12, color: 'var(--muted)', textAlign: 'center', padding: '10px 0' }}>
                        「＋ 追加」で自由なルール項目を追加できます
                      </div>
                    )}
                    {draft.custom_rules.map((cr, i) => (
                      <div key={i} style={{ background: 'var(--surface2)', borderRadius: 8, padding: 10, marginBottom: 8 }}>
                        <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
                          <input value={cr.label} onChange={e => updateCustomRule(i, 'label', e.target.value)}
                            placeholder="項目名（例: 損切りライン、決算確認ルール）"
                            style={{ ...inputStyle, flex: 1, fontSize: 12 }} />
                          <button onClick={() => removeCustomRule(i)}
                            style={{ padding: '4px 8px', borderRadius: 6, border: '1px solid rgba(248,113,113,0.4)', background: 'none', color: '#f87171', fontSize: 11, cursor: 'pointer' }}>
                            削除
                          </button>
                        </div>
                        <textarea value={cr.value} onChange={e => updateCustomRule(i, 'value', e.target.value)}
                          placeholder="ルール内容" rows={2} style={taStyle} />
                      </div>
                    ))}
                  </div>

                  <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                    <button onClick={saveRule} disabled={saving}
                      style={{ flex: 1, padding: 10, borderRadius: 8, border: 'none', background: 'var(--accent)', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
                      {saving ? '保存中...' : '✅ 保存する'}
                    </button>
                    <button onClick={cancelEdit}
                      style={{ padding: '10px 14px', borderRadius: 8, border: '1px solid var(--border)', background: 'none', color: 'var(--muted)', fontSize: 13, cursor: 'pointer' }}>
                      閉じる
                    </button>
                  </div>
                </div>
              )}

              {/* ルール内容プレビュー */}
              {!isEditing && hasRule(h.ticker) && rule && (
                <div style={{ borderTop: '1px solid var(--border)', padding: '10px 14px', background: 'var(--surface2)' }}>
                  {FIXED_FIELDS.filter(f => rule[f.key]).map(({ key, label }) => (
                    <div key={key} style={{ marginBottom: 5 }}>
                      <span style={{ fontSize: 10, color: 'var(--muted)' }}>{label}　</span>
                      <span style={{ fontSize: 12, color: 'var(--text)', lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{rule[key]}</span>
                    </div>
                  ))}
                  {rule.custom_rules.filter(cr => cr.label || cr.value).map((cr, i) => (
                    <div key={i} style={{ marginBottom: 5 }}>
                      <span style={{ fontSize: 10, color: '#f59e0b' }}>{cr.label}　</span>
                      <span style={{ fontSize: 12, color: 'var(--text)', lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{cr.value}</span>
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
      <nav style={{ position: 'fixed', bottom: 0, left: 0, right: 0, background: 'var(--surface)', borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'space-around', padding: '10px 0 max(10px, env(safe-area-inset-bottom))' }}>
        {[
          { href: '/', label: 'ホーム', icon: '📊' },
          { href: '/orders', label: '注文', icon: '📋' },
          { href: '/rules', label: 'ルール', icon: '📌' },
          { href: '/chat', label: 'AI相談', icon: '💬' },
          { href: '/settings', label: '設定', icon: '⚙️' },
        ].map(item => (
          <Link key={item.href} href={item.href} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, color: item.href === '/rules' ? 'var(--accent)' : 'var(--muted)', textDecoration: 'none', fontSize: 10, fontWeight: 500, padding: '4px 10px' }}>
            <span style={{ fontSize: 20 }}>{item.icon}</span>
            {item.label}
          </Link>
        ))}
      </nav>
    </div>
  )
}
