/**
 * バックテストコアロジック
 *
 * 設計の鍵: 先読みバイアス(Look-Ahead Bias)排除
 * - 任意の日付 T で判定するとき、T日以前のデータしか使わない
 * - 結果計算用の T+5/T+10/T+20 のデータは判定時には絶対に見せない
 * - これを徹底することで「もし当時その判定をしていたら」という現実的な検証になる
 */
import { calcIndicators, summarizeIndicators, type OHLCVBar } from '@/lib/technicals'
import Anthropic from '@anthropic-ai/sdk'

const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

export interface SignalJudgment {
  fire: boolean
  score: number
  conditions_met: string[]
  reasoning: string
  risk_factors: string
}

/**
 * 同じ判定ロジック（live と backtest で共有）
 * プロンプトを変更したい場合はここを変える → live/backtest 両方に反映される
 */
export async function judgeWithClaude(
  ticker: string,
  name: string,
  price: number,
  indicatorSummary: string,
  fundamentalSummary: string,
): Promise<SignalJudgment> {
  const prompt = `あなたは日本株のテクニカル・ファンダメンタル分析の専門家です。
以下の銘柄データを分析し、「今から10〜20営業日以内に+5%以上の上昇が起こる確率が高い局面かどうか」を判定してください。

銘柄: ${name}（${ticker}）

【テクニカル指標】
${indicatorSummary}

【ファンダメンタル】
${fundamentalSummary}

---
判定ルール:
- 確信が持てる場合のみ fire: true にしてください
- 「わからない」「どちらとも言えない」場合は fire: false、score: 2以下にしてください
- fire: true にするのは「複数の強いシグナルが重なっている局面」のみです
- 以下の高確率条件を重視してください:
  ・出来高が20日平均の2.5倍以上 かつ 陽線
  ・ゴールデンクロス（直近3日以内）
  ・25日MA・75日MA両方を上抜けている
  ・RSIが40〜60の範囲（買われすぎでも売られすぎでもない）
  ・業績が成長傾向（売上・利益の前期比プラス）
- リスク要因（割高PER、業績悪化、過熱RSI等）があれば正直に記載してください

以下のJSON形式のみで回答してください（余計なテキスト不要）:
{
  "fire": true,
  "score": 4,
  "conditions_met": ["出来高急増(3.2倍)", "ゴールデンクロス", "MA25・MA75上抜け"],
  "reasoning": "なぜ高確率と判断したか（2〜3文）",
  "risk_factors": "リスク要因があれば記載、なければ「特になし」"
}`

  try {
    const res = await claude.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 512,
      messages: [{ role: 'user', content: prompt }],
    })
    const text = res.content[0].type === 'text' ? res.content[0].text : ''
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {
      return { fire: false, score: 1, conditions_met: [], reasoning: 'パース失敗', risk_factors: '' }
    }
    return JSON.parse(jsonMatch[0]) as SignalJudgment
  } catch (e) {
    console.error('[backtest] Claude API error:', e)
    return { fire: false, score: 1, conditions_met: [], reasoning: 'API エラー', risk_factors: '' }
  }
}

/** 現プロンプト版のハッシュ（変更を追跡）— 簡易的にプロンプト先頭を返す */
export const PROMPT_VERSION = '2026-05-v1'

export interface BacktestCandidate {
  ticker: string
  name: string
  date: string
  priceAtSignal: number
  bars: OHLCVBar[]      // この日までのbar（先読みなし）
  futureBars: OHLCVBar[] // 結果計算用（判定には使わない）
}

/**
 * 全銘柄のOHLCVから、特定日付の候補銘柄を抽出
 * 条件: 価格 300〜5000円、当日騰落率 +1.0%以上
 */
export function extractCandidatesForDate(
  universe: { ticker: string; name: string; bars: OHLCVBar[] }[],
  targetDate: string,
): BacktestCandidate[] {
  const candidates: BacktestCandidate[] = []

  for (const { ticker, name, bars } of universe) {
    // targetDate に該当するbarのインデックスを探す
    const idx = bars.findIndex(b => b.date === targetDate)
    if (idx < 25) continue // 25日分のデータが必要（指標計算用）

    const bar = bars[idx]
    const prevBar = bars[idx - 1]
    if (!prevBar || prevBar.close <= 0) continue

    const changePct = ((bar.close - prevBar.close) / prevBar.close) * 100

    // フィルター条件
    if (bar.close < 300 || bar.close > 5000) continue
    if (changePct < 1.0) continue

    candidates.push({
      ticker,
      name,
      date: targetDate,
      priceAtSignal: bar.close,
      bars: bars.slice(0, idx + 1),      // targetDateまで（含む）
      futureBars: bars.slice(idx + 1),   // targetDate翌日以降
    })
  }

  return candidates
}

/** 過去N営業日後の終値を取得（インデックスN-1）— なければnull */
export function priceAfterNDays(futureBars: OHLCVBar[], n: number): number | null {
  if (futureBars.length < n) return null
  return futureBars[n - 1].close
}

/**
 * ランダムにN個の営業日付を返す（universeにデータがある日付から）
 * dateRangeを指定すると、その期間内の日付だけからサンプリング（時代別バックテスト用）
 */
export function pickRandomTradingDates(
  allDates: string[],
  count: number,
  earliestIdx = 25,            // 最初の25日はindicator計算に使うので除外
  latestOffsetFromEnd = 20,    // 最後の20日は結果追跡に使うので除外
  dateRange?: { from?: string; to?: string },
): string[] {
  let usable = allDates.slice(earliestIdx, allDates.length - latestOffsetFromEnd)
  if (dateRange?.from) usable = usable.filter(d => d >= dateRange.from!)
  if (dateRange?.to)   usable = usable.filter(d => d <= dateRange.to!)
  if (usable.length === 0) return []

  // Fisher-Yates 風にシャッフルしてN個取る
  const arr = [...usable]
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr.slice(0, Math.min(count, arr.length)).sort()
}

/**
 * 時代ローテーション用のプリセット期間
 * 経過日数で指定（今日から〜〜日前のレンジ）
 */
export const PERIOD_PRESETS = [
  { label: '直近3ヶ月',   daysAgoMax: 30,  daysAgoMin: 120 },
  { label: '3〜6ヶ月前',  daysAgoMax: 120, daysAgoMin: 200 },
  { label: '6〜12ヶ月前', daysAgoMax: 200, daysAgoMin: 365 },
] as const

/** プリセットから日付範囲を計算 */
export function periodToDateRange(preset: typeof PERIOD_PRESETS[number]): { from: string; to: string; label: string } {
  const now = Date.now()
  const day = 24 * 60 * 60 * 1000
  const from = new Date(now - preset.daysAgoMin * day).toISOString().slice(0, 10)
  const to   = new Date(now - preset.daysAgoMax * day).toISOString().slice(0, 10)
  return { from, to, label: preset.label }
}

/** 全universeに共通する取引日リストを返す（最も多くの銘柄でデータがある日付の集合） */
export function getCommonTradingDates(
  universe: { ticker: string; bars: OHLCVBar[] }[],
): string[] {
  const dateCounts = new Map<string, number>()
  for (const { bars } of universe) {
    for (const b of bars) {
      dateCounts.set(b.date, (dateCounts.get(b.date) ?? 0) + 1)
    }
  }
  // 半数以上の銘柄でデータがある日付のみ
  const threshold = universe.length / 2
  const validDates: string[] = []
  for (const [date, count] of dateCounts.entries()) {
    if (count >= threshold) validDates.push(date)
  }
  return validDates.sort()
}

/** 候補1件をClaude判定 + 結果計算 */
export async function evaluateCandidate(
  c: BacktestCandidate,
): Promise<{
  judgment: SignalJudgment
  indicators: ReturnType<typeof calcIndicators>
  outcomes: {
    price5d: number | null; pct5d: number | null; hit5d: boolean | null
    price10d: number | null; pct10d: number | null; hit10d: boolean | null
    price20d: number | null; pct20d: number | null; hit20d: boolean | null
  }
}> {
  // テクニカル指標 — c.bars には targetDate までの bar しかないので先読みなし
  const indicators = calcIndicators(c.bars)
  const indicatorSummary = summarizeIndicators(c.ticker, c.priceAtSignal, indicators)
  // バックテストではファンダメンタル（PER/業績）は履歴取得できないため簡略化
  const fundamentalSummary = 'バックテスト: ファンダメンタル省略'

  const judgment = await judgeWithClaude(
    c.ticker, c.name, c.priceAtSignal,
    indicatorSummary, fundamentalSummary,
  )

  // 結果計算（futureBars から取得）
  const p5 = priceAfterNDays(c.futureBars, 5)
  const p10 = priceAfterNDays(c.futureBars, 10)
  const p20 = priceAfterNDays(c.futureBars, 20)
  const calcPct = (p: number) =>
    Math.round(((p - c.priceAtSignal) / c.priceAtSignal) * 1000) / 10

  return {
    judgment,
    indicators,
    outcomes: {
      price5d: p5,   pct5d: p5  != null ? calcPct(p5)  : null, hit5d:  p5  != null ? calcPct(p5)  >= 3.0 : null,
      price10d: p10, pct10d: p10 != null ? calcPct(p10) : null, hit10d: p10 != null ? calcPct(p10) >= 5.0 : null,
      price20d: p20, pct20d: p20 != null ? calcPct(p20) : null, hit20d: p20 != null ? calcPct(p20) >= 5.0 : null,
    },
  }
}
