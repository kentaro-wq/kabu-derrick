'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'

interface SignalOutcome {
  pct_5d: number | null
  hit_5d: boolean | null
  pct_10d: number | null
  hit_10d: boolean | null
  pct_20d: number | null
  hit_20d: boolean | null
}

interface Signal {
  id: string
  ticker: string
  name: string
  signal_date: string
  score: number
  conditions_met: string[]
  reasoning: string
  risk_factors: string
  price_at_signal: number
  volume_ratio: number | null
  rsi14: number | null
  golden_cross: boolean
  above_ma25: boolean
  above_ma75: boolean
  per: number | null
  pbr: number | null
  signal_outcomes: SignalOutcome[]
}

interface Stats {
  totalSignals: number
  hitRate5d: number | null
  hitRate10d: number | null
  hitRate20d: number | null
  avgReturn10d: number | null
  tracked: { d5: number; d10: number; d20: number }
}

function ScoreBadge({ score }: { score: number }) {
  const colors: Record<number, string> = {
    5: 'bg-red-500',
    4: 'bg-orange-500',
    3: 'bg-yellow-500',
    2: 'bg-gray-500',
    1: 'bg-gray-600',
  }
  return (
    <span className={`inline-flex items-center justify-center w-7 h-7 rounded-full text-sm font-bold text-white ${colors[score] ?? 'bg-gray-500'}`}>
      {score}
    </span>
  )
}

function OutcomeChip({ pct, hit }: { pct: number | null; hit: boolean | null }) {
  if (pct == null) return <span className="text-gray-500 text-xs">—</span>
  const color = hit ? 'text-emerald-400' : 'text-red-400'
  return <span className={`text-xs font-medium ${color}`}>{pct >= 0 ? '+' : ''}{pct}%</span>
}

function HitRateBadge({ rate, n }: { rate: number | null; n: number }) {
  if (rate == null || n === 0) return <span className="text-gray-500">計測中</span>
  const color = rate >= 60 ? 'text-emerald-400' : rate >= 40 ? 'text-yellow-400' : 'text-red-400'
  return <span className={`font-bold ${color}`}>{rate}% <span className="text-gray-400 font-normal text-xs">({n}件)</span></span>
}

export default function ScannerPage() {
  const [signals, setSignals] = useState<Signal[]>([])
  const [stats, setStats] = useState<Stats | null>(null)
  const [loading, setLoading] = useState(true)
  const [generating, setGenerating] = useState(false)
  const [tracking, setTracking] = useState(false)
  const [genResult, setGenResult] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/signals')
      .then(r => r.json())
      .then(d => { setSignals(d.signals ?? []); setStats(d.stats ?? null) })
      .finally(() => setLoading(false))
  }, [])

  async function handleGenerate() {
    setGenerating(true)
    setGenResult(null)
    try {
      const res = await fetch('/api/signals/generate', { method: 'POST' })
      const d = await res.json()
      if (d.message) {
        setGenResult(d.message)
      } else {
        setGenResult(`スキャン完了: ${d.scanned}銘柄検査 → ${d.signalCount}件のシグナル`)
        // 一覧を再取得
        const r2 = await fetch('/api/signals').then(r => r.json())
        setSignals(r2.signals ?? [])
        setStats(r2.stats ?? null)
      }
    } catch {
      setGenResult('エラーが発生しました')
    } finally {
      setGenerating(false)
    }
  }

  async function handleTrack() {
    setTracking(true)
    try {
      const res = await fetch('/api/signals/track', { method: 'POST' })
      const d = await res.json()
      setGenResult(`結果追跡: ${d.updatedCount}件更新`)
      const r2 = await fetch('/api/signals').then(r => r.json())
      setSignals(r2.signals ?? [])
      setStats(r2.stats ?? null)
    } catch {
      setGenResult('エラーが発生しました')
    } finally {
      setTracking(false)
    }
  }

  return (
    <div style={{ minHeight: '100vh', background: '#0f1117', color: '#e5e7eb', padding: '16px', maxWidth: '430px', margin: '0 auto', fontFamily: 'system-ui, sans-serif' }}>
      {/* ヘッダー */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '20px' }}>
        <Link href="/" style={{ color: '#9ca3af', textDecoration: 'none', fontSize: '20px' }}>←</Link>
        <h1 style={{ fontSize: '18px', fontWeight: 700, margin: 0 }}>📡 シグナルスキャナー</h1>
      </div>

      {/* 打率ダッシュボード */}
      <div style={{ background: '#1a1d27', borderRadius: '12px', padding: '16px', marginBottom: '16px' }}>
        <div style={{ fontSize: '12px', color: '#9ca3af', marginBottom: '8px' }}>打率（的中 = 10日後+5%以上）</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '12px', textAlign: 'center' }}>
          <div>
            <div style={{ fontSize: '11px', color: '#6b7280', marginBottom: '4px' }}>5日後</div>
            <HitRateBadge rate={stats?.hitRate5d ?? null} n={stats?.tracked.d5 ?? 0} />
          </div>
          <div>
            <div style={{ fontSize: '11px', color: '#6b7280', marginBottom: '4px' }}>10日後</div>
            <HitRateBadge rate={stats?.hitRate10d ?? null} n={stats?.tracked.d10 ?? 0} />
          </div>
          <div>
            <div style={{ fontSize: '11px', color: '#6b7280', marginBottom: '4px' }}>20日後</div>
            <HitRateBadge rate={stats?.hitRate20d ?? null} n={stats?.tracked.d20 ?? 0} />
          </div>
        </div>
        {stats?.avgReturn10d != null && (
          <div style={{ marginTop: '10px', fontSize: '12px', color: '#9ca3af', textAlign: 'center' }}>
            10日後平均リターン: <span style={{ color: stats.avgReturn10d >= 0 ? '#34d399' : '#f87171', fontWeight: 600 }}>
              {stats.avgReturn10d >= 0 ? '+' : ''}{stats.avgReturn10d}%
            </span>
            　計{stats.totalSignals}件記録済み
          </div>
        )}
        {!stats?.totalSignals && (
          <div style={{ marginTop: '8px', fontSize: '12px', color: '#6b7280', textAlign: 'center' }}>
            シグナルを生成するとここに打率が表示されます
          </div>
        )}
      </div>

      {/* 操作ボタン */}
      <div style={{ display: 'flex', gap: '8px', marginBottom: '16px' }}>
        <button
          onClick={handleGenerate}
          disabled={generating}
          style={{
            flex: 1, padding: '10px', borderRadius: '8px', border: 'none',
            background: generating ? '#374151' : '#3b82f6',
            color: 'white', fontSize: '13px', fontWeight: 600, cursor: generating ? 'not-allowed' : 'pointer',
          }}
        >
          {generating ? '🔍 スキャン中...' : '🔍 今日のシグナルを生成'}
        </button>
        <button
          onClick={handleTrack}
          disabled={tracking}
          style={{
            padding: '10px 14px', borderRadius: '8px',
            background: tracking ? '#374151' : '#1a1d27',
            color: '#9ca3af', fontSize: '13px', cursor: tracking ? 'not-allowed' : 'pointer',
            border: '1px solid #374151', outline: 'none',
          }}
        >
          {tracking ? '更新中' : '📊 結果を追跡'}
        </button>
      </div>

      {genResult && (
        <div style={{ background: '#1a2a1a', border: '1px solid #374151', borderRadius: '8px', padding: '10px', marginBottom: '12px', fontSize: '13px', color: '#9ca3af' }}>
          {genResult}
        </div>
      )}

      {/* シグナル一覧 */}
      {loading ? (
        <div style={{ textAlign: 'center', color: '#6b7280', padding: '40px' }}>読み込み中...</div>
      ) : signals.length === 0 ? (
        <div style={{ textAlign: 'center', color: '#6b7280', padding: '40px' }}>
          <div style={{ fontSize: '40px', marginBottom: '12px' }}>📡</div>
          <div>まだシグナルがありません</div>
          <div style={{ fontSize: '12px', marginTop: '8px' }}>「今日のシグナルを生成」を押してスキャンを開始してください</div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {signals.map(sig => {
            const outcome = sig.signal_outcomes?.[0]
            const isExpanded = expanded === sig.id
            return (
              <div
                key={sig.id}
                style={{ background: '#1a1d27', borderRadius: '10px', padding: '12px', cursor: 'pointer' }}
                onClick={() => setExpanded(isExpanded ? null : sig.id)}
              >
                {/* 上段 */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <ScoreBadge score={sig.score} />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 600, fontSize: '14px' }}>{sig.name}</div>
                    <div style={{ fontSize: '11px', color: '#6b7280' }}>
                      {sig.ticker} · {sig.signal_date} · {sig.price_at_signal?.toLocaleString()}円
                    </div>
                  </div>
                  {/* 結果チップ */}
                  <div style={{ textAlign: 'right' }}>
                    {outcome ? (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', alignItems: 'flex-end' }}>
                        <div style={{ display: 'flex', gap: '6px', fontSize: '11px', color: '#6b7280' }}>
                          <span>5d</span><OutcomeChip pct={outcome.pct_5d} hit={outcome.hit_5d} />
                        </div>
                        <div style={{ display: 'flex', gap: '6px', fontSize: '11px', color: '#6b7280' }}>
                          <span>10d</span><OutcomeChip pct={outcome.pct_10d} hit={outcome.hit_10d} />
                        </div>
                        <div style={{ display: 'flex', gap: '6px', fontSize: '11px', color: '#6b7280' }}>
                          <span>20d</span><OutcomeChip pct={outcome.pct_20d} hit={outcome.hit_20d} />
                        </div>
                      </div>
                    ) : (
                      <span style={{ fontSize: '11px', color: '#4b5563' }}>追跡待ち</span>
                    )}
                  </div>
                </div>

                {/* 条件バッジ */}
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', marginTop: '8px' }}>
                  {(sig.conditions_met ?? []).map((c, i) => (
                    <span key={i} style={{
                      background: '#0f2d1f', color: '#34d399', borderRadius: '4px',
                      padding: '2px 6px', fontSize: '10px', fontWeight: 500,
                    }}>{c}</span>
                  ))}
                  {sig.golden_cross && <span style={{ background: '#1c1a0f', color: '#fbbf24', borderRadius: '4px', padding: '2px 6px', fontSize: '10px' }}>GC</span>}
                  {sig.above_ma25 && <span style={{ background: '#0f1a2d', color: '#60a5fa', borderRadius: '4px', padding: '2px 6px', fontSize: '10px' }}>MA25↑</span>}
                </div>

                {/* 展開詳細 */}
                {isExpanded && (
                  <div style={{ marginTop: '10px', borderTop: '1px solid #374151', paddingTop: '10px' }}>
                    <div style={{ fontSize: '12px', color: '#d1d5db', lineHeight: 1.6, marginBottom: '8px' }}>
                      <span style={{ color: '#9ca3af' }}>判断: </span>{sig.reasoning}
                    </div>
                    {sig.risk_factors && sig.risk_factors !== '特になし' && (
                      <div style={{ fontSize: '11px', color: '#f87171', lineHeight: 1.5, marginBottom: '8px' }}>
                        ⚠️ {sig.risk_factors}
                      </div>
                    )}
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px', fontSize: '11px', color: '#9ca3af' }}>
                      {sig.volume_ratio != null && <span>出来高比率: {sig.volume_ratio}倍</span>}
                      {sig.rsi14 != null && <span>RSI: {sig.rsi14}</span>}
                      {sig.per != null && <span>PER: {sig.per}倍</span>}
                      {sig.pbr != null && <span>PBR: {sig.pbr}倍</span>}
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* 説明 */}
      <div style={{ marginTop: '24px', padding: '12px', background: '#1a1d27', borderRadius: '8px', fontSize: '11px', color: '#6b7280', lineHeight: 1.6 }}>
        <div style={{ fontWeight: 600, marginBottom: '4px', color: '#9ca3af' }}>スコアの見方</div>
        <div>5: 非常に高確率 / 4: 高確率 / 3以下: 参考程度</div>
        <div style={{ marginTop: '4px' }}>的中基準: 10日後に+5%以上</div>
        <div style={{ marginTop: '4px' }}>毎朝自動スキャン。シグナルが揃わない日は沈黙します。</div>
      </div>
    </div>
  )
}
