import { NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { adminSupabase } from '@/lib/supabase'
import { sendLineMessage } from '@/lib/line'

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

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

  // 現在の銘柄データとルールを突き合わせる評価テキストを構成
  const holdingMap = new Map(holdings.map(h => [h.ticker, h]))

  const ruleTexts = rules.map(r => {
    const h = holdingMap.get(r.ticker)
    const status = h
      ? `現在株価: ${h.current_price?.toLocaleString() ?? '不明'}円 / 評価額: ${h.evaluation_amount?.toLocaleString() ?? '不明'}円 / 含み損益: ${h.unrealized_gain != null ? (h.unrealized_gain >= 0 ? '+' : '') + h.unrealized_gain.toLocaleString() + '円' : '不明'} (${h.unrealized_gain_pct != null ? (h.unrealized_gain_pct >= 0 ? '+' : '') + h.unrealized_gain_pct.toFixed(2) + '%' : '不明'})`
      : '（保有データなし）'

    return `【${r.name}（${r.ticker}）】
現況: ${status}
購入目的: ${r.purpose ?? '未設定'}
売却条件: ${r.sell_conditions ?? '未設定'}
期限付きルール: ${r.timeline_notes ?? '未設定'}
配当メモ: ${r.dividend_notes ?? '未設定'}`
  }).join('\n\n')

  const today = new Date().toLocaleDateString('ja-JP', { year: 'numeric', month: 'long', day: 'numeric' })

  const msg = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 800,
    messages: [{
      role: 'user',
      content: `今日は${today}です。以下の保有銘柄について、設定された売却条件・期限付きルールが現在の状況に照らして「アクション要」かどうかを機械的に判定してください。

${ruleTexts}

判定ルール:
- 売却条件や期限ルールに明確に合致するものだけ「アクション要」とする
- 「株価が◯◯円を超えたら」「含み益が◯◯%を超えたら」等の数値条件は現況データと比較
- 「◯◯年◯◯月までに」等の期限条件は今日の日付と比較
- 条件が曖昧・未設定のものは「アクション不要」とする

以下のJSON形式のみで返してください:
{
  "triggered": [
    { "ticker": "XXXX", "name": "銘柄名", "reason": "該当した条件と判断理由（50字以内）" }
  ],
  "summary": "全体的な一言コメント（60字以内）"
}`
    }],
  })

  const text = msg.content[0].type === 'text' ? msg.content[0].text : '{}'
  let result: { triggered: { ticker: string; name: string; reason: string }[]; summary: string } = { triggered: [], summary: '' }
  try {
    const match = text.match(/\{[\s\S]*\}/)
    if (match) result = JSON.parse(match[0])
  } catch { /* ignore */ }

  // アクション要があればLINE通知
  if (result.triggered.length > 0) {
    const totalAssets = holdings.reduce((s, h) => s + (h.evaluation_amount ?? 0), 0)
      + (profile?.bank_balance ?? 0) + (profile?.dc_balance ?? 0)

    let lineMsg = `📣 マイ株デリック 銘柄ルール通知\n${today}\n\n`
    lineMsg += `⚡ 以下の銘柄でアクションが必要です\n\n`
    result.triggered.forEach(t => {
      lineMsg += `▶ ${t.name}（${t.ticker}）\n${t.reason}\n\n`
    })
    lineMsg += `総資産 ${totalAssets.toLocaleString()}円\nアプリで確認 →`

    await sendLineMessage(lineMsg)
  }

  return NextResponse.json({
    triggered: result.triggered,
    summary: result.summary,
    checkedAt: new Date().toISOString(),
  })
}
