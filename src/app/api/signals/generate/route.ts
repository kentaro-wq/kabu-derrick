/**
 * 上昇高確率局面検出エンジン
 *
 * 流れ:
 * 1. kabutan 上昇率ランキングから候補銘柄を取得
 * 2. 価格フィルター（300〜5000円、流動性あり）で絞る
 * 3. J-Quants で過去80日 OHLCV を取得してテクニカル指標を計算
 * 4. kabutan で PER/PBR/業績データを取得
 * 5. Claude に全データを渡して「高確率かどうか」を判定
 * 6. スコア4以上の銘柄のみ prediction_signals に記録
 *
 * 「わからない」は沈黙。確信が持てる局面だけを拾う設計。
 */
import { NextResponse } from 'next/server'
import { adminSupabase } from '@/lib/supabase'
import { fetchGainRankings, fetchStockInfo } from '@/lib/kabutan'
import { fetchOHLCVHistory, isJQuantsConfigured } from '@/lib/jquants'
import { calcIndicators, summarizeIndicators } from '@/lib/technicals'
import Anthropic from '@anthropic-ai/sdk'

export const maxDuration = 300

const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

interface SignalResult {
  fire: boolean
  score: number           // 1〜5
  conditions_met: string[]
  reasoning: string
  risk_factors: string
}

/** Claude に1銘柄のデータを渡して高確率局面かを判定 */
async function judgeSignal(
  ticker: string,
  name: string,
  price: number,
  indicatorSummary: string,
  fundamentalSummary: string,
): Promise<SignalResult> {
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
      model: 'claude-haiku-4-5',
      max_tokens: 512,
      messages: [{ role: 'user', content: prompt }],
    })
    const text = res.content[0].type === 'text' ? res.content[0].text : ''
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (!jsonMatch) return { fire: false, score: 1, conditions_met: [], reasoning: 'パース失敗', risk_factors: '' }
    return JSON.parse(jsonMatch[0]) as SignalResult
  } catch {
    return { fire: false, score: 1, conditions_met: [], reasoning: 'API エラー', risk_factors: '' }
  }
}

export async function POST() {
  if (!isJQuantsConfigured) {
    return NextResponse.json({ error: 'JQUANTS_REFRESH_TOKEN が未設定です' }, { status: 503 })
  }

  const today = new Date().toISOString().slice(0, 10)

  // 今日すでに実行済みかチェック
  const { data: existing } = await adminSupabase
    .from('prediction_signals')
    .select('id')
    .eq('signal_date', today)
    .limit(1)

  if (existing && existing.length > 0) {
    return NextResponse.json({ message: '本日分は既に生成済みです', date: today })
  }

  // Step 1: kabutan 上昇率ランキングから候補取得（プライム + スタンダード）
  const [primeRankings, standardRankings] = await Promise.all([
    fetchGainRankings('1'),
    fetchGainRankings('2'),
  ])

  const allCandidates = [...primeRankings, ...standardRankings]
    .filter((s, i, arr) => arr.findIndex(x => x.ticker === s.ticker) === i) // 重複除去

  // Step 2: 価格フィルター（デイトレしやすい300〜5000円帯）
  const filtered = allCandidates.filter(s =>
    s.price >= 300 && s.price <= 5000 && s.changePct >= 1.0  // 当日すでに+1%以上動いている
  ).slice(0, 40)  // 最大40銘柄

  if (filtered.length === 0) {
    return NextResponse.json({ message: '対象候補なし', date: today, signalCount: 0 })
  }

  const fired: string[] = []
  const results = []

  // Step 3〜6: 各銘柄を分析
  for (const candidate of filtered) {
    const { ticker, name, price } = candidate

    // J-Quants OHLCV取得
    const bars = await fetchOHLCVHistory(ticker, 80)
    if (bars.length < 25) continue  // データ不足はスキップ

    const ind = calcIndicators(bars)
    const indicatorSummary = summarizeIndicators(ticker, price, ind)

    // kabutan ファンダメンタル取得
    const info = await fetchStockInfo(ticker)
    const fundamentalSummary = info
      ? [
          `PER: ${info.per ?? '—'}倍`,
          `PBR: ${info.pbr ?? '—'}倍`,
          `配当利回り: ${info.dividendYield ?? '—'}%`,
          `売上高前期比: ${info.revenueGrowthPct != null ? info.revenueGrowthPct + '%' : '—'}`,
          `経常益前期比: ${info.profitGrowthPct != null ? info.profitGrowthPct + '%' : '—'}`,
        ].join(', ')
      : 'ファンダメンタルデータ取得失敗'

    // Claude 判定
    const judgment = await judgeSignal(ticker, name, price, indicatorSummary, fundamentalSummary)

    // スコア4以上のみ記録
    if (judgment.fire && judgment.score >= 4) {
      const { error } = await adminSupabase.from('prediction_signals').insert({
        ticker,
        name,
        signal_date: today,
        score: judgment.score,
        conditions_met: judgment.conditions_met,
        reasoning: judgment.reasoning,
        risk_factors: judgment.risk_factors,
        price_at_signal: price,
        ma5: ind.ma5,
        ma25: ind.ma25,
        ma75: ind.ma75,
        volume_ratio: ind.volumeRatio,
        rsi14: ind.rsi14,
        golden_cross: ind.goldenCross,
        above_ma25: ind.aboveMA25,
        above_ma75: ind.aboveMA75,
        price_change_from_low: ind.priceChangeFromLow,
        per: info?.per ?? null,
        pbr: info?.pbr ?? null,
        revenue_growth_pct: info?.revenueGrowthPct ?? null,
        profit_growth_pct: info?.profitGrowthPct ?? null,
      })

      if (!error) {
        fired.push(`${name}(${ticker}) スコア${judgment.score}`)
        results.push({ ticker, name, score: judgment.score, reasoning: judgment.reasoning })
      }
    }

    // kabutan への過剰アクセスを防ぐ
    await new Promise(r => setTimeout(r, 300))
  }

  return NextResponse.json({
    ok: true,
    date: today,
    scanned: filtered.length,
    signalCount: fired.length,
    signals: results,
  })
}

// Vercel Cron から GET でも呼べるように
export async function GET() {
  return POST()
}
