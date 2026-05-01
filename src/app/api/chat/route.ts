import { NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { adminSupabase } from '@/lib/supabase'

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

const PERSONAS = {
  conservative: {
    label: '守りの分析家',
    system: `あなたは慎重派の投資アナリストです。資本保全を最優先に考え、リスクを徹底的に列挙します。
損失の可能性を常に強調し、「安全第一」の観点から助言します。感情的な判断を排し、データと事実に基づいて話します。
日本語で、平易な言葉で、簡潔に（200字以内）答えてください。`,
  },
  growth: {
    label: '成長論者',
    system: `あなたは積極的な成長投資家です。上値余地と機会を重視し、強気の目線で助言します。
リスクよりもリターンの可能性に注目し、長期的な成長ストーリーを重視します。
日本語で、平易な言葉で、簡潔に（200字以内）答えてください。`,
  },
  contrarian: {
    label: '逆張り屋',
    system: `あなたは逆張り投資家です。市場の常識に疑問を呈し、反対意見を積極的に述べます。
「みんなが思っていることの逆を考えよ」が信条です。思い込みを崩す役割を担います。
日本語で、平易な言葉で、簡潔に（200字以内）答えてください。`,
  },
  longterm: {
    label: '長期思考家',
    system: `あなたは長期投資家です。5年・10年スパンで物事を考え、短期のノイズを無視します。
配当・複利・時間の力を重視し、「今日の判断が10年後にどう影響するか」を軸に話します。
日本語で、平易な言葉で、簡潔に（200字以内）答えてください。`,
  },
}

async function getPortfolioContext(): Promise<string> {
  const [holdingsRes, ordersRes] = await Promise.all([
    adminSupabase.from('holdings').select('*'),
    adminSupabase.from('orders').select('*').eq('status', 'active'),
  ])
  const holdings = holdingsRes.data ?? []
  const orders = ordersRes.data ?? []
  const total = holdings.reduce((s, h) => s + (h.evaluation_amount ?? 0), 0)

  let ctx = `【ユーザーの現在の状況】\n`
  ctx += `・生年: 1975年（50歳）、子ども: 小4\n`
  ctx += `・投資目標: 15年後（65歳時）にDC別で3,000万円\n`
  ctx += `・投資経験: インデックス積立は長年のベテラン、個別株は2026年から始めたばかり\n`
  ctx += `・銀行預金: 約970万円（投資可能額: 約670万円）\n\n`
  ctx += `【保有銘柄（楽天証券、計約${Math.round(total / 10000)}万円）】\n`
  holdings.forEach(h => {
    ctx += `・${h.name}(${h.ticker}) ${h.account_type === 'tokutei' ? '特定口座' : 'NISA'}: `
    ctx += `評価額${h.evaluation_amount?.toLocaleString()}円 `
    ctx += `損益${h.unrealized_gain != null ? (h.unrealized_gain >= 0 ? '+' : '') + h.unrealized_gain?.toLocaleString() + '円' : '不明'}\n`
  })
  if (orders.length > 0) {
    ctx += `\n【執行中の注文】\n`
    orders.forEach(o => {
      ctx += `・${o.name} ${o.order_type === 'sell' ? '売り' : '買い'}指値${o.price}円 ${o.quantity}株 期限${o.deadline}\n`
    })
  }
  return ctx
}

async function askPersona(personaId: string, question: string, context: string, extraContext?: string): Promise<string> {
  const persona = PERSONAS[personaId as keyof typeof PERSONAS]
  const userContent = extraContext
    ? `${context}\n\n${extraContext}\n\n質問: ${question}`
    : `${context}\n\n質問: ${question}`

  const msg = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 400,
    system: persona.system,
    messages: [{ role: 'user', content: userContent }],
  })
  return msg.content[0].type === 'text' ? msg.content[0].text : ''
}

const MAIN_SYSTEM = `あなたは「投資アドバイザー」として、ユーザー（山田さん、50歳）の個人投資をサポートする総合アシスタントです。
以下の視点を統合して助言します：
- 守りの分析家（リスク・資本保全）
- 成長論者（上値余地・機会）
- 逆張り屋（市場の常識への疑問）
- 長期思考家（5〜15年スパン、複利・配当）

ユーザーの状況を常に念頭に置き、会話の文脈を引き継いで継続的に深い相談に応じてください。
回答は平易な日本語で、具体的・実践的に。長文でも構いません。必要に応じて箇条書きや数字を使ってください。
投資は最終的にユーザー自身の判断であることを念頭に、中立的かつ誠実に助言します。`

export async function POST(req: Request) {
  const body = await req.json()
  const { question, mode, round1, history } = body

  const context = await getPortfolioContext()

  if (mode === 'main') {
    const priorMessages: { role: 'user' | 'assistant'; content: string }[] = (history ?? []).map(
      (m: { role: string; content: string }) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      })
    )
    priorMessages.push({ role: 'user', content: `${context}\n\n質問: ${question}` })

    const msg = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 3000,
      system: MAIN_SYSTEM,
      messages: priorMessages,
    })
    const content = msg.content[0].type === 'text' ? msg.content[0].text : ''
    return NextResponse.json({ content })
  }

  if (mode === 'round1') {
    const personaIds = Object.keys(PERSONAS)
    const responses = await Promise.all(
      personaIds.map(async id => ({
        persona: id,
        label: PERSONAS[id as keyof typeof PERSONAS].label,
        content: await askPersona(id, question, context),
      }))
    )
    return NextResponse.json({ responses })
  }

  if (mode === 'round2' && round1) {
    // 4人の中で最も意見が分かれた組み合わせを1つ選んでコメントさせる
    const othersText = round1.map((r: { label: string; content: string }) => `【${r.label}の意見】\n${r.content}`).join('\n\n')
    const extraContext = `\n他のAIの意見:\n${othersText}\n\n上記の意見を読んだうえで、あなたの立場から補足・反論・同意を述べてください。`
    const contrarianResponse = await askPersona('contrarian', question, context, extraContext)
    return NextResponse.json({
      responses: [{ persona: 'contrarian', label: PERSONAS.contrarian.label, content: contrarianResponse }],
    })
  }

  return NextResponse.json({ error: 'invalid mode' }, { status: 400 })
}
