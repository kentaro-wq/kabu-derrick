import { NextResponse } from 'next/server'
import { geminiGenerate } from '@/lib/gemini'

export const runtime = 'edge'

export async function POST(req: Request) {
  const { imageData, imageType } = await req.json()
  if (!imageData) return NextResponse.json({ error: 'no image' }, { status: 400 })

  const base64Len = imageData.length
  const approxBytes = base64Len * 0.75
  console.log(`[parse] imageType=${imageType} base64Len=${base64Len} approxBytes=${Math.round(approxBytes / 1024)}KB`)

  if (approxBytes > 5 * 1024 * 1024) {
    return NextResponse.json({ error: '画像が大きすぎます（5MB超）。もう少し小さい画像でお試しください。' }, { status: 400 })
  }

  const mediaType = (imageType === 'image/png' || imageType === 'image/gif' || imageType === 'image/webp')
    ? imageType as string
    : 'image/jpeg'

  try {
    console.log('[parse] calling Gemini API')
    const text = await geminiGenerate({
      model: 'gemini-2.5-flash-lite',
      maxTokens: 2048,
      messages: [{
        role: 'user',
        parts: [
          { inline_data: { mime_type: mediaType, data: imageData } },
          {
            text: `この画像は楽天証券の保有銘柄一覧または損益管理画面です。

【重要】画像に見えている行を1行1エントリとして、絶対に統合・省略せずに全て抽出してください。
- 同じ銘柄名でも口座種別が違う行は必ず別エントリにしてください
- 例: "eMAXIS Slim 先進国株式" が「NISAつみたて投資枠」と「つみたてNISA」に別々にある場合、必ず2エントリ返してください
- 行数を減らすことは絶対に禁止です

口座種別のマッピング:
- NISA成長投資枠 → "nisa_growth"
- NISAつみたて投資枠 → "nisa_tsumitate"
- つみたてNISA（旧NISA）→ "old_tsumitate"
- 特定口座 → "tokutei"
- DC・確定拠出 → "dc"

資産種別のマッピング:
- 国内株式 → "domestic_stock"
- 外国株式 → "foreign_stock"
- 投資信託 → "fund"
- ETF → "etf"

返却形式（JSONのみ、他のテキスト不要）:
{
  "holdings": [
    {
      "name": "銘柄名",
      "ticker": "証券コード",
      "account_type": "口座種別",
      "asset_type": "資産種別",
      "quantity": 保有株数またはnull,
      "current_price": 現在値またはnull,
      "purchase_price": 取得単価またはnull,
      "evaluation_amount": 評価額またはnull,
      "unrealized_gain": 評価損益またはnull,
      "unrealized_gain_pct": 評価損益率またはnull
    }
  ]
}

不明な項目はnullとしてください。JSONのみ返してください。`,
          },
        ],
      }],
    })

    console.log('[parse] raw response (first 500):', text.slice(0, 500))

    try {
      const holdingsMatch = text.match(/"holdings"\s*:\s*\[[\s\S]*?\]/)
      if (holdingsMatch) {
        const startIdx = text.lastIndexOf('{', text.indexOf(holdingsMatch[0]))
        const sub = text.slice(startIdx >= 0 ? startIdx : 0)
        let depth = 0, endIdx = -1
        for (let i = 0; i < sub.length; i++) {
          if (sub[i] === '{') depth++
          else if (sub[i] === '}') { depth--; if (depth === 0) { endIdx = i; break } }
        }
        const jsonStr = endIdx >= 0 ? sub.slice(0, endIdx + 1) : sub
        const parsed = JSON.parse(jsonStr)
        return NextResponse.json(parsed)
      }
      return NextResponse.json({ holdings: [] })
    } catch (parseErr) {
      console.error('[parse] JSON parse error:', parseErr, 'raw:', text.slice(0, 300))
      return NextResponse.json({ error: '解析失敗: AIが不正なJSONを返しました', raw: text.slice(0, 200) }, { status: 500 })
    }
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err)
    console.error('[parse] Gemini error:', errMsg)
    return NextResponse.json({ error: `AI解析エラー: ${errMsg.slice(0, 300)}` }, { status: 500 })
  }
}
