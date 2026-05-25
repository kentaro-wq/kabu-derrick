/**
 * 出口判定システム (セグメントベース戦略 + AI コンテキスト判断)
 *
 * 流れ:
 * 1. 保有銘柄ごとに「価格帯×ボラ」セグメント判定
 * 2. セグメントに応じた最適出口戦略を自動選択
 * 3. 戦略の機械的トリガーをチェック (利確/損切/トレーリング/連続陰線)
 * 4. トリガー有り → AI が文脈判断で最終決定 (継続/売却)
 * 5. トリガー無し → 継続保持
 *
 * バックテスト分析結果に基づくセグメント別戦略:
 *  - 中位×中ボラ (黄金): +15利確 / -8損切 → 平均+12.8%, 勝率97.7%
 *  - 中位×低ボラ: 固定20日 → 平均+3.7%
 *  - 高位: トレーリング-10% → 平均+7.2%
 *  - 低位×低ボラ: 連続陰線で売り (F戦略) → 平均+5.8%
 */
import { NextResponse } from 'next/server'
import { adminSupabase } from '@/lib/supabase'
import { fetchOHLCVHistoryCached, getIdToken, isJQuantsConfigured } from '@/lib/jquants'
import {
  classifySegment, calcVolatility, checkStrategyTrigger,
  strategyLabel, type ExitStrategy,
} from '@/lib/segment'
import { calcIndicators } from '@/lib/technicals'
import { sendLineMessage, formatExitJudgmentAlert } from '@/lib/line'
import Anthropic from '@anthropic-ai/sdk'

export const maxDuration = 60

const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

interface Holding {
  id: string
  ticker: string
  name: string
  account_type: string
  quantity: number
  purchase_price: number
  current_price: number | null
  unrealized_gain_pct: number | null
  created_at: string
}

interface AIOverride {
  decision: 'hold' | 'take_profit' | 'cut_loss'
  confidence: number
  reasoning: string
}

/** NISA成長枠コンテキスト */
interface NisaContext {
  isNisa: boolean
  monthsLeftInYear: number
  slotRemainingYen: number
  slotUsedPct: number
}

/** AI 確認プロンプト
 *  triggerType に応じてプロンプトを変える:
 *   - 'cut_loss': 損切確認（簡素）
 *   - 'pattern' (adaptive AI exit): 「伸ばすか確定か」を熟考
 *   - その他: 標準
 */
async function askAIForConfirmation(
  h: Holding,
  segmentLabel: string,
  strategy: ExitStrategy,
  triggerReason: string,
  triggerType: string | undefined,
  gainPct: number,
  daysHeld: number,
  indicators: {
    rsi14: number | null
    volumeRatio: number | null
    ma5: number | null
    ma25: number | null
    todayChangePct: number | null
    consecutiveUp: number
  },
  nisa: NisaContext,
): Promise<AIOverride> {
  const current = Number(h.current_price)
  const techSummary = [
    indicators.rsi14 != null ? `RSI(14): ${indicators.rsi14}` : '',
    indicators.volumeRatio != null ? `出来高比率: ${indicators.volumeRatio}倍` : '',
    indicators.ma5 ? `MA5: ${indicators.ma5}円 (現値${current >= indicators.ma5 ? '上' : '下'})` : '',
    indicators.ma25 ? `MA25: ${indicators.ma25}円 (現値${current >= indicators.ma25 ? '上' : '下'})` : '',
    indicators.todayChangePct != null ? `当日: ${indicators.todayChangePct >= 0 ? '+' : ''}${indicators.todayChangePct}%` : '',
    indicators.consecutiveUp >= 2 ? `連続陽線: ${indicators.consecutiveUp}日` : '',
  ].filter(Boolean).join(', ')

  // adaptive AI exit の含み益判定（最重要シーン）
  const isProfitJudgment = triggerType === 'pattern' && gainPct >= 5

  // NISA成長枠の特殊制約セクション
  const nisaBlock = nisa.isNisa
    ? `\n【🟢 NISA成長枠の制約】
この銘柄は NISA成長枠 で保有しています。重要な税制ルール:
- 売却すると今年の枠は復活しない（年間 240万円中、現在 ${nisa.slotUsedPct}% 使用済み、残 ${(nisa.slotRemainingYen/10000).toFixed(0)}万円）
- 今年残り ${nisa.monthsLeftInYear}ヶ月
- 売却の機会コスト: 売ると今年は新規投資の NISA優遇が縮小、特定口座(20%課税)での投資になる
- ${nisa.monthsLeftInYear >= 6 ? '⚠️ 今年残り月数が多い → 売却の機会コスト大' : nisa.monthsLeftInYear >= 3 ? '中庸: 売却は通常通り判断' : '✓ 年末近い → 売却の機会コスト小、来年新枠で買い直し可能'}
- 含み益確定 (キャピタルゲイン非課税) のメリットと、上記機会コストのトレードオフを考慮してください\n`
    : (h.account_type === 'tokutei' ? '\n【特定口座】売却益に約20%の税金。NISA制約はなし\n' : '')

  const prompt = isProfitJudgment
    ? `あなたは「上がる銘柄を最後まで持ち続ける」哲学のトレーダーです。
含み益が出ている保有銘柄について、今売るか持ち続けるかを判断してください。

【保有】${h.name}(${h.ticker})
取得 ${h.purchase_price}円 × ${h.quantity}株
現在 ${current}円 → 含み益 ${gainPct.toFixed(1)}%
保有 ${daysHeld}日

【テクニカル】
${techSummary}
${nisaBlock}
---
判断指針:

**hold（持ち続ける）にすべき場面:**
- 上昇モメンタム継続中（MA5・MA25 上向き、終値もそれら以上）
- 連続陽線、出来高伴う上昇
- RSI 70未満で過熱ではない
- トレンドがまだ生きている
- ${nisa.isNisa && nisa.monthsLeftInYear >= 6 ? 'NISA枠の機会コストが大きい時期、よほど明確な利確サインでない限り持続' : ''}

**take_profit（利確する）にすべき場面:**
- 上昇モメンタムが死んだ兆候（MA5 下抜け、連続陰線）
- RSI 75以上の極度の過熱
- 出来高ピーク疑い + 当日陰線
- 数日間横ばい・反落、エネルギー切れ

哲学:
- 含み益が大きいほど、「もっと伸ばす」を優先する
- でも、明らかに勢いが死んだら即確定
- 中途半端な判断は禁物。「伸ばす確信」or「確定の確信」のどちらか。
- ${nisa.isNisa ? 'NISA保有なら、特に年初/年央は売却の機会コストを意識せよ' : ''}

JSON のみで回答:
{
  "decision": "hold" | "take_profit",
  "confidence": 1-5,
  "reasoning": "判断理由（モメンタムと文脈、NISA制約があれば言及、2-3文）"
}`
    : `保有株の売却タイミング最終確認です。

【保有】${h.name}(${h.ticker})
取得 ${h.purchase_price}円 × ${h.quantity}株
現在 ${current}円 (含み益 ${gainPct.toFixed(1)}%)
保有 ${daysHeld}日
【テクニカル】${techSummary}

【セグメント】${segmentLabel}
【推奨戦略】${strategyLabel(strategy)}
【発動した売却トリガー】${triggerReason}

文脈で見て売らない方が良い場合もあります。
JSON のみで回答:
{
  "decision": "take_profit" | "cut_loss" | "hold",
  "confidence": 1-5,
  "reasoning": "判断理由 (1-2文)"
}`

  try {
    const res = await claude.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      messages: [{ role: 'user', content: prompt }],
    })
    const text = res.content[0].type === 'text' ? res.content[0].text : ''
    const m = text.match(/\{[\s\S]*\}/)
    if (!m) return { decision: gainPct >= 0 ? 'take_profit' : 'cut_loss', confidence: 1, reasoning: 'AI応答なし、機械判断採用' }
    return JSON.parse(m[0]) as AIOverride
  } catch (e) {
    console.error('[exit-judgment] AI error:', e)
    return { decision: gainPct >= 0 ? 'take_profit' : 'cut_loss', confidence: 1, reasoning: 'AIエラー、機械判断採用' }
  }
}

export async function POST() {
  if (!isJQuantsConfigured) {
    return NextResponse.json({ error: 'JQUANTS未設定' }, { status: 503 })
  }
  const today = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10)

  const { data: holdingsRaw } = await adminSupabase.from('holdings').select('*')

  // 出口判定の対象は「自由に売買できる口座」のみ
  // - nisa_growth: 売買自由、利確の税優遇あり
  // - tokutei: 通常の課税口座、自由
  // 除外対象:
  // - mochikabu: 持株会、移管手続き必要で即売却不可、奨励金制度あり
  // - dc: DC・iDeCo、引出制限あり
  // - nisa_tsumitate / old_tsumitate: 長期保有前提
  const tradableAccounts = new Set(['nisa_growth', 'tokutei'])
  const holdings = (holdingsRaw ?? []).filter((h: Holding) =>
    /^\d{4}$/.test(h.ticker) && tradableAccounts.has(h.account_type)
  ) as Holding[]

  if (holdings.length === 0) return NextResponse.json({ message: '対象保有銘柄なし', count: 0 })

  const idToken = await getIdToken()
  if (!idToken) return NextResponse.json({ error: 'jquants auth failed' }, { status: 503 })

  // NISA 成長枠の状況を取得
  const { data: profile } = await adminSupabase.from('profile').select('*').single()
  const nisaUsed = Number(profile?.nisa_growth_used ?? 0)
  const nisaLimit = Number(profile?.nisa_growth_limit ?? 2400000)
  const nisaSlotRemaining = Math.max(0, nisaLimit - nisaUsed)
  const nisaSlotUsedPct = Math.round((nisaUsed / nisaLimit) * 100)
  const monthsLeftInYear = Math.max(0, 12 - new Date().getMonth() - 1)

  const results: Array<{
    ticker: string; name: string; segment: string; strategy: string;
    decision: string; reasoning: string; gainPct: number;
  }> = []

  for (const h of holdings) {
    if (!h.current_price || !h.purchase_price) continue

    const { data: existing } = await adminSupabase
      .from('exit_judgments').select('id')
      .eq('ticker', h.ticker).eq('judgment_date', today).limit(1)
    if (existing && existing.length > 0) continue

    const bars = await fetchOHLCVHistoryCached(h.ticker, 60, idToken)
    if (bars.length < 25) continue

    const pastBars = bars.slice(-20)
    const vol = calcVolatility(pastBars)
    const segment = classifySegment(Number(h.current_price), vol)

    const daysHeld = Math.floor((Date.now() - new Date(h.created_at).getTime()) / 86400000)
    const entry = Number(h.purchase_price)
    const current = Number(h.current_price)
    const gainPct = (current - entry) / entry * 100

    const sinceBars = bars.slice(Math.max(0, bars.length - daysHeld - 1))
    const peakSinceEntry = Math.max(entry, ...sinceBars.map(b => b.high))

    // AI 判定に渡すテクニカル指標
    const ind = calcIndicators(bars)

    const trigger = checkStrategyTrigger(
      segment.recommendedStrategy, entry, current, daysHeld, sinceBars.slice(-5), peakSinceEntry,
    )

    let decision: 'hold' | 'take_profit' | 'cut_loss' = 'hold'
    let confidence = 3
    let reasoning = trigger.reason
    let aiConfirm: AIOverride | null = null

    if (trigger.shouldExit) {
      aiConfirm = await askAIForConfirmation(
        h, segment.label, segment.recommendedStrategy, trigger.reason, trigger.triggerType,
        gainPct, daysHeld,
        {
          rsi14: ind.rsi14,
          volumeRatio: ind.volumeRatio,
          ma5: ind.ma5,
          ma25: ind.ma25,
          todayChangePct: ind.todayChangePct,
          consecutiveUp: ind.consecutiveUp,
        },
        {
          isNisa: h.account_type === 'nisa_growth',
          monthsLeftInYear,
          slotRemainingYen: nisaSlotRemaining,
          slotUsedPct: nisaSlotUsedPct,
        },
      )
      decision = aiConfirm.decision
      confidence = aiConfirm.confidence
      reasoning = `[${trigger.reason}] AI判定: ${aiConfirm.reasoning}`
    } else {
      decision = 'hold'
      confidence = 4
      reasoning = `[${segment.label}][${strategyLabel(segment.recommendedStrategy)}] ${trigger.reason}`
    }

    await adminSupabase.from('exit_judgments').insert({
      ticker: h.ticker,
      name: h.name,
      judgment_date: today,
      purchase_price: h.purchase_price,
      current_price: h.current_price,
      quantity: h.quantity,
      unrealized_gain_pct: gainPct,
      days_held: daysHeld,
      account_type: h.account_type,
      decision,
      confidence,
      reasoning,
      risk_factors: aiConfirm ? null : `セグメント:${segment.label}/戦略:${strategyLabel(segment.recommendedStrategy)}`,
      expected_action_within_days: decision === 'hold' ? 7 : 0,
    })

    results.push({
      ticker: h.ticker,
      name: h.name,
      segment: segment.label,
      strategy: strategyLabel(segment.recommendedStrategy),
      decision,
      reasoning,
      gainPct: Math.round(gainPct * 10) / 10,
    })
  }

  // LINE 通知: 売却/損切推奨が出た銘柄があれば
  let lineNotified = false
  const actionables = results.filter(r => r.decision !== 'hold')
  if (actionables.length > 0) {
    // 同じ銘柄に対して直近24時間で既に通知済みかチェック（重複防止）
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    const { data: recentNotified } = await adminSupabase
      .from('exit_judgments')
      .select('ticker, decision, line_notified_at')
      .gte('line_notified_at', since)
      .in('ticker', actionables.map(a => a.ticker))

    const alreadyNotifiedTickers = new Set(
      (recentNotified ?? [])
        .filter(r => r.decision !== 'hold' && r.line_notified_at)
        .map(r => r.ticker)
    )

    const toNotify = actionables.filter(a => !alreadyNotifiedTickers.has(a.ticker))
    if (toNotify.length > 0) {
      const message = formatExitJudgmentAlert(toNotify.map(a => ({
        name: a.name, ticker: a.ticker,
        decision: a.decision as 'hold' | 'take_profit' | 'cut_loss',
        gainPct: a.gainPct,
        reasoning: a.reasoning,
        segment: a.segment,
        strategy: a.strategy,
      })))
      if (message) {
        lineNotified = await sendLineMessage(message)
        if (lineNotified) {
          // 通知済みフラグ
          await adminSupabase
            .from('exit_judgments')
            .update({ line_notified_at: new Date().toISOString() })
            .eq('judgment_date', today)
            .in('ticker', toNotify.map(a => a.ticker))
        }
      }
    }
  }

  return NextResponse.json({
    ok: true, date: today, count: results.length, results,
    lineNotified, actionableCount: actionables.length,
  })
}

export async function GET() {
  const { data } = await adminSupabase
    .from('exit_judgments')
    .select('*')
    .order('judgment_date', { ascending: false })
    .order('ticker')
    .limit(100)
  return NextResponse.json({ judgments: data ?? [] })
}
