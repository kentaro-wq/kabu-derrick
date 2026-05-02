import { NextResponse } from 'next/server'

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

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    console.error('[parse] ANTHROPIC_API_KEY is not set')
    return NextResponse.json({ error: 'サーバー設定エラー: APIキーが未設定です' }, { status: 500 })
  }
  console.log('[parse] API key present, length=', apiKey.length)

  const mediaType = (imageType === 'image/png' || imageType === 'image/gif' || imageType === 'image/webp')
    ? imageType as 'image/png' | 'image/gif' | 'image/webp'
    : 'image/jpeg'

  const body = JSON.stringify({
    model: 'claude-3-5-haiku-20241022',
    max_tokens: 1024,
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
      "name": "銘柄名",
      "ticker": "証券コード",
      "account_type": "口座種別",
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

  console.log('[parse] calling Anthropic API via fetch, body length=', body.length)

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body,
      signal: AbortSignal.timeout(20000),
    })

    console.log('[parse] Anthropic response status=', res.status)

    if (!res.ok) {
      const errText = await res.text()
      console.error('[parse] Anthropic error response:', errText.slice(0, 500))
      return NextResponse.json({ error: `AI APIエラー(${res.status}): ${errText.slice(0, 200)}` }, { status: 500 })
    }

    const data = await res.json() as { content: Array<{ type: string; text: string }> }
    const text = data.content?.[0]?.type === 'text' ? data.content[0].text : '{}'
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
    console.error('[parse] fetch error:', errMsg)
    return NextResponse.json({
      error: `AI解析エラー: ${errMsg.slice(0, 300)}`,
    }, { status: 500 })
  }
}
