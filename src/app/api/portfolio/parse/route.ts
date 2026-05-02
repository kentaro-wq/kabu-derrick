import { NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

export async function POST(req: Request) {
  const { imageData, imageType } = await req.json()
  if (!imageData) return NextResponse.json({ error: 'no image' }, { status: 400 })

  // base64 の基本チェック
  const base64Len = imageData.length
  const approxBytes = base64Len * 0.75
  console.log(`[parse] imageType=${imageType} base64Len=${base64Len} approxBytes=${Math.round(approxBytes / 1024)}KB`)

  if (approxBytes > 5 * 1024 * 1024) {
    return NextResponse.json({ error: '画像が大きすぎます（5MB超）。もう少し小さい画像でお試しください。' }, { status: 400 })
  }

  const mediaType = (imageType === 'image/png' || imageType === 'image/gif' || imageType === 'image/webp')
    ? imageType as 'image/png' | 'image/gif' | 'image/webp'
    : 'image/jpeg'

  try {
    const msg = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: mediaType, data: imageData },
          },
          {
            type: 'text',
            text: `この画像は楽天証券の保有銘柄一覧または損益管理画面です。
見えている各銘柄の情報をJSONで抽出してください。

口座種別のマッピング:
- NISA成長投資枠 → "nisa_growth"
- NISAつみたて投資枠 → "nisa_tsumitate"
- 特定口座 → "tokutei"
- DC・確定拠出 → "dc"

返却形式（JSONのみ、他のテキスト不要）:
{
  "holdings": [
    {
      "name": "銘柄名（正式名称）",
      "ticker": "証券コード（数字4桁または略称）",
      "account_type": "口座種別",
      "quantity": 保有株数（数値のみ）,
      "current_price": 現在値（数値のみ）,
      "purchase_price": 取得単価（数値のみ）,
      "evaluation_amount": 評価額（数値のみ）,
      "unrealized_gain": 評価損益（+/-の数値）,
      "unrealized_gain_pct": 評価損益率（+/-の数値、%記号なし）
    }
  ]
}

不明な項目はnullとしてください。JSONのみ返してください。`,
          },
        ],
      }],
    })

    const text = msg.content[0].type === 'text' ? msg.content[0].text : '{}'
    try {
      const match = text.match(/\{[\s\S]*\}/)
      const parsed = match ? JSON.parse(match[0]) : { holdings: [] }
      return NextResponse.json(parsed)
    } catch {
      return NextResponse.json({ error: '解析失敗', raw: text }, { status: 500 })
    }
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err)
    console.error('[parse] Anthropic error:', errMsg)
    return NextResponse.json({
      error: `AI解析エラー: ${errMsg.slice(0, 300)}`,
    }, { status: 500 })
  }
}
