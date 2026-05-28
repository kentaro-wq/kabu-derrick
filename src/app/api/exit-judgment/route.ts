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
import { fetchYahooBars, fetchDividendInfo, type DividendInfo } from '@/lib/stock-price'

// decision_log への記録ヘルパー
// 全 AI判定・全スキップを永続化することで、再現性検証と事後分析を可能にする
// 重複防止: 同日・同ticker・同actionが既にあればスキップ (cronの多重起動対策)
async function logDecision(params: {
  ticker: string | null
  action: string
  reason?: string
  ai_advice?: Record<string, unknown>
  outcome?: string
}) {
  try {
    const today = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10)
    // 同日・同ticker・同action の重複チェック
    if (params.ticker) {
      const { data: existing } = await adminSupabase
        .from('decision_log').select('id')
        .eq('log_date', today)
        .eq('ticker', params.ticker)
        .eq('action', params.action)
        .limit(1)
      if (existing && existing.length > 0) return
    }
    await adminSupabase.from('decision_log').insert({
      log_date: today,
      ticker: params.ticker,
      action: params.action,
      reason: params.reason ?? null,
      ai_advice: params.ai_advice ?? null,
      outcome: params.outcome ?? null,
    })
  } catch (e) {
    console.error('[decision_log] insert failed:', e)
  }
}
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

/** ポートフォリオ集中度コンテキスト */
interface ConcentrationContext {
  sharePct: number          // この銘柄が自由売買口座全体に占める比率(%)
  totalEvalYen: number      // 自由売買口座の評価額合計
  thisEvalYen: number       // この銘柄の評価額
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
  current: number,  // J-Quants最新終値
  dividend: DividendInfo | null,
  concentration: ConcentrationContext,
): Promise<AIOverride> {
  const techSummary = [
    indicators.rsi14 != null ? `RSI(14): ${indicators.rsi14}` : '',
    indicators.volumeRatio != null ? `出来高比率: ${indicators.volumeRatio}倍` : '',
    indicators.ma5 ? `MA5: ${indicators.ma5}円 (現値${current >= indicators.ma5 ? '上' : '下'})` : '',
    indicators.ma25 ? `MA25: ${indicators.ma25}円 (現値${current >= indicators.ma25 ? '上' : '下'})` : '',
    indicators.todayChangePct != null ? `当日: ${indicators.todayChangePct >= 0 ? '+' : ''}${indicators.todayChangePct}%` : '',
    indicators.consecutiveUp >= 2 ? `連続陽線: ${indicators.consecutiveUp}日` : '',
  ].filter(Boolean).join(', ')

  // adaptive AI exit の含み益判定 vs 第一防衛線損切判定 を区別
  const isProfitJudgment = triggerType === 'pattern' && gainPct >= 5
  const isLossDecisionPoint = triggerType === 'pattern' && gainPct <= -8

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

  // 配当利回りセクション
  // 高配当銘柄は売却で配当収入を失うため、長期保有のインセンティブが強い
  // 例: 利回り3%なら含み損-3%は1年で取り返せる → 安易な損切は機会損失
  const dividendBlock = dividend && dividend.yieldPct > 0
    ? `\n【💰 配当収入】
- 年間配当 ${dividend.annualDividend}円/株 (利回り ${dividend.yieldPct}%)
- 直近権利確定日: ${dividend.lastExDate}
- ${dividend.yieldPct >= 3 ? '⭐ 高配当銘柄: 売却で年率3%超の配当収入を失う。長期保有の価値が高い' : dividend.yieldPct >= 2 ? '中配当: 配当も含めた総合リターンで判断' : '低配当: 売買判断への影響は小さい'}
- 売却判断には「キャピタル損益 + 想定配当収入」を総合評価\n`
    : ''

  // 集中度セクション
  // 単一銘柄への集中はリスク。30%超は分散原則に反する。
  // 利確判断ではむしろ集中度を下げる方向に評価したい。
  // 損切判断では集中度高は塩漬けリスクを高めるので早めの対応が合理的。
  const concentrationBlock = `\n【📊 ポートフォリオ集中度】
- この銘柄: 評価額${concentration.thisEvalYen.toLocaleString()}円 / 自由売買口座全体${concentration.totalEvalYen.toLocaleString()}円
- 占有率: ${concentration.sharePct.toFixed(1)}%
- ${concentration.sharePct >= 40 ? '🔴 集中度過大: 単一銘柄が40%超。利確で分散を進めるべき。損切も躊躇しない' : concentration.sharePct >= 30 ? '⚠️ 集中度高: 30%超。新規買付禁止。利確機会は逃さない' : concentration.sharePct >= 20 ? '中庸: 20%超。バランス意識' : '低集中: 通常判断'}\n`

  // 第一防衛線損切判定の専用プロンプト
  const lossPrompt = `あなたは含み損銘柄の「損切すべきか持続すべきか」を判断する冷静なトレーダーです。

【保有】${h.name}(${h.ticker})
取得 ${h.purchase_price}円 × ${h.quantity}株
現在 ${current}円 → 含み損 ${gainPct.toFixed(1)}%
保有 ${daysHeld}日

【テクニカル】
${techSummary}
${nisaBlock}${dividendBlock}${concentrationBlock}
---

判断の本質 (利益最大化視点):

これは「機械的-8%損切」と「NISA枠を守って回復を待つ」のトレードオフです。

**cut_loss すべき場面 (損切):**
- 明確な下降トレンド（MA5・MA25が右下がり、デッドクロス済み）
- ファンダメンタル悪材料（決算ミス、業界逆風）
- サポートラインを割り込み下値目処なし
- RSI 20未満で底打ち感もなくさらなる売りが続く
- 一目の雲・主要MAを全て下抜けた

**hold すべき場面 (持続):**
- 一時的な調整（地合い悪、テクニカル過熱の解消）
- 主要なサポートライン上で下げ止まり
- 出来高は減少（売り圧力の枯渇）
- RSI 30前後で売られすぎ反発の可能性
- ${nisa.isNisa ? `NISA枠の機会コスト大 (残月${nisa.monthsLeftInYear})、回復確率と天秤` : '通常口座なので即損切も選択肢'}

**判断哲学:**
- 利益最大化のためには、安易な損切も塩漬けも両方避ける
- 「明確な下降トレンド」or「サポート崩壊」が見えたら迷わず cut_loss
- そうでなければ、特に NISA枠の場合は hold で回復を待つ
- ${nisa.isNisa ? `NISA枠は希少資源。-15%の最終防衛線まで余裕${(gainPct + 15).toFixed(1)}%` : ''}
- 判断に迷うなら、最終防衛線(-15%)まで余裕があるか、と問い直せ

JSON のみ:
{
  "decision": "cut_loss" | "hold",
  "confidence": 1-5,
  "reasoning": "下降トレンドの強さとNISA機会コストを天秤にかけた判断 (2-3文)"
}`

  const prompt = isLossDecisionPoint
    ? lossPrompt
    : isProfitJudgment
    ? `あなたは「上がる銘柄を最後まで持ち続ける」哲学のトレーダーです。
含み益が出ている保有銘柄について、今売るか持ち続けるかを判断してください。

【保有】${h.name}(${h.ticker})
取得 ${h.purchase_price}円 × ${h.quantity}株
現在 ${current}円 → 含み益 ${gainPct.toFixed(1)}%
保有 ${daysHeld}日

【テクニカル】
${techSummary}
${nisaBlock}${dividendBlock}${concentrationBlock}
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
${nisaBlock}${dividendBlock}${concentrationBlock}
文脈で見て売らない方が良い場合もあります。
JSON のみで回答:
{
  "decision": "take_profit" | "cut_loss" | "hold",
  "confidence": 1-5,
  "reasoning": "判断理由（NISA制約があれば言及、1-2文）"
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

  // === ポートフォリオ集中度計算（AI判定に注入） ===
  // 自由売買口座（nisa_growth + tokutei）の評価額合計で各銘柄の占有率を出す。
  // 持株会や積立NISAは即売却不可なので分母から除外。
  // 30%超は分散リスク、40%超は緊急レベルとしてAIに伝える。
  const totalTradableEval = holdings.reduce((s, h) => s + (Number(h.current_price ?? 0) * Number(h.quantity ?? 0)), 0)

  const results: Array<{
    ticker: string; name: string; segment: string; strategy: string;
    decision: string; reasoning: string; gainPct: number;
  }> = []

  // === スキップ理由を必ずユーザーに通知する設計 ===
  // 「判定が出ない=判断不能」もユーザーが知るべき重大事象。
  // silent skip は「AI判断に従う」哲学を破壊するため許容しない。
  const skippedDivergences: Array<{
    ticker: string; name: string; jquantsPrice: number; yahooPrice: number; divergencePct: number
  }> = []
  const skippedDataMissing: Array<{ ticker: string; name: string; reason: string }> = []
  const skippedStaleData: Array<{ ticker: string; name: string; latestDate: string; daysOld: number }> = []
  // 5% は値動きの激しい日に誤発火しやすいため 10% に緩和
  // (現実の1日変動 + データタイミング差で 5% は超え得る)
  const PRICE_SOURCE_DIVERGENCE_THRESHOLD_PCT = 10
  // J-Quants bars の最新日付が今日から何日以上古ければ「stale」とみなすか
  // 過去事例: J-Quants の bars が 3ヶ月前で止まっていて、機械的損切判定が
  // 古いデータで誤発火していた。週末・祝日を考慮して 5 日以上のズレを stale と判定。
  const JQUANTS_STALE_DAYS_THRESHOLD = 5

  for (const h of holdings) {
    // 既存チェック (最優先): 同日に既に判定済みなら全スキップ
    // cron の多重起動でも判定が二重実行されないようにする
    const { data: existing } = await adminSupabase
      .from('exit_judgments').select('id')
      .eq('ticker', h.ticker).eq('judgment_date', today).limit(1)
    if (existing && existing.length > 0) continue  // 同日既存はスキップが正常動作

    if (!h.current_price || !h.purchase_price) {
      const reason = !h.current_price ? 'current_price 未取得' : 'purchase_price 未設定'
      skippedDataMissing.push({ ticker: h.ticker, name: h.name, reason })
      await logDecision({
        ticker: h.ticker, action: 'exit_skip_data_missing',
        reason, outcome: 'skipped',
      })
      continue
    }

    const bars = await fetchOHLCVHistoryCached(h.ticker, 60, idToken)

    // === J-Quants 状態評価 + Yahoo フォールバック ===
    // J-Quants が「bars不足」「データ古い」いずれの場合も Yahoo にフォールバック
    // 古いデータ・データ無しでの判定 = 致命的なので、Yahoo で救済できるなら救済
    let workingBars = bars
    let dataSource: 'jquants' | 'yahoo_fallback' = 'jquants'
    const latestBar = bars[bars.length - 1]
    const latestBarDate = latestBar?.date as string | undefined
    const jqDaysOld = latestBarDate
      ? Math.floor((Date.now() - new Date(latestBarDate).getTime()) / 86400000)
      : Infinity
    const needsFallback = bars.length < 25 || jqDaysOld >= JQUANTS_STALE_DAYS_THRESHOLD

    if (needsFallback) {
      const yahooBars = await fetchYahooBars(h.ticker, '3mo')
      const fallbackReason = bars.length < 25
        ? `J-Quants bars 不足 (${bars.length}本)`
        : `J-Quants 鮮度不足 (${latestBarDate}, ${jqDaysOld}日前)`

      if (yahooBars.length < 25) {
        skippedDataMissing.push({
          ticker: h.ticker, name: h.name,
          reason: `${fallbackReason} + Yahoo bars 不足(${yahooBars.length}本)`,
        })
        await logDecision({
          ticker: h.ticker, action: 'exit_skip_data_missing',
          reason: fallbackReason, outcome: 'skipped',
          ai_advice: { jquants_bars: bars.length, jquants_latest: latestBarDate, yahoo_bars: yahooBars.length },
        })
        continue
      }
      // Yahoo bar の鮮度もチェック
      const yahooLatest = yahooBars[yahooBars.length - 1]
      const yahooDaysOld = Math.floor((Date.now() - new Date(yahooLatest.date).getTime()) / 86400000)
      if (yahooDaysOld >= JQUANTS_STALE_DAYS_THRESHOLD) {
        skippedStaleData.push({
          ticker: h.ticker, name: h.name,
          latestDate: `J-Quants ${latestBarDate ?? 'なし'} / Yahoo ${yahooLatest.date}`,
          daysOld: Math.max(jqDaysOld === Infinity ? 999 : jqDaysOld, yahooDaysOld),
        })
        await logDecision({
          ticker: h.ticker, action: 'exit_skip_stale_data',
          reason: `両ソース鮮度不足 (Yahoo ${yahooDaysOld}日前)`,
          ai_advice: { jquants_latest: latestBarDate, yahoo_latest: yahooLatest.date },
          outcome: 'skipped',
        })
        continue
      }
      workingBars = yahooBars
      dataSource = 'yahoo_fallback'
    }

    const pastBars = workingBars.slice(-20)
    const vol = calcVolatility(pastBars)

    // 判定に使う最新価格はフォールバック後の最新終値
    const latestPrice = workingBars[workingBars.length - 1]?.close ?? Number(h.current_price)

    // === データ整合性チェック: J-Quants vs Yahoo (holdings) ===
    // 株式分割・配当落ち調整の片側未反映を検知。乖離大なら判定スキップ。
    // ただし dataSource='yahoo_fallback' なら両方とも Yahoo 由来なのでチェック不要
    const yahooPrice = Number(h.current_price)
    if (dataSource === 'jquants' && yahooPrice > 0 && latestPrice > 0) {
      const divergencePct = Math.abs((latestPrice - yahooPrice) / yahooPrice) * 100
      if (divergencePct >= PRICE_SOURCE_DIVERGENCE_THRESHOLD_PCT) {
        const divPct = Math.round(divergencePct * 10) / 10
        skippedDivergences.push({
          ticker: h.ticker,
          name: h.name,
          jquantsPrice: latestPrice,
          yahooPrice,
          divergencePct: divPct,
        })
        await logDecision({
          ticker: h.ticker, action: 'exit_skip_divergence',
          reason: `J-Quants ${latestPrice}円 vs Yahoo ${yahooPrice}円 (${divPct}%)`,
          ai_advice: { jquants_price: latestPrice, yahoo_price: yahooPrice, divergence_pct: divPct },
          outcome: 'skipped',
        })
        continue // 判定スキップ：誤判定リスクが大きすぎる
      }
    }
    const segment = classifySegment(latestPrice, vol)

    const daysHeld = Math.floor((Date.now() - new Date(h.created_at).getTime()) / 86400000)
    const entry = Number(h.purchase_price)
    const current = latestPrice
    const gainPct = (current - entry) / entry * 100

    // daysHeld は暦日数なので、営業日換算 (1.4で割る) してbarsのインデックスに変換
    const businessDaysHeld = Math.ceil(daysHeld / 1.4)
    const sinceBars = workingBars.slice(Math.max(0, workingBars.length - businessDaysHeld - 1))
    const peakSinceEntry = Math.max(entry, ...sinceBars.map(b => b.high))

    // AI 判定に渡すテクニカル指標
    const ind = calcIndicators(workingBars)

    const trigger = checkStrategyTrigger(
      segment.recommendedStrategy, entry, current, daysHeld, sinceBars.slice(-5), peakSinceEntry,
    )

    let decision: 'hold' | 'take_profit' | 'cut_loss' = 'hold'
    let confidence = 3
    let reasoning = trigger.reason
    let aiConfirm: AIOverride | null = null

    if (trigger.shouldExit) {
      // ⚠️ 損切ラインは機械的に確定。AI の override を許さない（塩漬け防止）
      // ユーザーの哲学: 「損切りを適切に」 = -8% で迷わず確定
      if (trigger.triggerType === 'cut_loss') {
        decision = 'cut_loss'
        confidence = 5
        reasoning = `[機械損切・AI判断省略] ${trigger.reason} / 哲学: 損切は迷わず確定`
      } else {
        // 配当情報を取得（AI判定に総合リターン視点で組込み）
        // 失敗時は null で AI に渡す（プロンプト側で空セクション化）
        const dividend = await fetchDividendInfo(h.ticker)

        // 集中度計算: この銘柄の評価額 / 自由売買口座全体
        const thisEval = current * Number(h.quantity)
        const sharePct = totalTradableEval > 0 ? (thisEval / totalTradableEval) * 100 : 0

        // 利確・時間切れ・モメンタム判定は AI に最終確認
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
          current,
          dividend,
          {
            sharePct,
            totalEvalYen: Math.round(totalTradableEval),
            thisEvalYen: Math.round(thisEval),
          },
        )
        decision = aiConfirm.decision
        confidence = aiConfirm.confidence
        reasoning = `[${trigger.reason}] AI判定: ${aiConfirm.reasoning}`
      }
    } else {
      decision = 'hold'
      confidence = 4
      reasoning = `[${segment.label}][${strategyLabel(segment.recommendedStrategy)}] ${trigger.reason}`
    }

    // データソース明示（後の検証で「どのデータで判定したか」が追える）
    const sourceTag = dataSource === 'yahoo_fallback' ? ' [Yahooフォールバック]' : ''
    reasoning = `${reasoning}${sourceTag}`

    await adminSupabase.from('exit_judgments').insert({
      ticker: h.ticker,
      name: h.name,
      judgment_date: today,
      purchase_price: h.purchase_price,
      current_price: current,  // 判定時の最新終値（J-Quants または Yahoo）
      quantity: h.quantity,
      unrealized_gain_pct: gainPct,
      days_held: daysHeld,
      account_type: h.account_type,
      decision,
      confidence,
      reasoning,
      risk_factors: aiConfirm ? null : `セグメント:${segment.label}/戦略:${strategyLabel(segment.recommendedStrategy)}/source:${dataSource}`,
      expected_action_within_days: decision === 'hold' ? 7 : 0,
    })

    // decision_log: 全判定を永続化（後の再現性検証・パターン分析に使う）
    await logDecision({
      ticker: h.ticker,
      action: aiConfirm ? 'exit_ai_judgment' :
              trigger.shouldExit && trigger.triggerType === 'cut_loss' ? 'exit_mechanical_cut' :
              trigger.shouldExit ? 'exit_trigger_no_ai' : 'exit_hold_no_trigger',
      reason: trigger.reason,
      ai_advice: {
        data_source: dataSource,
        segment: segment.label,
        strategy: strategyLabel(segment.recommendedStrategy),
        gain_pct: Math.round(gainPct * 100) / 100,
        days_held: daysHeld,
        current_price: current,
        purchase_price: Number(h.purchase_price),
        indicators: {
          rsi14: ind.rsi14,
          ma5: ind.ma5,
          ma25: ind.ma25,
          volume_ratio: ind.volumeRatio,
          today_change_pct: ind.todayChangePct,
        },
        ...(aiConfirm ? { ai_confidence: aiConfirm.confidence, ai_reasoning: aiConfirm.reasoning } : {}),
      },
      outcome: decision,
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

  // === スキップ通知（必ず送出） ===
  // 「判定不能」もユーザーが知るべき。silent skip を許さない設計。
  const skipMsgs: string[] = []
  if (skippedDivergences.length > 0) {
    skipMsgs.push(
      `【価格データ乖離 ${PRICE_SOURCE_DIVERGENCE_THRESHOLD_PCT}%超】`,
      ...skippedDivergences.map(s =>
        `▶ ${s.name}(${s.ticker})\n  J-Quants ${s.jquantsPrice.toLocaleString()}円 / Yahoo ${s.yahooPrice.toLocaleString()}円 (乖離${s.divergencePct}%)`
      ),
      '原因: 株式分割/併合・大型配当落ち・データソース異常 等'
    )
  }
  if (skippedDataMissing.length > 0) {
    skipMsgs.push(
      '【データ不足で判定不能】',
      ...skippedDataMissing.map(s => `▶ ${s.name}(${s.ticker}): ${s.reason}`)
    )
  }
  if (skippedStaleData.length > 0) {
    skipMsgs.push(
      `【J-Quants データ鮮度不足 (${JQUANTS_STALE_DAYS_THRESHOLD}日以上古い)】`,
      ...skippedStaleData.map(s => `▶ ${s.name}(${s.ticker}): 最新bar ${s.latestDate} (${s.daysOld}日前)`),
      '原因: J-Quants API の遅延・無料プラン制約・キャッシュ問題等'
    )
  }
  if (skipMsgs.length > 0) {
    const fullMsg = [
      '🚨 マイ株デリック 出口判定スキップ警告',
      '以下の銘柄は当日の自動判定が出ていません',
      '',
      ...skipMsgs,
      '',
      '⚠️ 該当銘柄は手動確認するまで自動判定が出ません',
    ].join('\n')
    await sendLineMessage(fullMsg).catch(() => { /* 通知失敗は無視（ログのみ） */ })
    console.warn('[exit-judgment] skipped:', { skippedDivergences, skippedDataMissing })
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
    skippedDivergences,
    skippedDataMissing,
    skippedStaleData,
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
