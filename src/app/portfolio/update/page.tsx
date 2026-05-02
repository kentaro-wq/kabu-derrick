'use client'
import { useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'

interface ParsedHolding {
  name: string
  ticker: string
  account_type: string
  quantity: number | null
  current_price: number | null
  purchase_price: number | null
  evaluation_amount: number | null
  unrealized_gain: number | null
  unrealized_gain_pct: number | null
}

function accountLabel(type: string) {
  if (type === 'nisa_growth') return 'NISA成長'
  if (type === 'nisa_tsumitate') return 'つみたて'
  if (type === 'tokutei') return '特定'
  if (type === 'dc') return 'DC'
  return type
}

function fmt(n: number | null) {
  if (n == null) return '—'
  return n.toLocaleString() + '円'
}

export default function PortfolioUpdatePage() {
  const router = useRouter()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [imageData, setImageData] = useState<string | null>(null)
  const [parsing, setParsing] = useState(false)
  const [parsed, setParsed] = useState<ParsedHolding[] | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = (ev) => {
      const img = new Image()
      img.onload = () => {
        const maxPx = 1600
        const scale = Math.min(1, maxPx / Math.max(img.width, img.height))
        const canvas = document.createElement('canvas')
        canvas.width = Math.round(img.width * scale)
        canvas.height = Math.round(img.height * scale)
        canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height)
        const compressed = canvas.toDataURL('image/jpeg', 0.9)
        setPreview(compressed)
        setImageData(compressed.split(',')[1])
        setParsed(null)
        setError(null)
      }
      img.src = ev.target?.result as string
    }
    reader.readAsDataURL(file)
    e.target.value = ''
  }

  const parse = async () => {
    if (!imageData) return
    setParsing(true)
    setError(null)
    try {
      const res = await fetch('/api/portfolio/parse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageData, imageType: 'image/jpeg' }),
      })
      const data = await res.json()
      if (data.error) throw new Error(data.error)
      setParsed(data.holdings ?? [])
    } catch (e) {
      setError('解析に失敗しました。別のスクショで試してください。')
      console.error(e)
    }
    setParsing(false)
  }

  const save = async () => {
    if (!parsed) return
    setSaving(true)
    try {
      const res = await fetch('/api/holdings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ holdings: parsed }),
      })
      if (!res.ok) throw new Error('保存失敗')
      router.push('/')
    } catch (e) {
      setError('保存に失敗しました。')
      console.error(e)
    }
    setSaving(false)
  }

  return (
    <div style={{ maxWidth: 480, margin: '0 auto', padding: '16px 12px 40px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20 }}>
        <Link href="/" style={{ color: 'var(--muted)', textDecoration: 'none', fontSize: 20 }}>←</Link>
        <div>
          <div style={{ fontSize: 11, color: 'var(--muted)' }}>マイ株デリック</div>
          <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--accent)' }}>ポートフォリオ更新</div>
        </div>
      </div>

      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, padding: 16, marginBottom: 14 }}>
        <div style={{ fontSize: 13, color: 'var(--text)', lineHeight: 1.7, marginBottom: 14 }}>
          楽天証券の<strong>保有銘柄一覧</strong>または<strong>損益管理</strong>画面のスクリーンショットを選択してください。AIが自動で銘柄情報を読み取ります。
        </div>
        <input ref={fileInputRef} type="file" accept="image/*" onChange={handleFile} style={{ display: 'none' }} />
        <button
          onClick={() => fileInputRef.current?.click()}
          style={{ width: '100%', padding: 12, borderRadius: 10, border: '1px dashed var(--border)', background: 'var(--surface2)', color: 'var(--muted)', fontSize: 14, cursor: 'pointer' }}
        >
          📷 スクリーンショットを選択
        </button>
      </div>

      {preview && (
        <div style={{ marginBottom: 14 }}>
          <img src={preview} alt="preview" style={{ width: '100%', borderRadius: 10, border: '1px solid var(--border)', display: 'block', marginBottom: 10 }} />
          {!parsed && (
            <button
              onClick={parse}
              disabled={parsing}
              style={{ width: '100%', padding: 12, borderRadius: 10, border: 'none', background: 'var(--accent)', color: '#fff', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}
            >
              {parsing ? '⏳ AI解析中...' : '🔍 この画像を解析する'}
            </button>
          )}
        </div>
      )}

      {error && (
        <div style={{ background: '#3b1515', border: '1px solid #7f1d1d', borderRadius: 10, padding: 12, marginBottom: 14, fontSize: 13, color: '#f87171' }}>
          {error}
        </div>
      )}

      {parsed && (
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--muted)', marginBottom: 10 }}>
            解析結果（{parsed.length}銘柄）— 内容を確認して保存
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 14 }}>
            {parsed.map((h, i) => (
              <div key={i} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                  <div>
                    <span style={{ fontSize: 14, fontWeight: 600 }}>{h.name}</span>
                    <span style={{ fontSize: 11, color: 'var(--muted)', marginLeft: 6 }}>{h.ticker}</span>
                  </div>
                  <span style={{ fontSize: 10, padding: '2px 7px', borderRadius: 99, background: 'var(--surface2)', color: 'var(--muted)' }}>
                    {accountLabel(h.account_type)}
                  </span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                  <span style={{ color: 'var(--muted)' }}>評価額 {fmt(h.evaluation_amount)}</span>
                  <span style={{ color: (h.unrealized_gain ?? 0) >= 0 ? 'var(--green)' : 'var(--red)' }}>
                    {h.unrealized_gain != null ? (h.unrealized_gain >= 0 ? '+' : '') + h.unrealized_gain.toLocaleString() + '円' : '—'}
                  </span>
                </div>
              </div>
            ))}
          </div>

          <div style={{ display: 'flex', gap: 8 }}>
            <button
              onClick={save}
              disabled={saving}
              style={{ flex: 1, padding: 12, borderRadius: 10, border: 'none', background: 'var(--accent)', color: '#fff', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}
            >
              {saving ? '保存中...' : '✅ この内容で更新する'}
            </button>
            <button
              onClick={() => { setParsed(null); setPreview(null); setImageData(null) }}
              style={{ padding: '12px 16px', borderRadius: 10, border: '1px solid var(--border)', background: 'none', color: 'var(--muted)', fontSize: 13, cursor: 'pointer' }}
            >
              やり直す
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
