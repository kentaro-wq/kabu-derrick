import { NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { adminSupabase } from '@/lib/supabase'

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

// 銘柄名から検索キーワードを生成（前方一致用）
function nameKeywords(name: string): string[] {
  const cleaned = name
    .replace(/（.*?）|\(.*?\)/g, '')
    .replace(/\s*(HD|ホールディングス|Holdings|株式会社|インデックス|ファンド|スリム|グループ|コーポレーション|Corp\.?|Inc\.?).*$/gi, '')
    .trim()
  const keywords: string[] = [name]
  if (cleaned !== name) keywords.push(cleaned)
  // 先頭4〜6文字も追加（部分一致用）
  if (cleaned.length >= 4) keywords.push(cleaned.slice(0, Math.min(cleaned.length, 6)))
  // さらに先頭3文字（短い略称対策）
  if (cleaned.length >= 3) keywords.push(cleaned.slice(0, 3))
  return [...new Set(keywords)]
}

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

  // チャット履歴を取得
  const { data: allSessions } = await adminSupabase
    .from('chat_sessions')
    .select('title, messages, created_at')
    .order('created_at', { ascending: false })
    .limit(60)

  if (!allSessions || allSessions.length === 0) {
    return NextResponse.json({ skipped: true, reason: 'チャット履歴なし' })
  }

  // 銘柄名キーワードで検索（前方一致・部分一致）
  const keywords = nameKeywords(name)
  const relevant = allSessions.filter(s => {
    const text = JSON.stringify(s.messages ?? []) + (s.title ?? '')
    return keywords.some(kw => text.includes(kw)) || text.includes(ticker)
  })

  // 関連セッションがなければ直近3件で試みる（一般的な方針議論から抽出）
  const targetSessions = relevant.length > 0 ? relevant.slice(0, 3) : allSessions.slice(0, 3)
  const sourceLabel = relevant.length > 0 ? `${name}関連` : '直近の相談'

  // セッションごとにユーザー発言のみ抽出（最大20件）+ AI返答は重要部分のみ
  const chatText = targetSessions.map(s => {
    const messages: { role: string; content: string; persona?: string }[] = Array.isArray(s.messages) ? s.messages : []

    // ユーザーメッセージを全件、AIメッセージは最初と最後の2件だけ抜粋
    const userMsgs = messages.filter(m => m.role === 'user').slice(0, 20)
    const aiMsgs = messages.filter(m => m.role === 'assistant')
    const aiSample = [...aiMsgs.slice(0, 1), ...aiMsgs.slice(-1)].filter(Boolean)

    const combined = [...userMsgs, ...aiSample]
      .map(m => `${m.role === 'user' ? '私' : 'AI'}: ${String(m.content).slice(0, 500)}`)
      .join('\n')

    return `【${s.title ?? '無題'}（${new Date(s.created_at).toLocaleDateString('ja-JP')}）】\n${combined}`
  }).join('\n\n---\n\n')

  const msg = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 700,
    messages: [{
      role: 'user',
      content: `以下は${name}（${ticker}）に関連する投資相談の記録（${sourceLabel}、${targetSessions.length}件）です。
この会話から、この銘柄について合意・言及されたルールや方針を抽出してください。
明確に述べられていない項目は null にしてください。

【会話記録】
${chatText}

返却形式（JSONのみ）:
{
  "purpose": "購入目的（例: 高配当長期保有、NISA活用）",
  "policy_basis": "どの方針に基づくか（例: 高配当株への長期投資方針）",
  "sell_conditions": "売却・損切り条件（例: 損切り-15%、テーマ終了時）",
  "dividend_notes": "配当に関する記載",
  "timeline_notes": "期限付きルール（例: 158円で売却予定）",
  "raw_agreement": "会話で合意した要点を150字以内で"
}`
    }],
  })

  const text = msg.content[0].type === 'text' ? msg.content[0].text : ''
  let extracted: Record<string, string | null> = {}
  try {
    const match = text.match(/\{[\s\S]*\}/)
    if (match) extracted = JSON.parse(match[0])
  } catch {
    return NextResponse.json({ skipped: true, reason: '抽出失敗（JSONパースエラー）' })
  }

  const hasContent = Object.values(extracted).some(v => v !== null && String(v).trim() !== '')
  if (!hasContent) return NextResponse.json({ skipped: true, reason: '関連する取り決めが見つかりませんでした' })

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
  return NextResponse.json({ saved: true, rule: data, sessionCount: targetSessions.length })
}
