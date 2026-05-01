'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import type { Profile } from '@/types'

export default function SettingsPage() {
  const [profile, setProfile] = useState<Profile | null>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [notifying, setNotifying] = useState(false)
  const [notifyResult, setNotifyResult] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/profile').then(r => r.json()).then(d => { if (d?.id) setProfile(d) })
  }, [])

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
