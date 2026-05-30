/**
 * AI判定の自己改善ジョブ
 *
 * 目的:
 * 過去の exit-judgment の判定結果 (decision_was_right) を Claude に渡し、
 * 「不正解パターンの原因分析」「次回の改善案」「正解パターンの強化」を
 * lessons として蓄積する。月次で実行され、AI 判定の継続的精度向上に
 * フィードバックする。
 *
 * フロー:
 *  1. 14日後評価が完了した判定 (decision_was_right IS NOT NULL) を取得
 *  2. 不正解判定をパターン別に集計 (decision × segment × indicators)
 *  3. 正解判定もサンプル取得
 *  4. Claude haiku に分析依頼 → JSON で改善 lessons を返させる
 *  5. reflection_lessons テーブルに source_label='exit_judgment' で蓄積
 *  6. LINE で月次サマリーに添える
 */
import { NextResponse } from 'next/server'
import { adminSupabase } from '@/lib/supabase'
import { sendLineMessage } from '@/lib/line'
import { EVAL_CRITERIA_TEXT } from '@/lib/judgment-eval'
import Anthropic from '@anthropic-ai/sdk'

export const maxDuration = 60

const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

interface Lesson {
  category: 'avoid' | 'context' | 'prefer'
  principle: string
  evidence: string
}

export async function POST() {
  // 過去90日の評価済み判定を取得
  const ninetyDaysAgo = new Date()
  ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90)
  const since = ninetyDaysAgo.toISOString().slice(0, 10)

  const { data: judgments } = await adminSupabase
    .from('exit_judgments')
    .select('id, ticker, name, judgment_date, decision, strategy, confidence, reasoning, risk_factors, unrealized_gain_pct, pct_7d_after, pct_14d_after, pct_at_horizon, eval_horizon_days, decision_was_right, rsi14, ma5, ma25, volume_ratio, account_type')
    .gte('judgment_date', since)
    .not('decision_was_right', 'is', null)
    .order('judgment_date', { ascending: false })

  if (!judgments || judgments.length < 5) {
    return NextResponse.json({
      message: `評価済み判定 ${judgments?.length ?? 0} 件。最低5件必要のためスキップ`,
      count: judgments?.length ?? 0,
    })
  }

  const total = judgments.length
  const wrong = judgments.filter(j => !j.decision_was_right)
  const right = judgments.filter(j => j.decision_was_right)
  const accuracy = (right.length / total) * 100

  // パターン別集計
  const byDecision: Record<string, { total: number; correct: number }> = {}
  for (const j of judgments) {
    const d = j.decision as string
    if (!byDecision[d]) byDecision[d] = { total: 0, correct: 0 }
    byDecision[d].total++
    if (j.decision_was_right) byDecision[d].correct++
  }

  // 不正解サンプル (最大20件) と正解サンプル (最大10件) を抜粋
  const wrongSamples = wrong.slice(0, 20).map(j => ({
    ticker: j.ticker,
    name: j.name,
    date: j.judgment_date,
    decision: j.decision,
    strategy: j.strategy,
    reasoning: typeof j.reasoning === 'string' ? j.reasoning.slice(0, 100) : '',
    gainPct: j.unrealized_gain_pct,
    horizonDays: j.eval_horizon_days,
    pctAtHorizon: j.pct_at_horizon,
    rsi14: j.rsi14,
    ma5: j.ma5,
    ma25: j.ma25,
    volRatio: j.volume_ratio,
    account: j.account_type,
  }))
  const rightSamples = right.slice(0, 10).map(j => ({
    ticker: j.ticker,
    name: j.name,
    date: j.judgment_date,
    decision: j.decision,
    strategy: j.strategy,
    gainPct: j.unrealized_gain_pct,
    horizonDays: j.eval_horizon_days,
    pctAtHorizon: j.pct_at_horizon,
  }))

  const prompt = `あなたは AI 出口判定システムの自己改善担当です。
過去の判定実績を分析し、次回以降の判定精度を上げるための lessons を抽出してください。

【全体統計】
- 評価済み判定: ${total}件
- 正解率: ${accuracy.toFixed(1)}%
- 判定種別ごと:
${Object.entries(byDecision).map(([d, s]) =>
  `  - ${d}: ${s.correct}/${s.total} (${((s.correct/s.total)*100).toFixed(0)}%)`).join('\n')}

【不正解判定 (最大20件)】
${JSON.stringify(wrongSamples, null, 2)}

【正解判定 (最大10件)】
${JSON.stringify(rightSamples, null, 2)}

判定正解基準:
${EVAL_CRITERIA_TEXT}

抽出すべき lessons の種類:
- avoid: 「こういう状況で X 判定したら間違える」パターン (不正解の原因)
- context: 「判断時に追加で確認すべき文脈」 (見落とされていた要因)
- prefer: 「こういう状況で X 判定すると正解しやすい」パターン (強化すべき)

【利益最大化の観点】
- NISA 銘柄の hold が多い場合: 機会コストを意識しているか
- cut_loss が機会損失パターンになっていないか (損切後に大きく上昇)
- take_profit が早すぎていないか (利確後にさらに上昇)

JSON のみで回答:
{
  "lessons": [
    { "category": "avoid"|"context"|"prefer", "principle": "原則 (50字以内)", "evidence": "根拠 (100字以内、銘柄・数値を含める)" }
  ],
  "overall_assessment": "全体評価 (100字以内、正解率の解釈と次回方針)",
  "priority_action": "次回の最優先改善アクション (50字以内)"
}

lessons は 3〜5 件、重要度順に。`

  let lessons: Lesson[] = []
  let overall = ''
  let priority = ''
  try {
    const res = await claude.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1500,
      messages: [{ role: 'user', content: prompt }],
    })
    const text = res.content[0].type === 'text' ? res.content[0].text : ''
    const m = text.match(/\{[\s\S]*\}/)
    if (m) {
      const parsed = JSON.parse(m[0])
      lessons = parsed.lessons ?? []
      overall = parsed.overall_assessment ?? ''
      priority = parsed.priority_action ?? ''
    }
  } catch (e) {
    console.error('[reflect] AI error:', e)
    return NextResponse.json({ error: 'AI analysis failed', detail: String(e) }, { status: 500 })
  }

  if (lessons.length === 0) {
    return NextResponse.json({ message: 'AI が lessons を返さず', count: total })
  }

  // reflection_lessons に蓄積
  await adminSupabase.from('reflection_lessons').insert({
    lessons,
    source_label: `exit_judgment_reflection_${new Date().toISOString().slice(0, 10)}_n${total}`,
  })

  // LINE 通知
  const today = new Date().toLocaleDateString('ja-JP', { month: 'long', day: 'numeric' })
  let msg = `🔄 マイ株デリック AI判定 自己改善レポート ${today}\n\n`
  msg += `【全体評価】\n総数 ${total}件 / 正解率 ${accuracy.toFixed(1)}%\n${overall}\n\n`
  msg += `【次回の最優先アクション】\n${priority}\n\n`
  msg += `【主な lessons】\n`
  for (const l of lessons.slice(0, 3)) {
    const icon = l.category === 'avoid' ? '🚫' : l.category === 'prefer' ? '⭐' : '💡'
    msg += `${icon} ${l.principle}\n  根拠: ${l.evidence}\n\n`
  }
  msg += `※詳細は reflection_lessons テーブル参照`
  await sendLineMessage(msg).catch(() => {})

  return NextResponse.json({
    ok: true,
    total,
    accuracy: Math.round(accuracy * 10) / 10,
    byDecision,
    lessonsCount: lessons.length,
    lessons,
    overall,
    priority,
  })
}

export async function GET() {
  return POST()
}
