import { NextResponse } from 'next/server'

export const runtime = 'edge'

// ブラウザから直接アクセスして原因を確認するエンドポイント
// https://kabu-derrick.vercel.app/api/portfolio/diagnose
export async function GET() {
  const result: Record<string, unknown> = {}

  const apiKey = process.env.GEMINI_API_KEY
  result.apiKeySet = !!apiKey
  result.apiKeyLength = apiKey ? apiKey.length : 0
  result.apiKeyPrefix = apiKey ? apiKey.slice(0, 8) + '...' : '(none)'

  if (!apiKey) {
    return NextResponse.json({ ...result, error: 'GEMINI_API_KEY is not set in Vercel env vars' }, { status: 500 })
  }

  // まず利用可能なモデル一覧を取得
  try {
    const listRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`,
      { signal: AbortSignal.timeout(10000) }
    )
    const listData = await listRes.json() as { models?: Array<{ name: string }> }
    result.availableModels = (listData.models ?? []).map((m: { name: string }) => m.name).filter((n: string) => n.includes('gemini'))
  } catch {
    result.availableModels = 'fetch failed'
  }

  const t0 = Date.now()
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: 'ping' }] }],
          generationConfig: { maxOutputTokens: 10 },
        }),
        signal: AbortSignal.timeout(10000),
      }
    )

    result.httpStatus = res.status
    result.elapsedMs = Date.now() - t0

    if (!res.ok) {
      const errText = await res.text()
      result.apiError = errText.slice(0, 500)
      return NextResponse.json({ ...result, error: 'Gemini API returned error' }, { status: 500 })
    }

    const data = await res.json() as { candidates?: Array<{ content: { parts: Array<{ text: string }> } }> }
    result.responseText = data.candidates?.[0]?.content?.parts?.[0]?.text
    result.ok = true

    return NextResponse.json(result)
  } catch (err: unknown) {
    result.elapsedMs = Date.now() - t0
    result.fetchError = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ ...result, error: 'fetch threw an exception' }, { status: 500 })
  }
}
