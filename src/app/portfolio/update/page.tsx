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
  // 複数スクショ分の結果を蓄積
  const [allParsed, setAllParsed] = useState<ParsedHolding[]>([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [roundCount, setRoundCount] = useState(0) // 何枚解析済みか

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = (ev) => {
      const img = new Image()
      img.onerror = () => setError('画像を読み込めませんでした。JPEG/PNG形式でお試しください。')
      img.onload = () => {
        const maxPx = 1200
        const scale = Math.min(1, maxPx / Math.max(img.width, img.height))
        const canvas = document.createElement('canvas')
        canvas.width = Math.round(img.width * scale)
        canvas.height = Math.round(img.height * scale)
        const ctx = canvas.getContext('2d')
        if (!ctx) { setError('画像変換に失敗しました。'); return }
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
        const compressed = canvas.toDataURL('image/jpeg', 0.75)
        setPreview(compressed)
        setImageData(compressed.split(',')[1])
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
      if (!data.holdings || data.holdings.length === 0) throw new Error('銘柄が検出できませんでした。楽天証券の保有一覧画面のスクショをお試しください。')
      // tickerで重複排除して蓄積（後のスクショで上書き）
      setAllParsed(prev => {
        const map = new Map(prev.map(h => [h.ticker, h]))
        for (const h of data.holdings) map.set(h.ticker, h)
        return Array.from(map.values())
      })
      setRoundCount(c => c + 1)
      setPreview(null)
      setImageData(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : '解析に失敗しました。別のスクショで試してください。')
      console.error(e)
    }
    setParsing(false)
  }

  const save = async () => {
    if (!allParsed.length) return
    setSaving(true)
    try {
      const res = await fetch('/api/holdings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ holdings: allParsed }),
      })
      if (!res.ok) throw new Error('保存失敗')
      router.push('/')
    } catch (e) {
      setError('保存に失敗しました。')
      console.error(e)
    }
    setSaving(false)
  }

  const reset = () => {
    setAllParsed([])
    setPreview(null)
    setImageData(null)
    setRoundCount(0)
    setError(null)
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

      {/* 説明 */}
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, padding: 16, marginBottom: 14 }}>
        <div style={{ fontSize: 13, color: 'var(--text)', lineHeight: 1.7 }}>
          楽天証券は<strong>国内株・海外株・投資信託</strong>の画面が別々です。
          それぞれの保有一覧または損益管理画面のスクショを<strong>1枚ずつ</strong>解析して合算できます。
        </div>
      </div>

      {/* 蓄積済みバッジ */}
      {allParsed.length > 0 && (
        <div style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 10, padding: '8px 14px', marginBottom: 12, fontSize: 13, color: 'var(--muted)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>✅ {roundCount}枚解析済み — <strong style={{ color: 'var(--text)' }}>{allParsed.length}銘柄</strong>を取得</span>
          <button onClick={reset} style={{ fontSize: 11, color: 'var(--red)', background: 'none', border: 'none', cursor: 'pointer' }}>最初から</button>
        </div>
      )}

      {/* ファイル選択（解析結果があるときは「次のスクショ」表示） */}
      {!preview && (
        <div style={{ marginBottom: 14 }}>
          <input ref={fileInputRef} type="file" accept="image/*" onChange={handleFile} style={{ display: 'none' }} />
          <button
            onClick={() => fileInputRef.current?.click()}
            style={{ width: '100%', padding: 12, borderRadius: 10, border: '1px dashed var(--border)', background: 'var(--surface)', color: 'var(--muted)', fontSize: 14, cursor: 'pointer' }}
          >
            {allParsed.length > 0 ? '📷 次のスクリーンショットを追加' : '📷 スクリーンショットを選択'}
          </button>
        </div>
      )}

      {/* プレビュー＋解析ボタン */}
      {preview && (
        <div style={{ marginBottom: 14 }}>
          <img src={preview} alt="preview" style={{ width: '100%', borderRadius: 10, border: '1px solid var(--border)', display: 'block', marginBottom: 10 }} />
          <button
            onClick={parse}
            disabled={parsing}
            style={{ width: '100%', padding: 12, borderRadius: 10, border: 'none', background: 'var(--accent)', color: '#fff', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}
          >
            {parsing ? '⏳ AI解析中...' : '🔍 この画像を解析する'}
          </button>
        </div>
      )}

      {error && (
        <div style={{ background: '#3b1515', border: '1px solid #7f1d1d', borderRadius: 10, padding: 12, marginBottom: 14, fontSize: 13, color: '#f87171' }}>
          {error}
        </div>
      )}

      {/* 蓄積された銘柄一覧 */}
      {allParsed.length > 0 && !preview && (
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--muted)', marginBottom: 10 }}>
            解析済み銘柄（{allParsed.length}件）— 内容を確認して保存
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 14 }}>
            {allParsed.map((h, i) => (
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
              {saving ? '保存中...' : `✅ ${allParsed.length}銘柄をDBに保存する`}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
