import { NextResponse } from 'next/server'
import { geminiGenerate } from '@/lib/gemini'

export const runtime = 'edge'

export async function POST(req: Request) {
  const { imageData, imageType } = await req.json()
  if (!imageData) return NextResponse.json({ error: 'no image' }, { status: 400 })

  const approxBytes = imageData.length * 0.75
  if (approxBytes > 5 * 1024 * 1024) {
    return NextResponse.json({ error: '画像が大きすぎます（5MB超）' }, { status: 400 })
  }

  const mediaType = (imageType === 'image/png' || imageType === 'image/gif' || imageType === 'image/webp')
    ? imageType as string
    : 'image/jpeg'

  try {
    const text = await geminiGenerate({
      model: 'gemini-2.5-flash-lite',
      maxTokens: 2048,
      messages: [{
        role: 'user',
        parts: [
          { inline_data: { mime_type: mediaType, data: imageData } },
          {
            text: `この画像は楽天証券の注文照会または注文一覧画面です。表示されている注文を全て抽出してください。

売買区分のマッピング:
- 買い・買付 → "buy"
- 売り・売付 → "sell"

注文方法のマッピング:
- 指値 → "limit"
- 成行 → "market"
- 逆指値・その他 → "limit"

口座種別のマッピング:
- NISA成長投資枠 → "nisa_growth"
- NISAつみたて投資枠 → "nisa_tsumitate"
- 特定口座 → "tokutei"
- DC・確定拠出 → "dc"

注文状況のマッピング:
- 注文中・受付・未約定 → "active"
- 約定済み・全部約定 → "executed"
- 取消・失効 → "cancelled"

返却形式（JSONのみ）:
{
  "orders": [
    {
      "name": "銘柄名",
      "ticker": "証券コード（4桁）またはnull",
      "order_type": "buy|sell",
      "order_method": "limit|market",
      "price": 指値価格（数値）またはnull,
      "quantity": 注文株数（数値）,
      "account_type": "口座種別",
      "deadline": "期限日（YYYY-MM-DD形式）またはnull",
      "order_number": "注文番号またはnull",
      "status": "active|executed|cancelled"
    }
  ]
}

不明な項目はnullとしてください。JSONのみ返してください。`,
          },
        ],
      }],
    })

    const match = text.match(/\{[\s\S]*\}/)
    if (!match) return NextResponse.json({ orders: [] })

    const startIdx = text.lastIndexOf('{', text.indexOf(match[0]))
    const sub = text.slice(startIdx >= 0 ? startIdx : 0)
    let depth = 0, endIdx = -1
    for (let i = 0; i < sub.length; i++) {
      if (sub[i] === '{') depth++
      else if (sub[i] === '}') { depth--; if (depth === 0) { endIdx = i; break } }
    }
    const jsonStr = endIdx >= 0 ? sub.slice(0, endIdx + 1) : sub
    const parsed = JSON.parse(jsonStr)
    return NextResponse.json(parsed)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: `解析エラー: ${msg.slice(0, 200)}` }, { status: 500 })
  }
}
