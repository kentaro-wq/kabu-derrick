/**
 * ナンピン (買い増し) 検討 AI判定
 *
 * 哲学:
 * 「ナンピンは塩漬けの始まり」も真実。安易な追加買付は損失拡大の入口。
 * しかし「明らかな一時調整 + 集中度低 + 業績健全」なら、難値下げで利益最大化に貢献する。
 * AIに「ナンピン妥当性」を厳格に判定させ、推奨ケースのみ通知する。
 *
 * 判定対象: 含み損 -5% 以上の保有銘柄
 * 判定基準:
 *  ❌ 下降トレンド継続 (MA5/MA25 デッドクロス・右下がり)
 *  ❌ 集中度 >= 25% (これ以上集中させない)
 *  ❌ NISA枠ほぼ満杯 (新規買付余力なし)
 *  ✅ サポートライン上で下げ止まり + 出来高減少
 *  ✅ 業績健全・一時調整・配当高
 *  ✅ 集中度低 + 現金余力あり
 */
import { NextResponse } from 'next/server'
import { adminSupabase } from '@/lib/supabase'
import { sendLineMessage } from '@/lib/line'
import { fetchYahooBars, fetchDividendInfo } from '@/lib/stock-price'
import { calcIndicators } from '@/lib/technicals'
import Anthropic from '@anthropic-ai/sdk'

export const maxDuration = 60

const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

interface NanpinJudgment {
  decision: 'recommend' | 'avoid' | 'neutral'
  confidence: number
  reasoning: string
  suggestedAddSharesPct?: number  // 既存数量に対する追加買付比率 (e.g. 50 = 50% 追加)
}

async function logDecision(ticker: string, action: string, reason: string, advice: Record<string, unknown>, outcome: string) {
  try {
    await adminSupabase.from('decision_log').insert({
      log_date: new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10),
      ticker, action, reason, ai_advice: advice, outcome,
    })
  } catch (e) { console.error('[nanpin] log fail:', e) }
}

export async function POST() {
  const [holdingsRes, profileRes] = await Promise.all([
    adminSupabase.from('holdings').select('*'),
    adminSupabase.from('profile').select('*').single(),
  ])
  const holdings = (holdingsRes.data ?? []).filter((h: { ticker: string; account_type: string }) =>
    /^\d{4}$/.test(h.ticker) && ['nisa_growth', 'tokutei'].includes(h.account_type)
  )
  const profile = profileRes.data

  if (holdings.length === 0) {
    return NextResponse.json({ message: '対象銘柄なし', count: 0 })
  }

  // 集中度の分母
  const totalEval = holdings.reduce((s, h) =>
    s + (Number(h.current_price ?? 0) * Number(h.quantity ?? 0)), 0)

  // NISA残枠
  const nisaUsed = Number(profile?.nisa_growth_used ?? 0)
  const nisaLimit = Number(profile?.nisa_growth_limit ?? 2400000)
  const nisaRemaining = Math.max(0, nisaLimit - nisaUsed)
  const bankBalance = Number(profile?.bank_balance ?? 0)

  // 含み損 -5% 以上の銘柄のみ対象
  const candidates = holdings.filter(h => {
    const pct = h.unrealized_gain_pct != null ? Number(h.unrealized_gain_pct) : null
    return pct !== null && pct <= -5
  })

  if (candidates.length === 0) {
    return NextResponse.json({ message: '含み損 -5% 以上の銘柄なし', count: 0 })
  }

  const judgments: Array<{ ticker: string; name: string; gainPct: number; sharePct: number } & NanpinJudgment> = []

  for (const h of candidates) {
    const bars = await fetchYahooBars(h.ticker, '3mo')
    if (bars.length < 25) {
      await logDecision(h.ticker, 'nanpin_skip_data', 'Yahoo bars 不足', { bars: bars.length }, 'skipped')
      continue
    }
    const indicators = calcIndicators(bars)
    const dividend = await fetchDividendInfo(h.ticker)
    const current = Number(h.current_price)
    const entry = Number(h.purchase_price)
    const gainPct = ((current - entry) / entry) * 100
    const thisEval = current * Number(h.quantity)
    const sharePct = totalEval > 0 ? (thisEval / totalEval) * 100 : 0
    const isNisa = h.account_type === 'nisa_growth'

    // フィルタ前評価
    const earlyRejectReason =
      sharePct >= 25 ? `集中度${sharePct.toFixed(1)}%で過大` :
      isNisa && nisaRemaining < entry * 10 ? `NISA残枠${nisaRemaining.toLocaleString()}円不足` :
      bankBalance < entry * 100 ? `現金余力${bankBalance.toLocaleString()}円不足` :
      null

    if (earlyRejectReason) {
      const judgment = {
        ticker: h.ticker, name: h.name, gainPct: Math.round(gainPct * 10) / 10,
        sharePct: Math.round(sharePct * 10) / 10,
        decision: 'avoid' as const, confidence: 5,
        reasoning: `機械判定: ${earlyRejectReason}`,
      }
      judgments.push(judgment)
      await logDecision(h.ticker, 'nanpin_mechanical_reject', earlyRejectReason, {
        sharePct, gainPct, isNisa, nisaRemaining, bankBalance,
      }, 'avoid')
      continue
    }

    const techSummary = [
      indicators.rsi14 != null ? `RSI14: ${indicators.rsi14}` : '',
      indicators.ma5 ? `MA5: ${indicators.ma5}円 (現値${current >= indicators.ma5 ? '上' : '下'})` : '',
      indicators.ma25 ? `MA25: ${indicators.ma25}円 (現値${current >= indicators.ma25 ? '上' : '下'})` : '',
      indicators.volumeRatio != null ? `出来高比率: ${indicators.volumeRatio}倍` : '',
      indicators.todayChangePct != null ? `当日: ${indicators.todayChangePct >= 0 ? '+' : ''}${indicators.todayChangePct}%` : '',
    ].filter(Boolean).join(', ')

    const dividendLine = dividend && dividend.yieldPct > 0
      ? `年間配当: ${dividend.annualDividend}円/株 (利回り ${dividend.yieldPct}%)`
      : '配当データ取得不可'

    const prompt = `あなたは含み損銘柄への「ナンピン (買い増し)」妥当性を判定する慎重なトレーダーです。

【保有】${h.name}(${h.ticker})
取得 ${entry}円 × ${h.quantity}株 / 現在 ${current}円 / 含み損 ${gainPct.toFixed(1)}%
口座: ${h.account_type}${isNisa ? ` (NISA残枠 ${(nisaRemaining/10000).toFixed(0)}万円)` : ''}

【テクニカル】${techSummary}
【配当】${dividendLine}

【ポートフォリオ集中度】${sharePct.toFixed(1)}% (この銘柄の評価額が自由売買口座全体に占める比率)
【現金余力】${bankBalance.toLocaleString()}円

判断基準:

❌ avoid (ナンピン非推奨):
- 下降トレンド継続 (MA5・MA25 ともに右下がり、デッドクロス済み)
- ファンダ悪化の兆候 (出来高伴う下落、サポート割れ)
- RSI 30未満でも反転兆しなし
- 集中度が中庸 (20%超) でこれ以上集中させる価値小

✅ recommend (ナンピン推奨):
- サポートライン上で明確に下げ止まり (出来高減少)
- MA25 を上抜けて反発兆候
- 業績健全・配当維持・一時的調整と判断できる
- 集中度低 (20%未満) で追加余地あり
- 高配当 (3%超) で長期保有メリット大

⚪ neutral (中立):
- 様子見が妥当。明確な反転確認まで待つ
- 現金余力を温存

【利益最大化視点】
ナンピンは正しいタイミングなら平均取得単価を下げて利益拡大に貢献する。
しかし誤ったタイミングでは損失を拡大させる「塩漬けの始まり」になる。
「明確な底打ちサイン」が見えない限り neutral / avoid を選ぶこと。

JSON のみ:
{
  "decision": "recommend" | "avoid" | "neutral",
  "confidence": 1-5,
  "reasoning": "判断理由 (テクニカル + ファンダ + 集中度 + 配当を統合、2-3文)",
  "suggestedAddSharesPct": 25/50/100 のいずれか (recommend の場合のみ、既存数量に対する追加買付比率)
}`

    try {
      const res = await claude.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 400,
        messages: [{ role: 'user', content: prompt }],
      })
      const text = res.content[0].type === 'text' ? res.content[0].text : ''
      const m = text.match(/\{[\s\S]*\}/)
      const aiJudgment: NanpinJudgment = m
        ? JSON.parse(m[0])
        : { decision: 'neutral', confidence: 1, reasoning: 'AI応答なし' }

      const judgment = {
        ticker: h.ticker, name: h.name,
        gainPct: Math.round(gainPct * 10) / 10,
        sharePct: Math.round(sharePct * 10) / 10,
        ...aiJudgment,
      }
      judgments.push(judgment)
      await logDecision(h.ticker, 'nanpin_ai_judgment', `AI: ${aiJudgment.decision}`, {
        gain_pct: gainPct, share_pct: sharePct,
        dividend_yield: dividend?.yieldPct ?? null,
        indicators: { rsi14: indicators.rsi14, ma5: indicators.ma5, ma25: indicators.ma25 },
        ai_confidence: aiJudgment.confidence,
        ai_reasoning: aiJudgment.reasoning,
      }, aiJudgment.decision)
    } catch (e) {
      console.error('[nanpin] AI error:', e)
      await logDecision(h.ticker, 'nanpin_ai_error', String(e), {}, 'error')
    }
  }

  // LINE通知: recommend が出た銘柄のみ
  const recommends = judgments.filter(j => j.decision === 'recommend')
  let lineNotified = false
  if (recommends.length > 0) {
    const today = new Date().toLocaleDateString('ja-JP', { month: 'long', day: 'numeric', weekday: 'short' })
    let msg = `📈 マイ株デリック ナンピン候補 アラート\n${today}\n\n`
    msg += `以下の銘柄でナンピン推奨が出ています:\n\n`
    for (const j of recommends) {
      msg += `▶ ${j.name}(${j.ticker}) 含み損 ${j.gainPct}% / 集中度 ${j.sharePct}%\n`
      msg += `  推奨追加: 既存数量の${j.suggestedAddSharesPct ?? 50}%\n`
      msg += `  理由: ${j.reasoning}\n\n`
    }
    msg += `⚠️ ナンピンは慎重に。最終判断はユーザー判断で。`
    lineNotified = await sendLineMessage(msg).catch(() => false)
  }

  return NextResponse.json({
    ok: true,
    candidates: candidates.length,
    judgments,
    recommendsCount: recommends.length,
    lineNotified,
  })
}

export async function GET() {
  return POST()
}
