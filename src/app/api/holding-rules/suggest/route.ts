import { NextResponse } from 'next/server'
import { geminiGenerate } from '@/lib/gemini'
import { adminSupabase } from '@/lib/supabase'

export async function POST(req: Request) {
  const { ticker, name } = await req.json()
  if (!ticker || !name) return NextResponse.json({ error: 'ticker and name required' }, { status: 400 })

  const [holdingRes, policyRes, allSessionsRes, profileRes] = await Promise.all([
    adminSupabase.from('holdings').select('*').eq('ticker', ticker).single(),
    adminSupabase.from('investment_policy').select('content').order('updated_at', { ascending: false }).limit(1).single(),
    adminSupabase.from('chat_sessions').select('title, messages, created_at').order('created_at', { ascending: false }).limit(40),
    adminSupabase.from('profile').select('target_amount, nisa_growth_limit, nisa_growth_used').single(),
  ])

  const holding = holdingRes.data
  const policy = policyRes.data?.content ?? '（未設定）'
  const profile = profileRes.data

  const allSessions = allSessionsRes.data ?? []
  const cleaned = name
    .replace(/（.*?）|\(.*?\)/g, '')
    .replace(/\s*(HD|ホールディングス|Holdings|株式会社|インデックス|ファンド|スリム|グループ).*$/gi, '')
    .trim()
  const searchKeywords = [...new Set([
    name, cleaned,
    cleaned.length >= 4 ? cleaned.slice(0, 6) : null,
    cleaned.length >= 3 ? cleaned.slice(0, 3) : null,
  ].filter(Boolean) as string[])]
  const relevant = allSessions.filter(s => {
    const text = JSON.stringify(s.messages ?? []) + (s.title ?? '')
    return searchKeywords.some(kw => text.includes(kw)) || text.includes(ticker)
  })
  const targetSessions = (relevant.length > 0 ? relevant : allSessions).slice(0, 3)

  const chatContext = targetSessions.map(s => {
    const messages: { role: string; content: string }[] = Array.isArray(s.messages) ? s.messages : []
    const userMsgs = messages.filter(m => m.role === 'user').slice(0, 15)
      .map(m => `私: ${String(m.content).slice(0, 400)}`).join('\n')
    return `【${s.title ?? '無題'}】\n${userMsgs}`
  }).join('\n\n---\n\n')

  const holdingInfo = holding
    ? `現在値: ${holding.current_price?.toLocaleString() ?? '不明'}円 / 取得単価: ${holding.purchase_price?.toLocaleString() ?? '不明'}円 / 含み損益: ${holding.unrealized_gain != null ? (holding.unrealized_gain >= 0 ? '+' : '') + holding.unrealized_gain.toLocaleString() + '円' : '不明'} (${holding.unrealized_gain_pct != null ? (holding.unrealized_gain_pct >= 0 ? '+' : '') + holding.unrealized_gain_pct.toFixed(2) + '%' : '不明'}) / 口座: ${holding.account_type}`
    : '（保有データなし）'

  const profileInfo = profile
    ? `目標: ${(profile.target_amount / 10000).toFixed(0)}万円 / NISA成長枠 残り: ${((profile.nisa_growth_limit - profile.nisa_growth_used) / 10000).toFixed(0)}万円`
    : ''

  const text = await geminiGenerate({
    model: 'gemini-2.0-flash-lite',
    maxTokens: 1200,
    messages: [{
      role: 'user',
      parts: [{ text: `あなたは山田さん（50歳、投資初心者）の投資ルール設計を支援するアドバイザーです。
「人の感情・思い込みを排し、AIの指針に機械的に従う」という運用方針のもと、${name}（${ticker}）の運用ルールを設計してください。

【${name} の現在状況】
${holdingInfo}

【全体の投資方針】
${policy}

${profileInfo ? `【プロフィール】\n${profileInfo}\n` : ''}
【過去の関連相談（ユーザー発言）】
${chatContext}

---

上記を踏まえ、この銘柄の**完全な運用ルールセット**を設計してください。
会話で言及されている内容は必ず反映し、さらにAIとして重要と判断する項目も追加してください。

返却形式（JSONのみ）:
{
  "purpose": "購入目的",
  "policy_basis": "根拠となる投資方針",
  "sell_conditions": "売却・利確条件（具体的な数値を含めること）",
  "dividend_notes": "配当・インカムに関するルール",
  "timeline_notes": "期限付きルール・時間軸",
  "raw_agreement": "ルール要約（150字以内）",
  "custom_rules": [
    { "label": "損切りルール", "value": "含み損-15%で機械的に損切り" },
    { "label": "買い増し条件", "value": "..." },
    { "label": "保有期間の目安", "value": "..." }
  ]
}

custom_rules には固定項目に収まらない重要ルールを3〜5件追加してください。` }],
    }],
  })

  try {
    const match = text.match(/\{[\s\S]*\}/)
    if (!match) return NextResponse.json({ error: '提案生成失敗' }, { status: 500 })
    const suggested = JSON.parse(match[0])
    return NextResponse.json({ suggested, sessionCount: targetSessions.length })
  } catch {
    return NextResponse.json({ error: '提案生成失敗', raw: text }, { status: 500 })
  }
}
