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
  period_label: string | null
  date_from: string | null
  date_to: string | null
  trigger: 'manual' | 'cron' | null
}

interface PeriodStat {
  label: string
  runCount: number
  totalSignals: number
  tracked10d: number
  hitRate10d: number | null
  avgReturn10d: number | null
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

interface Sprint {
  id: string
  name: string
  budget_yen: number
  status: 'active' | 'completed' | 'cancelled'
  total_runs: number
  total_candidates: number
  total_fires: number
  total_cost_yen: number
  hit_5d: number; tracked_5d: number
  hit_10d: number; tracked_10d: number
  hit_20d: number; tracked_20d: number
  hit_rate_10d: number | null
  avg_return_10d: number | null
  started_at: string
  completed_at: string | null
}

interface Projection {
  currentHitRate10d: number
  currentMargin: number
  currentTracked: number
  additionalBudgetYen: number
  projectedTracked: number
  projectedMargin: number
  marginImprovement: number
  fireRate: number
  note: string
}

export default function BacktestPage() {
  const [runs, setRuns] = useState<Run[]>([])
  const [periodStats, setPeriodStats] = useState<PeriodStat[]>([])
  const [autoEnabled, setAutoEnabled] = useState<boolean | null>(null)
  const [loading, setLoading] = useState(true)
  const [running, setRunning] = useState(false)
  const [runMessage, setRunMessage] = useState<string | null>(null)
  const [selectedRun, setSelectedRun] = useState<string | null>(null)
  const [selectedSignals, setSelectedSignals] = useState<Signal[]>([])
  const [selectedRunData, setSelectedRunData] = useState<Run | null>(null)
  const [signalFilter, setSignalFilter] = useState<'fired' | 'all'>('fired')
  const [expanded, setExpanded] = useState<string | null>(null)

  // スプリント関連
  const [activeSprint, setActiveSprint] = useState<Sprint | null>(null)
  const [projection, setProjection] = useState<Projection | null>(null)
  const [sprintBudget, setSprintBudget] = useState(600)

  // 設定パラメータ
  const [sampleSize, setSampleSize] = useState(10)
  const [maxCandidatesPerDay, setMaxCandidatesPerDay] = useState(8)

  async function loadRuns() {
    setLoading(true)
    try {
      const [runsRes, autoRes, sprintRes] = await Promise.all([
        fetch('/api/backtest/runs').then(r => r.json()),
        fetch('/api/backtest/auto').then(r => r.json()),
        fetch('/api/backtest/sprint/status').then(r => r.json()),
      ])
      setRuns(runsRes.runs ?? [])
      setPeriodStats(runsRes.periodStats ?? [])
      setAutoEnabled(autoRes.enabled ?? null)
      setActiveSprint(sprintRes.sprint ?? null)
      setProjection(sprintRes.projection ?? null)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadRuns() }, [])

  // アクティブスプリントがあればリアルタイム更新
  useEffect(() => {
    if (activeSprint?.status !== 'active') return
    const interval = setInterval(async () => {
      const res = await fetch(`/api/backtest/sprint/status?id=${activeSprint.id}`)
      const d = await res.json()
      setActiveSprint(d.sprint ?? null)
      setProjection(d.projection ?? null)
      if (d.sprint?.status !== 'active') {
        loadRuns()  // 完了したら全体リロード
      }
    }, 10000)  // 10秒ごと
    return () => clearInterval(interval)
  }, [activeSprint?.id, activeSprint?.status])

  async function startSprint() {
    if (!confirm(`予算 ¥${sprintBudget} でスプリントを開始しますか？\n約${Math.floor(sprintBudget / 0.4)}評価を自動実行します。`)) return
    try {
      const res = await fetch('/api/backtest/sprint/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ budgetYen: sprintBudget }),
      })
      const d = await res.json()
      if (d.ok) {
        setActiveSprint(d.sprint)
      } else {
        alert(d.error ?? 'スプリント開始失敗')
      }
    } catch (e) {
      alert(`エラー: ${String(e)}`)
    }
  }

  async function cancelSprint() {
    if (!activeSprint) return
    if (!confirm('スプリントを停止しますか？（途中までのデータは残ります）')) return
    await fetch('/api/backtest/sprint/status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: activeSprint.id }),
    })
    loadRuns()
  }

  async function handleToggleAuto() {
    if (autoEnabled === null) return
    const next = !autoEnabled
    setAutoEnabled(next)  // 楽観的更新
    try {
      await fetch('/api/backtest/auto', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: next }),
      })
    } catch {
      setAutoEnabled(!next)  // 失敗時ロールバック
    }
  }

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

      <div style={{ background: '#1a2333', border: '1px solid #2d3148', borderRadius: 8, padding: 10, marginBottom: 12, fontSize: 11, color: '#9ca3af', lineHeight: 1.5 }}>
        過去データで予測精度を高速検証。同じプロンプトを過去N日分で実行 → 5/10/20日後の実データで的中判定。
        プロンプトを変えて再実行すれば打率の変化が見える。
      </div>

      {/* 自動実行トグル */}
      <div style={{
        background: autoEnabled ? '#0f2a1f' : '#1a1d27',
        border: '1px solid ' + (autoEnabled ? '#34d399' : '#374151'),
        borderRadius: 10, padding: 12, marginBottom: 12,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button
            onClick={handleToggleAuto}
            disabled={autoEnabled === null}
            style={{
              width: 44, height: 24, borderRadius: 12, border: 'none',
              background: autoEnabled ? '#34d399' : '#4b5563',
              position: 'relative', cursor: 'pointer', flexShrink: 0,
            }}
          >
            <span style={{
              position: 'absolute', top: 3, left: autoEnabled ? 23 : 3,
              width: 18, height: 18, borderRadius: '50%', background: 'white',
              transition: 'left 0.2s',
            }} />
          </button>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: autoEnabled ? '#34d399' : '#9ca3af' }}>
              {autoEnabled ? '🟢 半自動稼働中' : '⚫ 自動実行 停止中'}
            </div>
            <div style={{ fontSize: 10, color: '#6b7280', marginTop: 2 }}>
              毎日 02:00 JST に小サイズ実行（25評価/日）。時代を3パターン日替わりローテーション。
            </div>
          </div>
        </div>
      </div>

      {/* スプリント実行カード */}
      <div style={{
        background: activeSprint?.status === 'active' ? '#1a2333' : '#1a1d27',
        border: activeSprint?.status === 'active' ? '1px solid #3b82f6' : '1px solid #2d3148',
        borderRadius: 12, padding: 14, marginBottom: 12,
      }}>
        <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 10, color: '#60a5fa' }}>
          🚀 集中スプリント — 予算ベースで連続実行
        </div>

        {/* active sprint がある場合の進捗UI */}
        {activeSprint?.status === 'active' ? (
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>{activeSprint.name}</div>
            <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 8 }}>
              実行中... 進捗 ¥{Math.round(activeSprint.total_cost_yen)} / ¥{activeSprint.budget_yen}
            </div>
            {/* プログレスバー */}
            <div style={{ height: 8, background: '#0f1117', borderRadius: 4, overflow: 'hidden', marginBottom: 10 }}>
              <div style={{
                height: '100%',
                width: `${Math.min(100, (activeSprint.total_cost_yen / activeSprint.budget_yen) * 100)}%`,
                background: 'linear-gradient(90deg, #3b82f6, #60a5fa)',
                transition: 'width 0.5s',
              }} />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 6, marginBottom: 10, padding: 8, background: '#0f1117', borderRadius: 6 }}>
              <div>
                <div style={{ fontSize: 9, color: '#6b7280' }}>実行回数</div>
                <div style={{ fontSize: 14, fontWeight: 700 }}>{activeSprint.total_runs}</div>
              </div>
              <div>
                <div style={{ fontSize: 9, color: '#6b7280' }}>評価数</div>
                <div style={{ fontSize: 14, fontWeight: 700 }}>{activeSprint.total_candidates}</div>
              </div>
              <div>
                <div style={{ fontSize: 9, color: '#6b7280' }}>発火数</div>
                <div style={{ fontSize: 14, fontWeight: 700, color: '#f97316' }}>{activeSprint.total_fires}</div>
              </div>
              <div>
                <div style={{ fontSize: 9, color: '#6b7280' }}>追跡済</div>
                <div style={{ fontSize: 14, fontWeight: 700 }}>{activeSprint.tracked_10d}</div>
              </div>
            </div>
            {activeSprint.tracked_10d > 0 && (
              <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 8 }}>
                途中打率（10日後）:{' '}
                <HitRateBadge
                  rate={activeSprint.tracked_10d > 0 ? Math.round((activeSprint.hit_10d / activeSprint.tracked_10d) * 1000) / 10 : null}
                  n={activeSprint.tracked_10d}
                />
              </div>
            )}
            <button
              onClick={cancelSprint}
              style={{
                width: '100%', padding: 8, borderRadius: 6, border: '1px solid #f87171',
                background: 'transparent', color: '#f87171', fontSize: 12, fontWeight: 600,
                cursor: 'pointer',
              }}
            >🛑 停止</button>
          </div>
        ) : (
          /* スプリント開始フォーム */
          <div>
            <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 8, lineHeight: 1.5 }}>
              予算を指定すると、その予算分のバックテストを自動で連続実行します。
              時代をローテーションしながらデータを蓄積します。
            </div>
            <label style={{ display: 'block', fontSize: 11, color: '#9ca3af', marginBottom: 8 }}>
              予算（円）
              <input
                type="number" min={100} max={5000} step={100} value={sprintBudget}
                onChange={e => setSprintBudget(Math.max(100, parseInt(e.target.value) || 100))}
                style={{
                  width: '100%', marginTop: 4, padding: 8, fontSize: 14,
                  background: '#0f1117', border: '1px solid #374151', borderRadius: 4,
                  color: '#e5e7eb',
                }}
              />
            </label>
            <div style={{ fontSize: 10, color: '#6b7280', marginBottom: 10, lineHeight: 1.5 }}>
              ¥{sprintBudget} ≒ {Math.floor(sprintBudget / 0.4)}評価 ≒ {Math.floor(sprintBudget / 0.4 / 25)}runs
              <br />
              所要時間の目安: 約{Math.ceil(Math.floor(sprintBudget / 0.4 / 25) * 0.5)}〜{Math.ceil(Math.floor(sprintBudget / 0.4 / 25))}分
            </div>
            <button
              onClick={startSprint}
              style={{
                width: '100%', padding: 12, borderRadius: 8, border: 'none',
                background: '#3b82f6', color: 'white', fontSize: 13, fontWeight: 600,
                cursor: 'pointer',
              }}
            >🚀 スプリント開始</button>
          </div>
        )}

        {/* 完了スプリントの試算レポート */}
        {activeSprint?.status === 'completed' && projection && (
          <div style={{ marginTop: 12, padding: 12, background: '#0f1a2a', borderRadius: 8 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: '#60a5fa', marginBottom: 8 }}>
              📊 試算レポート
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 11, color: '#d1d5db', lineHeight: 1.6 }}>
              <div>現在の打率: <strong>{projection.currentHitRate10d}% ± {projection.currentMargin}%</strong>（n={projection.currentTracked}）</div>
              <div>発火率: {projection.fireRate}% （評価のうち何%が発火）</div>
              <div style={{ marginTop: 4, padding: 8, background: '#0a0e1a', borderRadius: 4 }}>
                同額 ¥{projection.additionalBudgetYen} 追加投資した場合:
                <br />
                追跡件数 n={projection.currentTracked} → <strong>n={projection.projectedTracked}</strong>
                <br />
                信頼区間 ±{projection.currentMargin}% → <strong>±{projection.projectedMargin}%</strong>
                <span style={{ color: '#34d399', marginLeft: 6 }}>（{projection.marginImprovement}%精度向上）</span>
              </div>
              <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 4 }}>💡 {projection.note}</div>
            </div>
          </div>
        )}
      </div>

      {/* 時代別ダッシュボード */}
      {periodStats.length > 0 && (
        <div style={{ background: '#1a1d27', borderRadius: 12, padding: 12, marginBottom: 12 }}>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8 }}>📅 時代別の10日後打率</div>
          <div style={{ display: 'grid', gridTemplateColumns: `repeat(${periodStats.length}, 1fr)`, gap: 6 }}>
            {periodStats.map(p => (
              <div key={p.label} style={{ background: '#0f1117', borderRadius: 6, padding: 8 }}>
                <div style={{ fontSize: 10, color: '#9ca3af', marginBottom: 4 }}>{p.label}</div>
                <div style={{ fontSize: 16, fontWeight: 700 }}>
                  <HitRateBadge rate={p.hitRate10d} n={p.tracked10d} />
                </div>
                <div style={{ fontSize: 9, color: '#6b7280', marginTop: 2 }}>
                  {p.runCount}回 / {p.totalSignals}発火
                </div>
                {p.avgReturn10d != null && (
                  <div style={{ fontSize: 9, color: p.avgReturn10d >= 0 ? '#34d399' : '#f87171', marginTop: 2 }}>
                    平均 {p.avgReturn10d >= 0 ? '+' : ''}{p.avgReturn10d}%
                  </div>
                )}
              </div>
            ))}
          </div>
          <div style={{ fontSize: 10, color: '#6b7280', marginTop: 6, lineHeight: 1.5 }}>
            時代別に打率が大きく違うなら「時代特有のロジック」が混じっている可能性。同じ条件で安定して当たればロバスト。
          </div>
        </div>
      )}

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
                    <div style={{ fontSize: 10, color: '#6b7280', marginTop: 2, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                      <span>{r.started_at.slice(0, 16).replace('T', ' ')}</span>
                      {r.trigger === 'cron' && <span style={{ background: '#1c2a1f', color: '#34d399', padding: '1px 5px', borderRadius: 3, fontSize: 9 }}>🤖 auto</span>}
                      {r.period_label && <span style={{ background: '#1c1a2a', color: '#a78bfa', padding: '1px 5px', borderRadius: 3, fontSize: 9 }}>{r.period_label}</span>}
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
