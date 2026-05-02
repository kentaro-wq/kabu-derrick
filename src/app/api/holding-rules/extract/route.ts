import { NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { adminSupabase } from '@/lib/supabase'

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

// チャット履歴から銘柄ルールを抽出して保存
// POST { ticker, name } — 既存ルールがある場合は上書きしない（force: true で強制上書き）
export async function POST(req: Request) {
  const { ticker, name, force = false } = await req.json()
  if (!ticker || !name) return NextResponse.json({ error: 'ticker and name required' }, { status: 400 })

  // 既存ルールがある場合はスキップ（force時は除く）
  if (!force) {
    const { data: existing } = await adminSupabase
      .from('holding_rules')
      .select('id, purpose, sell_conditions')
      .eq('ticker', ticker)
      .single()
    if (existing?.purpose || existing?.sell_conditions) {
      return NextResponse.json({ skipped: true, reason: '既存ルールあり' })
    }
  }

  // チャット履歴を取得（最新50セッション、銘柄名またはtickerを含むもの）
  const { data: allSessions } = await adminSupabase
    .from('chat_sessions')
    .select('title, messages, created_at')
    .order('created_at', { ascending: false })
    .limit(50)

  if (!allSessions || allSessions.length === 0) {
    return NextResponse.json({ skipped: true, reason: 'チャット履歴なし' })
  }

  // 銘柄名またはtickerを含むセッションを絞り込む
  const relevant = allSessions.filter(s => {
    const text = JSON.stringify(s.messages ?? []) + (s.title ?? '')
    return text.includes(name) || text.includes(ticker)
  })

  if (relevant.length === 0) {
    return NextResponse.json({ skipped: true, reason: '関連チャットなし' })
  }

  // 関連セッションから会話テキストを抽出（長くなりすぎないよう上位3セッション）
  const chatText = relevant.slice(0, 3).map(s => {
    const messages: { role: string; content: string }[] = Array.isArray(s.messages) ? s.messages : []
    return `【${s.title ?? '無題'}（${new Date(s.created_at).toLocaleDateString('ja-JP')}）】\n` +
      messages.map(m => `${m.role === 'user' ? '私' : 'AI'}: ${m.content}`).join('\n')
  }).join('\n\n---\n\n')

  const msg = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 600,
    messages: [{
      role: 'user',
      content: `以下は${name}（${ticker}）に関する投資相談のチャット履歴です。
この会話から、この銘柄について合意・決定されたルールや方針を抽出してください。

【チャット履歴】
${chatText}

以下のJSON形式のみで返してください（情報がない項目は null）:
{
  "purpose": "購入目的（例: 長期配当、NISA成長枠活用）",
  "policy_basis": "方針ベース（例: 高配当・連続増配への長期投資方針）",
  "sell_conditions": "売却条件（例: 含み益+30%超、配当利回り3%割れ時）",
  "dividend_notes": "配当メモ（例: 配当利回り4.2%、配当目標への貢献）",
  "timeline_notes": "期限付きルール（例: 2025年末までに株価○○円超なら売却）",
  "raw_agreement": "AIとの取り決め要約（会話で合意した内容を100字以内で）"
}`
    }],
  })

  const text = msg.content[0].type === 'text' ? msg.content[0].text : '{}'
  let extracted: Record<string, string | null> = {}
  try {
    const match = text.match(/\{[\s\S]*\}/)
    if (match) extracted = JSON.parse(match[0])
  } catch { return NextResponse.json({ skipped: true, reason: '抽出失敗' }) }

  // 全項目nullなら保存しない
  const hasContent = Object.values(extracted).some(v => v !== null && v !== '')
  if (!hasContent) return NextResponse.json({ skipped: true, reason: '抽出内容なし' })

  // holding_rules に保存（upsert）
  const { data, error } = await adminSupabase
    .from('holding_rules')
    .upsert({
      ticker,
      name,
      ...extracted,
      is_active: true,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'ticker' })
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ saved: true, rule: data, sessionCount: relevant.length })
}
