'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import type { Profile } from '@/types'

interface TsumitateItem {
  id: string
  name: string
  monthly_amount: number
  account_type: string
}

const TSUMITATE_EMPTY = { name: '', monthly_amount: '', account_type: 'nisa_tsumitate' }

export default function SettingsPage() {
  const [profile, setProfile] = useState<Profile | null>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [notifying, setNotifying] = useState(false)
  const [notifyResult, setNotifyResult] = useState<string | null>(null)
  const [tsumitate, setTsumitate] = useState<TsumitateItem[]>([])
  const [tsForm, setTsForm] = useState(TSUMITATE_EMPTY)
  const [tsAdding, setTsAdding] = useState(false)
  const [tsShowForm, setTsShowForm] = useState(false)

  useEffect(() => {
    fetch('/api/profile').then(r => r.json()).then(d => { if (d?.id) setProfile(d) })
    fetch('/api/tsumitate').then(r => r.json()).then(d => setTsumitate(d.settings ?? []))
  }, [])

  const addTsumitate = async () => {
    if (!tsForm.name.trim() || !tsForm.monthly_amount) return
    setTsAdding(true)
    await fetch('/api/tsumitate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: tsForm.name.trim(), monthly_amount: Number(tsForm.monthly_amount), account_type: tsForm.account_type }),
    })
    const d = await fetch('/api/tsumitate').then(r => r.json())
    setTsumitate(d.settings ?? [])
    setTsForm(TSUMITATE_EMPTY)
    setTsShowForm(false)
    setTsAdding(false)
  }

  const deleteTsumitate = async (id: string) => {
    await fetch(`/api/tsumitate?id=${id}`, { method: 'DELETE' })
    setTsumitate(prev => prev.filter(t => t.id !== id))
  }

  const save = async () => {
    if (!profile) return
    setSaving(true)
    await fetch('/api/profile', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(profile) })
    setSaving(false)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  const testNotify = async () => {
    setNotifying(true)
    setNotifyResult(null)
    const res = await fetch('/api/notify', { method: 'POST', headers: { Authorization: `Bearer ${process.env.NEXT_PUBLIC_APP_SECRET ?? ''}` } })
    const data = await res.json()
    setNotifyResult(data.success ? '✅ LINE送信成功' : '❌ 送信失敗（LINE設定を確認）')
    setNotifying(false)
  }

  if (!profile) return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100dvh', color: 'var(--muted)' }}>読み込み中...</div>

  const totalAssets = (profile.bank_balance ?? 0) + (profile.dc_balance ?? 0)
  const progressPct = Math.min(100, Math.round((totalAssets / profile.target_amount) * 100))

  return (
    <div style={{ maxWidth: 480, margin: '0 auto', padding: '16px 12px 80px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20 }}>
        <Link href="/" style={{ color: 'var(--muted)', textDecoration: 'none', fontSize: 20 }}>←</Link>
        <div>
          <div style={{ fontSize: 11, color: 'var(--muted)' }}>マイ株デリック</div>
          <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--accent)' }}>設定・資産情報</div>
        </div>
      </div>

      {/* 資産・目標 */}
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, padding: 16, marginBottom: 14 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)', marginBottom: 12 }}>資産・目標設定</div>
        {[
          { label: '銀行預金（円）', key: 'bank_balance' },
          { label: 'DC残高（円）', key: 'dc_balance' },
          { label: '目標資産（円）', key: 'target_amount' },
          { label: '教育費確保枠（円）', key: 'education_reserve' },
          { label: '手元現金確保（円）', key: 'cash_reserve' },
          { label: 'NISA成長枠・利用済（円）', key: 'nisa_growth_used' },
          { label: 'NISA成長枠・上限（円）', key: 'nisa_growth_limit' },
        ].map(({ label, key }) => (
          <div key={key} style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 4 }}>{label}</div>
            <input
              type="number"
              value={profile[key as keyof Profile] as number ?? 0}
              onChange={e => setProfile(p => p ? { ...p, [key]: Number(e.target.value) } : p)}
              style={{ width: '100%', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 8, padding: '9px 12px', color: 'var(--text)', fontSize: 14, outline: 'none' }}
            />
          </div>
        ))}
        <button onClick={save} disabled={saving} style={{ width: '100%', padding: 12, borderRadius: 10, border: 'none', background: saved ? '#1a3a2a' : 'var(--accent)', color: '#fff', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>
          {saved ? '✓ 保存しました' : saving ? '保存中...' : '保存する'}
        </button>
      </div>

      {/* NISA積立設定 */}
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, padding: 16, marginBottom: 14 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)' }}>NISA積立設定</div>
          <button onClick={() => setTsShowForm(!tsShowForm)} style={{ fontSize: 11, padding: '4px 10px', borderRadius: 6, border: 'none', background: tsShowForm ? 'var(--surface2)' : 'var(--accent)', color: tsShowForm ? 'var(--muted)' : '#fff', cursor: 'pointer' }}>
            {tsShowForm ? 'キャンセル' : '＋ 追加'}
          </button>
        </div>

        {tsumitate.length === 0 && !tsShowForm && (
          <div style={{ fontSize: 12, color: 'var(--muted)', textAlign: 'center', padding: '10px 0' }}>積立設定なし</div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: tsShowForm ? 12 : 0 }}>
          {tsumitate.map(t => (
            <div key={t.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--surface2)', borderRadius: 8, padding: '10px 12px' }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{t.name}</div>
                <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
                  {t.account_type === 'nisa_tsumitate' ? 'つみたて' : t.account_type === 'nisa_growth' ? 'NISA成長' : t.account_type} ・ 月 {t.monthly_amount.toLocaleString()}円
                </div>
              </div>
              <button onClick={() => deleteTsumitate(t.id)} style={{ fontSize: 11, color: '#f87171', background: 'none', border: '1px solid rgba(248,113,113,0.4)', borderRadius: 6, padding: '4px 8px', cursor: 'pointer' }}>削除</button>
            </div>
          ))}
        </div>

        {tsShowForm && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, borderTop: tsumitate.length > 0 ? '1px solid var(--border)' : 'none', paddingTop: tsumitate.length > 0 ? 12 : 0 }}>
            <div>
              <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 4 }}>ファンド名 *</div>
              <input value={tsForm.name} onChange={e => setTsForm(f => ({ ...f, name: e.target.value }))} placeholder="例: eMAXIS Slim 全世界株式" style={{ width: '100%', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 8, padding: '9px 12px', color: 'var(--text)', fontSize: 14, outline: 'none', boxSizing: 'border-box' }} />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <div>
                <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 4 }}>月額（円）*</div>
                <input type="number" value={tsForm.monthly_amount} onChange={e => setTsForm(f => ({ ...f, monthly_amount: e.target.value }))} placeholder="30000" style={{ width: '100%', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 8, padding: '9px 12px', color: 'var(--text)', fontSize: 14, outline: 'none', boxSizing: 'border-box' }} />
              </div>
              <div>
                <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 4 }}>口座</div>
                <select value={tsForm.account_type} onChange={e => setTsForm(f => ({ ...f, account_type: e.target.value }))} style={{ width: '100%', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 8, padding: '9px 12px', color: 'var(--text)', fontSize: 14, outline: 'none', boxSizing: 'border-box' }}>
                  <option value="nisa_tsumitate">つみたて</option>
                  <option value="nisa_growth">NISA成長</option>
                </select>
              </div>
            </div>
            <button onClick={addTsumitate} disabled={tsAdding || !tsForm.name.trim() || !tsForm.monthly_amount} style={{ width: '100%', padding: 10, borderRadius: 8, border: 'none', background: 'var(--accent)', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer', opacity: !tsForm.name.trim() || !tsForm.monthly_amount ? 0.5 : 1 }}>
              {tsAdding ? '追加中...' : '追加する'}
            </button>
          </div>
        )}
      </div>

      {/* LINE通知テスト */}
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, padding: 16, marginBottom: 14 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)', marginBottom: 8 }}>LINE通知</div>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 12, lineHeight: 1.6 }}>
          環境変数に LINE_CHANNEL_ACCESS_TOKEN と LINE_USER_ID を設定してください。
        </div>
        <button onClick={testNotify} disabled={notifying} style={{ width: '100%', padding: 12, borderRadius: 10, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text)', fontSize: 14, cursor: 'pointer' }}>
          {notifying ? '送信中...' : 'テスト通知を送る'}
        </button>
        {notifyResult && <div style={{ marginTop: 8, fontSize: 13, color: notifyResult.startsWith('✅') ? 'var(--green)' : 'var(--red)', textAlign: 'center' }}>{notifyResult}</div>}
      </div>

      {/* 3000万円進捗 */}
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, padding: 16 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)', marginBottom: 10 }}>目標進捗（預金＋DC）</div>
        <div style={{ fontSize: 24, fontWeight: 700, marginBottom: 6 }}>{totalAssets.toLocaleString()}円</div>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 10 }}>目標: {profile.target_amount.toLocaleString()}円 ({progressPct}%)</div>
        <div style={{ height: 8, background: 'var(--surface2)', borderRadius: 99, overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${progressPct}%`, background: 'var(--accent)', borderRadius: 99 }} />
        </div>
      </div>

      {/* ボトムナビ */}
      <nav style={{ position: 'fixed', bottom: 0, left: 0, right: 0, background: 'var(--surface)', borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'space-around', padding: '10px 0 max(10px, env(safe-area-inset-bottom))' }}>
        {[
          { href: '/', label: 'ホーム', icon: '📊' },
          { href: '/orders', label: '注文', icon: '📋' },
          { href: '/chat', label: 'AI相談', icon: '💬' },
          { href: '/settings', label: '設定', icon: '⚙️' },
        ].map(item => (
          <Link key={item.href} href={item.href} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, color: item.href === '/settings' ? 'var(--accent)' : 'var(--muted)', textDecoration: 'none', fontSize: 10, fontWeight: 500, padding: '4px 16px' }}>
            <span style={{ fontSize: 20 }}>{item.icon}</span>
            {item.label}
          </Link>
        ))}
      </nav>
    </div>
  )
}
