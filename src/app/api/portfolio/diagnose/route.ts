import { NextResponse } from 'next/server'

export const runtime = 'edge'

// このエンドポイントにブラウザからアクセスすると原因が分かる
// https://kabu-derrick.vercel.app/api/portfolio/diagnose
export async function GET() {
  const result: Record<string, unknown> = {}

  // 1. 環境変数チェック
  const apiKey = process.env.ANTHROPIC_API_KEY
  result.apiKeySet = !!apiKey
  result.apiKeyLength = apiKey ? apiKey.length : 0
  result.apiKeyPrefix = apiKey ? apiKey.slice(0, 8) + '...' : '(none)'

  if (!apiKey) {
    return NextResponse.json({ ...result, error: 'ANTHROPIC_API_KEY is not set in Vercel env vars' }, { status: 500 })
  }

  // 2. Anthropic APIへのテキストのみ疎通テスト（画像なし・最小トークン）
  const t0 = Date.now()
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-3-5-haiku-20241022',
        max_tokens: 10,
        messages: [{ role: 'user', content: 'ping' }],
      }),
      signal: AbortSignal.timeout(10000),
    })

    result.httpStatus = res.status
    result.elapsedMs = Date.now() - t0

    if (!res.ok) {
      const errText = await res.text()
      result.apiError = errText.slice(0, 500)
      return NextResponse.json({ ...result, error: 'Anthropic API returned error' }, { status: 500 })
    }

    const data = await res.json() as { content: Array<{ type: string; text: string }>; model: string }
    result.model = data.model
    result.responseText = data.content?.[0]?.text
    result.ok = true

    return NextResponse.json(result)
  } catch (err: unknown) {
    result.elapsedMs = Date.now() - t0
    result.fetchError = err instanceof Error ? err.message : String(err)
    result.fetchErrorType = err instanceof Error ? err.constructor.name : typeof err
    return NextResponse.json({ ...result, error: 'fetch threw an exception' }, { status: 500 })
  }
}
