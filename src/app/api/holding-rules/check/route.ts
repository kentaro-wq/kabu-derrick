import { NextResponse } from 'next/server'
import { geminiGenerate } from '@/lib/gemini'
import { adminSupabase } from '@/lib/supabase'
import { sendLineMessage } from '@/lib/line'
import { getNisaStatus } from '@/lib/nisa'

type CustomRule = { label: string; value: string }

export async function POST() {
  const [rulesRes, holdingsRes, profileRes] = await Promise.all([
    adminSupabase.from('holding_rules').select('*').eq('is_active', true),
    adminSupabase.from('holdings').select('*'),
    adminSupabase.from('profile').select('*').single(),
  ])

  const rules = rulesRes.data ?? []
  const holdings = holdingsRes.data ?? []
  const profile = profileRes.data

  if (rules.length === 0) {
    return NextResponse.json({ triggered: [], message: 'ルールなし' })
  }

  const holdingMap = new Map(holdings.map(h => [h.ticker, h]))

  const totalCost = holdings.reduce((s, h) => s + (h.purchase_price ?? 0) * (h.quantity ?? 0), 0)
  const totalEval = holdings.reduce((s, h) => s + (h.evaluation_amount ?? 0), 0)
  const totalGain = holdings.reduce((s, h) => s + (h.unrealized_gain ?? 0), 0)
  const totalGainPct = totalCost > 0 ? (totalGain / totalCost) * 100 : 0

  const portfolioAlerts: string[] = []

  const nisaHoldings = holdings.filter(h => ['nisa_growth', 'nisa_tsumitate', 'old_tsumitate'].includes(h.account_type))
  const tokuteiHoldings = holdings.filter(h => h.account_type === 'tokutei')
  const nisaEvaluation = nisaHoldings.reduce((sum, h) => sum + (h.evaluation_amount ?? 0), 0)
  const tokuteiEvaluation = tokuteiHoldings.reduce((sum, h) => sum + (h.evaluation_amount ?? 0), 0)

  if (totalGainPct <= -20) {
    portfolioAlerts.push(`🚨 ポートフォリオ全体の含み損が${totalGainPct.toFixed(1)}%に達しています。損切りルールを確認してください。`)
  } else if (totalGainPct <= -10) {
    portfolioAlerts.push(`⚠️ ポートフォリオ全体の含み損が${totalGainPct.toFixed(1)}%です。各銘柄のルールを見直してください。`)
  }

  if (totalEval > 0) {
    holdings.forEach(h => {
      const share = (h.evaluation_amount ?? 0) / totalEval * 100
      if (share >= 40) {
        portfolioAlerts.push(`🔴 集中リスク: ${h.name}が全体の${share.toFixed(0)}%を占めています（推奨: 30%以下）`)
      } else if (share >= 30) {
        portfolioAlerts.push(`⚠️ 集中注意: ${h.name}が全体の${share.toFixed(0)}%を占めています`)
      }
    })
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
    const status = h
      ? `現在株価: ${h.current_price?.toLocaleString() ?? '不明'}円 / 評価額: ${h.evaluation_amount?.toLocaleString() ?? '不明'}円 / 含み損益: ${h.unrealized_gain != null ? (h.unrealized_gain >= 0 ? '+' : '') + h.unrealized_gain.toLocaleString() + '円' : '不明'} (${h.unrealized_gain_pct != null ? (h.unrealized_gain_pct >= 0 ? '+' : '') + h.unrealized_gain_pct.toFixed(2) + '%' : '不明'})`
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
        lineMsg += `▶ ${t.name}（${t.ticker}） ${accountTag}\n${t.reason}\n\n`
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
