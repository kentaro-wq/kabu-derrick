'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'

interface Run {
  id: string
  name: string
  started_at: string
  completed_at: string | null
  status: 'running' | 'completed' | 'failed'
  total_candidates: number
  total_signals: number
  hit_rate_5d: number | null
  hit_rate_10d: number | null
  hit_rate_20d: number | null
  avg_return_10d: number | null
  tracked_10d: number
  prompt_version: string | null
  notes: string | null
}

interface Signal {
  id: string
  ticker: string
  name: string
  signal_date: string
  claude_score: number
  claude_fire: boolean
  conditions_met: string[]
  reasoning: string
  risk_factors: string
  price_at_signal: number
  volume_ratio: number | null
  rsi14: number | null
  golden_cross: boolean
  above_ma25: boolean
  above_ma75: boolean
  pct_5d: number | null
  hit_5d: boolean | null
  pct_10d: number | null
  hit_10d: boolean | null
  pct_20d: number | null
  hit_20d: boolean | null
}

function HitRateBadge({ rate, n }: { rate: number | null; n: number }) {
  if (rate == null || n === 0) return <span style={{ color: '#6b7280' }}>—</span>
  const color = rate >= 60 ? '#34d399' : rate >= 40 ? '#fbbf24' : '#f87171'
  return (
    <span style={{ color, fontWeight: 700 }}>
      {rate}%
      <span style={{ color: '#6b7280', fontWeight: 400, fontSize: 11, marginLeft: 4 }}>
        ({n})
      </span>
    </span>
  )
}

function OutcomeChip({ pct, hit }: { pct: number | null; hit: boolean | null }) {
  if (pct == null) return <span style={{ color: '#4b5563', fontSize: 11 }}>—</span>
  const color = hit ? '#34d399' : '#f87171'
  return (
    <span style={{ color, fontSize: 11, fontWeight: 500 }}>
      {pct >= 0 ? '+' : ''}{pct}%
    </span>
  )
}

export default function BacktestPage() {
  const [runs, setRuns] = useState<Run[]>([])
  const [loading, setLoading] = useState(true)
  const [running, setRunning] = useState(false)
  const [runMessage, setRunMessage] = useState<string | null>(null)
  const [selectedRun, setSelectedRun] = useState<string | null>(null)
  const [selectedSignals, setSelectedSignals] = useState<Signal[]>([])
  const [selectedRunData, setSelectedRunData] = useState<Run | null>(null)
  const [signalFilter, setSignalFilter] = useState<'fired' | 'all'>('fired')
  const [expanded, setExpanded] = useState<string | null>(null)

  // 設定パラメータ
  const [sampleSize, setSampleSize] = useState(10)
  const [maxCandidatesPerDay, setMaxCandidatesPerDay] = useState(8)

  async function loadRuns() {
    setLoading(true)
    try {
      const res = await fetch('/api/backtest/runs')
      const d = await res.json()
      setRuns(d.runs ?? [])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadRuns() }, [])

  async function loadRunDetail(runId: string) {
    setSelectedRun(runId)
    setExpanded(null)
    const res = await fetch(`/api/backtest/runs?id=${runId}`)
    const d = await res.json()
    setSelectedRunData(d.run ?? null)
    setSelectedSignals(d.signals ?? [])
  }

  async function handleRun() {
    setRunning(true)
    setRunMessage('実行中... J-Quantsで過去データ取得 → Claude判定中（数分かかる場合があります）')
    try {
      const res = await fetch('/api/backtest/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sampleSize, maxCandidatesPerDay }),
      })
      const d = await res.json()
      if (d.ok) {
        setRunMessage(`完了: ${d.summary.totalCandidates}候補スキャン → ${d.summary.totalSignals}シグナル / 10d打率 ${d.summary.hitRate10d ?? '—'}%`)
        await loadRuns()
        await loadRunDetail(d.runId)
      } else {
        setRunMessage(`失敗: ${d.error ?? '不明'}`)
        await loadRuns()
      }
    } catch (e) {
      setRunMessage(`エラー: ${String(e)}`)
    } finally {
      setRunning(false)
    }
  }

  const filteredSignals = signalFilter === 'fired'
    ? selectedSignals.filter(s => s.claude_fire)
    : selectedSignals

  return (
    <div style={{ minHeight: '100vh', background: '#0f1117', color: '#e5e7eb', padding: 16, maxWidth: 800, margin: '0 auto', fontFamily: 'system-ui, sans-serif' }}>
      {/* ヘッダー */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
        <Link href="/scanner" style={{ color: '#9ca3af', textDecoration: 'none', fontSize: 20 }}>←</Link>
        <h1 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>🔬 バックテスト</h1>
      </div>

      <div style={{ background: '#1a2333', border: '1px solid #2d3148', borderRadius: 8, padding: 10, marginBottom: 16, fontSize: 11, color: '#9ca3af', lineHeight: 1.5 }}>
        過去データで予測精度を高速検証。同じプロンプトを過去N日分で実行 → 5/10/20日後の実データで的中判定。
        プロンプトを変えて再実行すれば打率の変化が見える。
      </div>

      {/* 実行パネル */}
      <div style={{ background: '#1a1d27', borderRadius: 12, padding: 14, marginBottom: 16 }}>
        <div style={{ fontSize: 12, color: '#9ca3af', marginBottom: 10, fontWeight: 600 }}>新規バックテスト実行</div>
        <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
          <label style={{ flex: 1, fontSize: 11, color: '#9ca3af' }}>
            サンプル日数
            <input
              type="number" min={1} max={30} value={sampleSize}
              onChange={e => setSampleSize(Math.max(1, parseInt(e.target.value) || 1))}
              style={{ width: '100%', marginTop: 4, padding: 6, background: '#0f1117', border: '1px solid #374151', borderRadius: 4, color: '#e5e7eb' }}
            />
          </label>
          <label style={{ flex: 1, fontSize: 11, color: '#9ca3af' }}>
            日あたり最大候補数
            <input
              type="number" min={1} max={20} value={maxCandidatesPerDay}
              onChange={e => setMaxCandidatesPerDay(Math.max(1, parseInt(e.target.value) || 1))}
              style={{ width: '100%', marginTop: 4, padding: 6, background: '#0f1117', border: '1px solid #374151', borderRadius: 4, color: '#e5e7eb' }}
            />
          </label>
        </div>
        <div style={{ fontSize: 10, color: '#6b7280', marginBottom: 10 }}>
          総評価数 ≒ {sampleSize * maxCandidatesPerDay}件 / 1回。Claude Haiku使用なので $1未満で完了。
        </div>
        <button
          onClick={handleRun}
          disabled={running}
          style={{
            width: '100%', padding: 12, borderRadius: 8, border: 'none',
            background: running ? '#374151' : '#3b82f6',
            color: 'white', fontSize: 13, fontWeight: 600,
            cursor: running ? 'not-allowed' : 'pointer',
          }}
        >
          {running ? '🔄 実行中...' : '🚀 バックテスト実行'}
        </button>
        {runMessage && (
          <div style={{ marginTop: 10, padding: 8, background: '#0f1a2a', borderRadius: 6, fontSize: 12, color: '#9ca3af' }}>
            {runMessage}
          </div>
        )}
      </div>

      {/* run一覧 */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 12, color: '#9ca3af', marginBottom: 8, fontWeight: 600 }}>実行履歴</div>
        {loading ? (
          <div style={{ color: '#6b7280', textAlign: 'center', padding: 20 }}>読み込み中...</div>
        ) : runs.length === 0 ? (
          <div style={{ color: '#6b7280', textAlign: 'center', padding: 20, fontSize: 13 }}>
            まだバックテストがありません。上のボタンから実行してください。
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {runs.map(r => (
              <div
                key={r.id}
                onClick={() => loadRunDetail(r.id)}
                style={{
                  background: selectedRun === r.id ? '#1a2a3f' : '#1a1d27',
                  border: selectedRun === r.id ? '1px solid #3b82f6' : '1px solid transparent',
                  borderRadius: 8, padding: 10, cursor: 'pointer',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {r.name}
                    </div>
                    <div style={{ fontSize: 10, color: '#6b7280', marginTop: 2 }}>
                      {r.started_at.slice(0, 16).replace('T', ' ')} · {r.prompt_version}
                    </div>
                  </div>
                  {r.status === 'running' && <span style={{ fontSize: 11, color: '#fbbf24' }}>実行中...</span>}
                  {r.status === 'failed' && <span style={{ fontSize: 11, color: '#f87171' }}>失敗</span>}
                  {r.status === 'completed' && (
                    <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                      <div style={{ fontSize: 10, color: '#9ca3af' }}>
                        {r.total_signals}シグナル
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        <div style={{ fontSize: 9, color: '#6b7280' }}>10d打率</div>
                        <HitRateBadge rate={r.hit_rate_10d} n={r.tracked_10d} />
                      </div>
                    </div>
                  )}
                </div>
                {r.status === 'failed' && r.notes && (
                  <div style={{ fontSize: 10, color: '#f87171', marginTop: 6 }}>{r.notes}</div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 選択run詳細 */}
      {selectedRunData && (
        <div style={{ background: '#1a1d27', borderRadius: 12, padding: 14 }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>📊 {selectedRunData.name}</div>

          {/* 打率サマリー */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 8, marginBottom: 14, padding: 10, background: '#0f1117', borderRadius: 8 }}>
            <div>
              <div style={{ fontSize: 9, color: '#6b7280', marginBottom: 2 }}>発火数</div>
              <div style={{ fontSize: 14, fontWeight: 700 }}>{selectedRunData.total_signals}<span style={{ fontSize: 10, color: '#6b7280' }}> / {selectedRunData.total_candidates}</span></div>
            </div>
            <div>
              <div style={{ fontSize: 9, color: '#6b7280', marginBottom: 2 }}>5日後打率</div>
              <HitRateBadge rate={selectedRunData.hit_rate_5d} n={selectedRunData.tracked_10d} />
            </div>
            <div>
              <div style={{ fontSize: 9, color: '#6b7280', marginBottom: 2 }}>10日後打率</div>
              <HitRateBadge rate={selectedRunData.hit_rate_10d} n={selectedRunData.tracked_10d} />
            </div>
            <div>
              <div style={{ fontSize: 9, color: '#6b7280', marginBottom: 2 }}>20日後打率</div>
              <HitRateBadge rate={selectedRunData.hit_rate_20d} n={selectedRunData.tracked_10d} />
            </div>
          </div>
          {selectedRunData.avg_return_10d != null && (
            <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 10 }}>
              発火シグナルの10日後平均リターン: <span style={{ color: selectedRunData.avg_return_10d >= 0 ? '#34d399' : '#f87171', fontWeight: 600 }}>
                {selectedRunData.avg_return_10d >= 0 ? '+' : ''}{selectedRunData.avg_return_10d}%
              </span>
            </div>
          )}

          {/* フィルタタブ */}
          <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
            <button
              onClick={() => setSignalFilter('fired')}
              style={{
                flex: 1, padding: '6px 10px', fontSize: 11, borderRadius: 6, border: 'none', cursor: 'pointer',
                background: signalFilter === 'fired' ? '#3b82f6' : '#0f1117',
                color: signalFilter === 'fired' ? 'white' : '#9ca3af',
              }}
            >🔥 発火のみ ({selectedSignals.filter(s => s.claude_fire).length})</button>
            <button
              onClick={() => setSignalFilter('all')}
              style={{
                flex: 1, padding: '6px 10px', fontSize: 11, borderRadius: 6, border: 'none', cursor: 'pointer',
                background: signalFilter === 'all' ? '#3b82f6' : '#0f1117',
                color: signalFilter === 'all' ? 'white' : '#9ca3af',
              }}
            >全候補 ({selectedSignals.length})</button>
          </div>

          {/* シグナル一覧 */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 500, overflowY: 'auto' }}>
            {filteredSignals.map(s => {
              const isExpanded = expanded === s.id
              return (
                <div
                  key={s.id}
                  onClick={() => setExpanded(isExpanded ? null : s.id)}
                  style={{ background: '#0f1117', borderRadius: 6, padding: 8, cursor: 'pointer' }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{
                      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                      width: 22, height: 22, borderRadius: '50%', fontSize: 11, fontWeight: 700, color: 'white',
                      background: s.claude_score >= 4 ? '#f97316' : s.claude_score === 3 ? '#eab308' : '#6b7280',
                    }}>{s.claude_score}</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12, fontWeight: 600 }}>{s.name}</div>
                      <div style={{ fontSize: 9, color: '#6b7280' }}>
                        {s.ticker} · {s.signal_date} · {s.price_at_signal?.toLocaleString()}円
                      </div>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, alignItems: 'flex-end' }}>
                      <div style={{ display: 'flex', gap: 4, fontSize: 9 }}>
                        <span style={{ color: '#6b7280' }}>5d</span><OutcomeChip pct={s.pct_5d} hit={s.hit_5d} />
                      </div>
                      <div style={{ display: 'flex', gap: 4, fontSize: 9 }}>
                        <span style={{ color: '#6b7280' }}>10d</span><OutcomeChip pct={s.pct_10d} hit={s.hit_10d} />
                      </div>
                      <div style={{ display: 'flex', gap: 4, fontSize: 9 }}>
                        <span style={{ color: '#6b7280' }}>20d</span><OutcomeChip pct={s.pct_20d} hit={s.hit_20d} />
                      </div>
                    </div>
                  </div>
                  {isExpanded && (
                    <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid #374151', fontSize: 11, color: '#9ca3af', lineHeight: 1.5 }}>
                      <div style={{ marginBottom: 4 }}><span style={{ color: '#6b7280' }}>判断: </span>{s.reasoning}</div>
                      {s.risk_factors && s.risk_factors !== '特になし' && (
                        <div style={{ color: '#f87171', marginBottom: 4 }}>⚠️ {s.risk_factors}</div>
                      )}
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 6 }}>
                        {s.conditions_met?.map((c, i) => (
                          <span key={i} style={{ background: '#0f2d1f', color: '#34d399', borderRadius: 3, padding: '1px 5px', fontSize: 9 }}>{c}</span>
                        ))}
                        {s.golden_cross && <span style={{ background: '#1c1a0f', color: '#fbbf24', borderRadius: 3, padding: '1px 5px', fontSize: 9 }}>GC</span>}
                      </div>
                      <div style={{ marginTop: 6, display: 'flex', gap: 10, fontSize: 9 }}>
                        {s.volume_ratio != null && <span>出来高比 {s.volume_ratio}x</span>}
                        {s.rsi14 != null && <span>RSI {s.rsi14}</span>}
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
            {filteredSignals.length === 0 && (
              <div style={{ color: '#6b7280', textAlign: 'center', padding: 16, fontSize: 12 }}>
                該当シグナルなし
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
