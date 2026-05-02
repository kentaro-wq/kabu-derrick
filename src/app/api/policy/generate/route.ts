import { NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { adminSupabase } from '@/lib/supabase'

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

export async function POST() {
  const { data: sessions } = await adminSupabase
    .from('chat_sessions')
    .select('title, messages, updated_at')
    .order('updated_at', { ascending: false })
    .limit(15)

  if (!sessions || sessions.length === 0) {
    return NextResponse.json({ content: '（相談履歴がまだありません）' })
  }

  const summary = sessions.map(s => {
    const msgs = (s.messages as { role: string; persona: string; content: string }[])
      .filter(m => ['user', 'main', 'roundtable_synthesis'].includes(m.persona))
      .slice(0, 10)
    const lines = msgs.map(m =>
      m.persona === 'user'
        ? `Q: ${m.content.slice(0, 150)}`
        : `A: ${m.content.slice(0, 300)}`
    ).join('\n')
    return `【${s.title}】\n${lines}`
  }).join('\n\n---\n\n')

  const msg = await client.messages.create({
    model: 'claude-3-5-haiku-20241022',
    max_tokens: 600,
    messages: [{
      role: 'user',
      content: `以下は山田さん（50歳、個別株初心者、NISA活用中、65歳までに3000万円目標）の投資相談の会話履歴です。\n\n${summary}\n\n会話から読み取れる山田さんの**現在の投資方針・決定事項・優先順位**を箇条書きで整理してください。「決めたこと」「重視していること」「保留・検討中のこと」の3カテゴリで整理すると良いです。200字程度で簡潔に。`,
    }],
  })

  const content = msg.content[0].type === 'text' ? msg.content[0].text : ''
  return NextResponse.json({ content })
}
