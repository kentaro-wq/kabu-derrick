'use client'
import { useState } from 'react'

export interface ExitJudgment {
  id: string
  ticker: string
  name: string
  judgment_date: string
  decision: 'hold' | 'take_profit' | 'cut_loss' | string
  confidence: number | null
  reasoning: string
  current_price: number | null
  price_7d_after: number | null
  price_14d_after: number | null
  pct_7d_after: number | null
  pct_14d_after: number | null
  decision_was_right: boolean | null
}

type DecisionKey = 'hold' | 'take_profit' | 'cut_loss'

const DECISION_META: Record<DecisionKey, { label: string; icon: string; color: string }> = {
  hold:        { label: '継続',     icon: '✓',  color: '#60a5fa' },
  take_profit: { label: '利確推奨', icon: '💰', color: '#34d399' },
  cut_loss:    { label: '損切推奨', icon: '✂️', color: '#f87171' },
}

function pctStr(n: number | null | undefined): string {
  if (n == null) return '—'
  const sign = n >= 0 ? '+' : ''
  return `${sign}${n.toFixed(1)}%`
}

export default function AIAccuracyCard({ judgments }: { judgments: ExitJudgment[] }) {
  const [showWrong, setShowWrong] = useState(false)

  // 評価完了済み（過去30日 + 14日後評価あり）
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 30)
  const cutoffStr = cutoff.toISOString().slice(0, 10)
  const evaluated = judgments.filter(
    j => j.decision_was_right !== null && j.judgment_date >= cutoffStr,
  )

  if (evaluated.length === 0) {
    return (
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 16, padding: 16, marginBottom: 14 }}>
        <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 6 }}>AI判定の的中率（過去30日）</div>
        <div style={{ fontSize: 12, color: 'var(--muted)' }}>
          14日後評価がまだ揃っていません。土曜 09:00 cron で蓄積されます。
        </div>
      </div>
    )
  }

  const total = evaluated.length
  const correct = evaluated.filter(j => j.decision_was_right).length
  const accuracyPct = Math.round((correct / total) * 100)

  // decision 別集計
  const byDecision: Record<DecisionKey, { total: number; correct: number }> = {
    hold:        { total: 0, correct: 0 },
    take_profit: { total: 0, correct: 0 },
    cut_loss:    { total: 0, correct: 0 },
  }
  for (const j of evaluated) {
    const d = j.decision as DecisionKey
    if (!byDecision[d]) continue
    byDecision[d].total++
    if (j.decision_was_right) byDecision[d].correct++
  }

  const wrong = evaluated
    .filter(j => !j.decision_was_right)
    .sort((a, b) => b.judgment_date.localeCompare(a.judgment_date))

  const accuracyColor = accuracyPct >= 70 ? '#34d399' : accuracyPct >= 50 ? '#fbbf24' : '#f87171'

  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 16, padding: 16, marginBottom: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10 }}>
        <div style={{ fontSize: 11, color: 'var(--muted)' }}>AI判定の的中率（過去30日）</div>
        <div style={{ fontSize: 10, color: 'var(--muted)' }}>14日後評価ベース</div>
      </div>

      {/* 全体的中率 */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 4 }}>
        <span style={{ fontSize: 28, fontWeight: 700, color: accuracyColor }}>{accuracyPct}%</span>
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>
          {correct} / {total} 件正解
        </span>
      </div>
      <div style={{ height: 6, background: 'var(--surface2)', borderRadius: 99, overflow: 'hidden', marginBottom: 14 }}>
        <div style={{ height: '100%', width: `${accuracyPct}%`, background: accuracyColor, borderRadius: 99 }} />
      </div>

      {/* decision 別 */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12 }}>
        {(Object.keys(byDecision) as DecisionKey[]).map(key => {
          const meta = DECISION_META[key]
          const s = byDecision[key]
          if (s.total === 0) return null
          const pct = Math.round((s.correct / s.total) * 100)
          return (
            <div key={key}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginBottom: 4 }}>
                <span style={{ color: meta.color, fontWeight: 600 }}>
                  {meta.icon} {meta.label}
                </span>
                <span style={{ color: 'var(--muted)' }}>
                  {s.correct}/{s.total} ({pct}%)
                </span>
              </div>
              <div style={{ height: 4, background: 'var(--surface2)', borderRadius: 99, overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${pct}%`, background: meta.color, borderRadius: 99 }} />
              </div>
            </div>
          )
        })}
      </div>

      {/* 不正解リスト（折りたたみ） */}
      {wrong.length > 0 && (
        <div>
          <button
            onClick={() => setShowWrong(v => !v)}
            style={{
              width: '100%', textAlign: 'left',
              background: 'transparent', border: 'none', cursor: 'pointer',
              fontSize: 11, color: '#f87171', padding: '6px 0',
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            }}
          >
            <span>⚠️ 不正解だった判定 {wrong.length}件</span>
            <span style={{ color: 'var(--muted)' }}>{showWrong ? '閉じる' : '開く'}</span>
          </button>
          {showWrong && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }}>
              {wrong.slice(0, 10).map(j => {
                const meta = DECISION_META[j.decision as DecisionKey] ?? { label: j.decision, icon: '?', color: '#9ca3af' }
                return (
                  <div key={j.id} style={{
                    background: 'var(--surface2)', borderRadius: 8, padding: '8px 10px', fontSize: 11,
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
                      <span style={{ fontWeight: 600 }}>{j.name} <span style={{ color: 'var(--muted)', fontSize: 10 }}>{j.ticker}</span></span>
                      <span style={{ color: 'var(--muted)', fontSize: 10 }}>{j.judgment_date.slice(5)}</span>
                    </div>
                    <div style={{ display: 'flex', gap: 10, alignItems: 'center', fontSize: 10 }}>
                      <span style={{ color: meta.color }}>{meta.icon} {meta.label}</span>
                      <span style={{ color: 'var(--muted)' }}>
                        7d {pctStr(j.pct_7d_after)} / 14d {pctStr(j.pct_14d_after)}
                      </span>
                    </div>
                  </div>
                )
              })}
              {wrong.length > 10 && (
                <div style={{ fontSize: 10, color: 'var(--muted)', textAlign: 'center', padding: 4 }}>
                  ... 他 {wrong.length - 10} 件
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
