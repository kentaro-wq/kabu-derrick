import { NextResponse } from 'next/server'
import { geminiGenerate } from '@/lib/gemini'
import { adminSupabase } from '@/lib/supabase'
import { sendLineMessage } from '@/lib/line'
import { getNisaStatus } from '@/lib/nisa'

type CustomRule = { label: string; value: string }

const NISA_TYPES = ['nisa_growth', 'nisa_tsumitate', 'old_tsumitate'] as const

// 確定申告期間の判定。「申告対象は前年分」なので、currentMonthForTax は実月。
// JST基準で確実に月を得る (UTCで getMonth() しても日跨ぎでズレないよう注意)
function currentMonthForTax(_year: number): number {
  const jstNow = new Date(Date.now() + 9 * 60 * 60 * 1000)
  return jstNow.getUTCMonth() + 1 // 1-12
}

const isNisaAccount = (accountType: string | null | undefined): boolean =>
  NISA_TYPES.includes(accountType as typeof NISA_TYPES[number])

// LINEメッセージのreasonからユーザーが「売る方向」の判断を求められているかを検出
// NISA口座での売却は枠を翌年まで失うため、利益最大化のために追加情報を付加する
const SELL_INTENT_RE = /(損切|売却|処分|手仕舞|撤退|売り推奨|売却推奨|売るべき)/

export async function POST() {
  const currentYear = new Date().getFullYear()
  const [rulesRes, holdingsRes, profileRes, realizedRes, realizedPastRes] = await Promise.all([
    adminSupabase.from('holding_rules').select('*').eq('is_active', true),
    adminSupabase.from('holdings').select('*'),
    adminSupabase.from('profile').select('*').single(),
    // 損出し戦略のため当年の特定口座実現損益を取得
    adminSupabase.from('realized_trades')
      .select('*')
      .gte('sell_date', `${currentYear}-01-01`)
      .lte('sell_date', `${currentYear}-12-31`),
    // 確定申告リマインダーのため過去3年の実現損益を取得
    adminSupabase.from('realized_trades')
      .select('*')
      .gte('sell_date', `${currentYear - 3}-01-01`)
      .lte('sell_date', `${currentYear - 1}-12-31`),
  ])

  const rules = rulesRes.data ?? []
  const holdings = holdingsRes.data ?? []
  const profile = profileRes.data
  const realizedTrades = realizedRes.data ?? []
  const realizedPastTrades = realizedPastRes.data ?? []

  if (rules.length === 0) {
    return NextResponse.json({ triggered: [], message: 'ルールなし' })
  }

  const holdingMap = new Map(holdings.map(h => [h.ticker, h]))

  const totalCost = holdings.reduce((s, h) => s + (h.purchase_price ?? 0) * (h.quantity ?? 0), 0)
  const totalEval = holdings.reduce((s, h) => s + (h.evaluation_amount ?? 0), 0)
  const totalGain = holdings.reduce((s, h) => s + (h.unrealized_gain ?? 0), 0)
  const totalGainPct = totalCost > 0 ? (totalGain / totalCost) * 100 : 0

  const portfolioAlerts: string[] = []

  const nisaHoldings = holdings.filter(h => isNisaAccount(h.account_type))
  const tokuteiHoldings = holdings.filter(h => h.account_type === 'tokutei')
  const nisaEvaluation = nisaHoldings.reduce((sum, h) => sum + (h.evaluation_amount ?? 0), 0)
  const tokuteiEvaluation = tokuteiHoldings.reduce((sum, h) => sum + (h.evaluation_amount ?? 0), 0)

  if (totalGainPct <= -20) {
    portfolioAlerts.push(`🚨 ポートフォリオ全体の含み損が${totalGainPct.toFixed(1)}%に達しています。損切りルールを確認してください。`)
  } else if (totalGainPct <= -10) {
    portfolioAlerts.push(`⚠️ ポートフォリオ全体の含み損が${totalGainPct.toFixed(1)}%です。各銘柄のルールを見直してください。`)
  }

  // 集中度チェック: 持株会(mochikabu)は除外
  // 理由: 持株会は奨励金目的の制度積立・即売却不可（移管手続きが必要）
  // 自由に売れない資産を「集中リスク」として警告するのは不適切
  const freeHoldings = holdings.filter(h => h.account_type !== 'mochikabu')
  const freeEval = freeHoldings.reduce((s, h) => s + (h.evaluation_amount ?? 0), 0)
  if (freeEval > 0) {
    freeHoldings.forEach(h => {
      const share = (h.evaluation_amount ?? 0) / freeEval * 100
      if (share >= 40) {
        portfolioAlerts.push(`🔴 集中リスク: ${h.name}が全体の${share.toFixed(0)}%を占めています（推奨: 30%以下）`)
      } else if (share >= 30) {
        portfolioAlerts.push(`⚠️ 集中注意: ${h.name}が全体の${share.toFixed(0)}%を占めています`)
      }
    })
  }

  // === 確定申告リマインダー（1-3月） ===
  // 過去3年の特定口座実現損益を年別集計し、損失年があれば繰越控除のため
  // 確定申告必須と通知。損失繰越は3年で消滅するため、毎年の申告が利益最大化に直結。
  if (currentMonthForTax(currentYear) >= 1 && currentMonthForTax(currentYear) <= 3) {
    const lossByYear = new Map<number, number>()
    for (const t of realizedPastTrades) {
      if (t.account_type !== 'tokutei' && t.account_type !== null) continue
      const year = new Date(t.sell_date).getFullYear()
      const gain = t.realized_gain != null ? Number(t.realized_gain)
        : (t.buy_price != null ? (t.sell_price - t.buy_price) * t.quantity : 0)
      lossByYear.set(year, (lossByYear.get(year) ?? 0) + gain)
    }
    const lossYears = [...lossByYear.entries()]
      .filter(([, g]) => g < 0)
      .sort((a, b) => a[0] - b[0])
    if (lossYears.length > 0) {
      const lines = lossYears.map(([y, g]) =>
        `${y}年: ${g.toLocaleString()}円`
      )
      portfolioAlerts.push(
        `📋 確定申告リマインダー: 過去3年に特定口座の損失あり (${lines.join(' / ')})。繰越控除のため申告必須。期限3/15`
      )
    }
  }

  // === 年末の損出し（タックスロスハーベスティング）アラート ===
  // 11月以降に特定口座の含み損銘柄が当年の確定益と相殺できる状況を検出
  // 利益最大化への寄与: 確定益 × 20.315% の節税余地を可視化
  // 売買最終日は12月最終営業日の数日前まで（受渡日ベース）。11月から準備を促す。
  const currentMonth = new Date().getMonth() + 1 // 1-12
  if (currentMonth >= 11) {
    // realized_gain カラムを優先（手数料・税金等込みの実際値）
    // 欠損時のみ (sell_price - buy_price) * quantity で代替
    const tokuteiRealizedGain = realizedTrades
      .filter(t => t.account_type === 'tokutei' || t.account_type === null)
      .reduce((sum, t) => {
        if (t.realized_gain != null) return sum + Number(t.realized_gain)
        if (t.buy_price == null) return sum
        return sum + (t.sell_price - t.buy_price) * t.quantity
      }, 0)

    const tokuteiUnrealizedLosses = tokuteiHoldings.filter(h => (h.unrealized_gain ?? 0) < 0)
    const totalTokuteiLoss = tokuteiUnrealizedLosses.reduce((s, h) => s + (h.unrealized_gain ?? 0), 0)

    // 当年の確定益がプラス かつ 特定口座に含み損銘柄あり → 損出し提案
    if (tokuteiRealizedGain > 0 && totalTokuteiLoss < 0) {
      const offsettable = Math.min(tokuteiRealizedGain, Math.abs(totalTokuteiLoss))
      const taxSaving = Math.round(offsettable * 0.20315)
      const urgency = currentMonth === 12 ? '🚨 期限間近' : '⚠️'
      portfolioAlerts.push(
        `${urgency} 年末損出し検討: 特定口座の含み損${Math.abs(totalTokuteiLoss).toLocaleString()}円を、当年確定益${tokuteiRealizedGain.toLocaleString()}円と相殺可能。`
      )
      portfolioAlerts.push(
        `  → 最大${offsettable.toLocaleString()}円分の節税余地 (約${taxSaving.toLocaleString()}円、20.315%課税回避)。同銘柄は翌営業日に買い直し可。NISA銘柄は対象外（損益通算不可）`
      )
    }
    // 確定益ゼロでも含み損は翌3年に繰越せる → 翌年以降に大きな利益見込みがあるなら検討余地
    else if (tokuteiRealizedGain === 0 && totalTokuteiLoss < -50000) {
      portfolioAlerts.push(
        `💡 当年確定益ゼロ・特定口座含み損${Math.abs(totalTokuteiLoss).toLocaleString()}円。確定申告で損失繰越（3年）可。翌年以降の利益と通算余地`
      )
    }
  }

  if (profile) {
    const nisaStatus = getNisaStatus(profile)
    if (nisaStatus.growthRemaining > 0 && nisaStatus.growthMonthsLeft <= 4) {
      portfolioAlerts.push(`🟦 NISA成長枠 残り${nisaStatus.growthRemaining.toLocaleString()}円、残り${nisaStatus.growthMonthsLeft}ヶ月で月${nisaStatus.growthMonthlyTarget.toLocaleString()}円ペース`)
    }
    if (nisaStatus.tsumitateRemaining > 0 && nisaStatus.tsumitateMonthsLeft <= 4) {
      portfolioAlerts.push(`🟦 つみたてNISA残り${nisaStatus.tsumitateRemaining.toLocaleString()}円、残り${nisaStatus.tsumitateMonthsLeft}ヶ月で月${nisaStatus.tsumitateMonthlyTarget.toLocaleString()}円ペース`)
    }
  }

  const ruleTexts = rules.map(r => {
    const h = holdingMap.get(r.ticker)
    const accountTypeLabel = h ? `口座: ${h.account_type}${isNisaAccount(h.account_type) ? '（NISA: 売却で枠が翌年まで失われる）' : ''}` : ''
    const status = h
      ? `現在株価: ${h.current_price?.toLocaleString() ?? '不明'}円 / 評価額: ${h.evaluation_amount?.toLocaleString() ?? '不明'}円 / 含み損益: ${h.unrealized_gain != null ? (h.unrealized_gain >= 0 ? '+' : '') + h.unrealized_gain.toLocaleString() + '円' : '不明'} (${h.unrealized_gain_pct != null ? (h.unrealized_gain_pct >= 0 ? '+' : '') + h.unrealized_gain_pct.toFixed(2) + '%' : '不明'}) / ${accountTypeLabel}`
      : '（保有データなし）'

    const customRulesText = Array.isArray(r.custom_rules) && r.custom_rules.length > 0
      ? '\nカスタムルール: ' + (r.custom_rules as CustomRule[])
          .map(cr => `${cr.label}: ${cr.value}`)
          .join(' / ')
      : ''

    return `【${r.name}（${r.ticker}）】
現況: ${status}
購入目的: ${r.purpose ?? '未設定'}
売却条件: ${r.sell_conditions ?? '未設定'}
期限付きルール: ${r.timeline_notes ?? '未設定'}
配当メモ: ${r.dividend_notes ?? '未設定'}${customRulesText}`
  }).join('\n\n')

  const today = new Date().toLocaleDateString('ja-JP', { year: 'numeric', month: 'long', day: 'numeric' })

  const text = await geminiGenerate({
    model: 'gemini-2.5-flash',
    maxTokens: 1000,
    messages: [{
      role: 'user',
      parts: [{ text: `今日は${today}です。以下の保有銘柄について、設定された売却条件・期限付きルール・カスタムルールが現在の状況に照らして「アクション要」かどうかを機械的に判定してください。

${ruleTexts}

判定ルール:
- 売却条件・期限ルール・カスタムルールに明確に合致するものだけ「アクション要」とする
- 「株価が◯◯円を超えたら」「含み益が◯◯%を超えたら」「損切り-X%」等の数値条件は現況データと比較
- 「◯◯年◯◯月までに」等の期限条件は今日の日付と比較
- カスタムルールも同様に数値・条件を確認する
- 条件が曖昧・未設定のものは「アクション不要」とする
- 【重要】持株会（勤務先株の社員持株会）の銘柄は「即売却不可・移管手続きが必要な制度積立」のため、集中リスクや単純な売却提案は不要。移管・売却を検討すべき具体的な条件（株価急落・会社の財務悪化等）がある場合のみアクション要とする
- 【NISA口座銘柄】売却すると非課税枠は翌年まで復活しない。設定されたルール基準にギリギリ達した程度では即「売却推奨」とせず、reasonに「ルール基準到達。NISA枠コスト考慮のうえ判断」と明示する。明確かつ大幅な基準超過（例: 損切り-15%設定で実際-20%超）または期限ルール抵触のみ強い売却推奨とする

以下のJSON形式のみで返してください:
{
  "triggered": [
    { "ticker": "XXXX", "name": "銘柄名", "reason": "該当した条件と判断理由（50字以内）" }
  ],
  "summary": "全体的な一言コメント（60字以内）"
}` }],
    }],
  })

  let result: { triggered: { ticker: string; name: string; reason: string }[]; summary: string } = { triggered: [], summary: '' }
  try {
    const match = text.match(/\{[\s\S]*\}/)
    if (match) result = JSON.parse(match[0])
  } catch { /* ignore */ }

  const hasIndividualAlert = result.triggered.length > 0
  const hasPortfolioAlert = portfolioAlerts.length > 0

  const accountLabel = (type: string) => {
    if (type === 'nisa_growth') return 'NISA成長'
    if (type === 'nisa_tsumitate') return 'つみたてNISA'
    if (type === 'old_tsumitate') return '旧つみたてNISA'
    if (type === 'tokutei') return '特定'
    if (type === 'dc') return 'DC'
    return '未設定'
  }

  if (hasIndividualAlert || hasPortfolioAlert) {
    const totalAssets = totalEval + (profile?.bank_balance ?? 0) + (profile?.dc_balance ?? 0)
    const gainSign = totalGain >= 0 ? '+' : ''

    let lineMsg = `📣 マイ株デリック ルール通知\n${today}\n`
    lineMsg += `総資産 ${totalAssets.toLocaleString()}円（損益 ${gainSign}${totalGain.toLocaleString()}円 / ${gainSign}${totalGainPct.toFixed(1)}%）\n`

    if (hasPortfolioAlert) {
      lineMsg += `\n【ポートフォリオ全体警告】\n`
      portfolioAlerts.forEach(a => { lineMsg += `${a}\n` })
    }

    if (hasIndividualAlert) {
      lineMsg += `\n【銘柄別アクション要】\n`
      result.triggered.forEach(t => {
        const h = holdingMap.get(t.ticker)
        const accountTag = h ? `（${accountLabel(h.account_type)}）` : ''
        lineMsg += `▶ ${t.name}（${t.ticker}） ${accountTag}\n${t.reason}\n`

        // NISA枠コスト警告: NISA銘柄を売る判断が出た時のみ
        // 目的: 「損失確定 + 枠の翌年まで非復活」の二重コストを意識させ、
        //       機械的損切りによるNISA枠の浪費を防ぐ（= 長期的な利益最大化）
        if (h && isNisaAccount(h.account_type) && SELL_INTENT_RE.test(t.reason)) {
          const quotaCost = (h.purchase_price ?? 0) * (h.quantity ?? 0)
          const unrealized = h.unrealized_gain ?? 0
          const isLoss = unrealized < 0
          lineMsg += `  ⚠️ NISA枠 ${quotaCost.toLocaleString()}円を消費（売却しても枠は翌年まで復活しません）\n`
          if (isLoss) {
            lineMsg += `  ℹ️ NISA損切りは三重損: ①損失確定 ②非課税枠喪失 ③特定口座の利益と損益通算・3年繰越控除も不可\n`
            lineMsg += `  ℹ️ ルール基準を本当に超えているか再確認推奨\n`
          } else {
            lineMsg += `  ℹ️ 利確の場合: 売却益は非課税で確定できますが、その分の枠は今年戻りません\n`
          }
        }

        lineMsg += `\n`
      })
    }

    lineMsg += `アプリで確認 →`
    await sendLineMessage(lineMsg)
  }

  return NextResponse.json({
    triggered: result.triggered,
    portfolioAlerts,
    summary: result.summary,
    portfolioStats: {
      totalGainPct: Math.round(totalGainPct * 100) / 100,
      totalGain,
      totalEval,
      nisaEvaluation,
      tokuteiEvaluation,
    },
    checkedAt: new Date().toISOString(),
  })
}
