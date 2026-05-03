import { NextResponse } from 'next/server'
import { geminiGenerate } from '@/lib/gemini'
import { adminSupabase } from '@/lib/supabase'

export const runtime = 'nodejs'

export async function POST(req: Request) {
  const { question, synthesis } = await req.json()
  if (!question || !synthesis) {
    return NextResponse.json({ error: 'missing params' }, { status: 400 })
  }

  // 現在の保有価格を取得して判断ログに付与できるよう取得
  const { data: holdings } = await adminSupabase.from('holdings').select('name, ticker, current_price')

  const priceMap: Record<string, number> = {}
  for (const h of holdings ?? []) {
    if (h.name && h.current_price) priceMap[h.name] = h.current_price
    if (h.ticker && h.current_price) priceMap[h.ticker] = h.current_price
  }

  const prompt = `以下の投資相談の統合まとめから、具体的な銘柄・テーマへの判断を最大3件抽出してください。

質問: ${question}

統合まとめ:
${synthesis.slice(0, 1500)}

【抽出ルール】
- 特定の銘柄・ETF・ファンドへの具体的推奨のみ（抽象的な市場観はNG）
- judgment_type: hold=保有継続推奨, sell=売却推奨, buy=買い増し推奨, watch=様子見, caution=警戒
- ai_summary: 判断理由を含む1行（40字以内）
- 判断が明確でない場合は judgments を空配列にしてください

JSONのみ返してください:
{
  "judgments": [
    {
      "name": "銘柄名またはテーマ名",
      "ticker": "証券コードまたはnull",
      "judgment_type": "hold|sell|buy|watch|caution",
      "ai_summary": "判断の一行サマリー"
    }
  ]
}`

  try {
    const text = await geminiGenerate({
      model: 'gemini-2.5-flash-lite',
      maxTokens: 512,
      timeoutMs: 20000,
      messages: [{ role: 'user', parts: [{ text: prompt }] }],
    })

    const match = text.match(/\{[\s\S]*\}/)
    if (!match) return NextResponse.json({ saved: 0 })

    const parsed = JSON.parse(match[0]) as { judgments: Array<{ name: string; ticker?: string; judgment_type: string; ai_summary: string }> }
    const judgments = parsed.judgments ?? []
    if (!judgments.length) return NextResponse.json({ saved: 0 })

    const rows = judgments.map(j => ({
      name: j.name,
      ticker: j.ticker ?? null,
      judgment_type: j.judgment_type,
      ai_summary: j.ai_summary,
      price_at_time: priceMap[j.name] ?? priceMap[j.ticker ?? ''] ?? null,
      question: question.slice(0, 100),
    }))

    await adminSupabase.from('ai_judgment_log').insert(rows)
    return NextResponse.json({ saved: rows.length })
  } catch (e) {
    console.error('[ai-judgment-extract] error:', e)
    return NextResponse.json({ saved: 0 })
  }
}
