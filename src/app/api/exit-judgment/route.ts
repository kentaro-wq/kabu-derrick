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

/** 機械的トリガーで売却シグナル出た時、AIに最終判断を確認 */
async function askAIForConfirmation(
  h: Holding,
  segmentLabel: string,
  strategy: ExitStrategy,
  triggerReason: string,
  gainPct: number,
  daysHeld: number,
): Promise<AIOverride> {
  const prompt = `保有株の売却タイミング最終確認です。

【保有】${h.name}(${h.ticker}) ${h.account_type}
取得 ${h.purchase_price}円 × ${h.quantity}株
現在 ${h.current_price}円 (含み益 ${gainPct.toFixed(1)}%)
保有 ${daysHeld}日

【セグメント】${segmentLabel}
【推奨戦略】${strategyLabel(strategy)}
【発動した売却トリガー】${triggerReason}

機械的にはこれは売却シグナルです。
ただし、文脈で見て売らない方が良い場合もあります（例: 強い上昇トレンド継続中の一時調整など）。

あなたの最終判断:
- "take_profit": 利確売却すべき
- "cut_loss": 損切すべき
- "hold": 機械シグナルは出たが、文脈的にはまだ持続すべき

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
  const holdings = (holdingsRaw ?? []).filter((h: Holding) => /^\d{4}$/.test(h.ticker)) as Holding[]
  if (holdings.length === 0) return NextResponse.json({ message: '対象保有銘柄なし', count: 0 })

  const idToken = await getIdToken()
  if (!idToken) return NextResponse.json({ error: 'jquants auth failed' }, { status: 503 })

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

    const trigger = checkStrategyTrigger(
      segment.recommendedStrategy, entry, current, daysHeld, sinceBars.slice(-5), peakSinceEntry,
    )

    let decision: 'hold' | 'take_profit' | 'cut_loss' = 'hold'
    let confidence = 3
    let reasoning = trigger.reason
    let aiConfirm: AIOverride | null = null

    if (trigger.shouldExit) {
      aiConfirm = await askAIForConfirmation(
        h, segment.label, segment.recommendedStrategy, trigger.reason, gainPct, daysHeld,
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

  return NextResponse.json({ ok: true, date: today, count: results.length, results })
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
