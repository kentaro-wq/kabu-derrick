import { NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { adminSupabase } from '@/lib/supabase'

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

export async function GET() {
  const [holdingsRes, ordersRes, tsumitateRes] = await Promise.all([
    adminSupabase.from('holdings').select('name, ticker, account_type, evaluation_amount, unrealized_gain'),
    adminSupabase.from('orders').select('name, order_type, price, deadline').eq('status', 'active'),
    adminSupabase.from('tsumitate_settings').select('name, monthly_amount'),
  ])

  const holdings = holdingsRes.data ?? []
  const orders = ordersRes.data ?? []
  const tsumitate = tsumitateRes.data ?? []

  let ctx = '保有銘柄: ' + holdings.map(h => `${h.name}(損益${h.unrealized_gain >= 0 ? '+' : ''}${h.unrealized_gain?.toLocaleString()}円)`).join(', ')
  if (tsumitate.length > 0) ctx += '\nNISA積立: ' + tsumitate.map((t: { name: string; monthly_amount: number }) => `${t.name}月${t.monthly_amount.toLocaleString()}円`).join(', ')
  if (orders.length > 0) ctx += '\n執行中注文: ' + orders.map(o => `${o.name}${o.order_type === 'sell' ? '売り' : '買い'}指値${o.price}円 期限${o.deadline}`).join(', ')

  const msg = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 300,
    messages: [{
      role: 'user',
      content: `以下は山田さん（50歳、個別株初心者、NISA活用中）の現在の投資状況です。\n${ctx}\n\n今この人が気になっていそうな投資相談の質問を4つ生成してください。具体的な銘柄名・金額・状況に言及した実践的な質問にしてください。JSON配列で返してください。例: ["質問1", "質問2", "質問3", "質問4"]`,
    }],
  })

  const text = msg.content[0].type === 'text' ? msg.content[0].text : '[]'
  try {
    const match = text.match(/\[[\s\S]*\]/)
    const suggestions = match ? JSON.parse(match[0]) : []
    return NextResponse.json({ suggestions })
  } catch {
    return NextResponse.json({ suggestions: [] })
  }
}
