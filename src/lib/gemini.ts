const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1/models'

type TextPart = { text: string }
type ImagePart = { inline_data: { mime_type: string; data: string } }
type Part = TextPart | ImagePart
export type GeminiMessage = { role: 'user' | 'model'; parts: Part[] }

export async function geminiGenerate({
  model = 'gemini-2.0-flash-lite',
  system,
  messages,
  maxTokens = 1000,
}: {
  model?: string
  system?: string
  messages: GeminiMessage[]
  maxTokens?: number
}): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set')

  const body: Record<string, unknown> = {
    contents: messages,
    generationConfig: { maxOutputTokens: maxTokens },
  }
  if (system) {
    body.system_instruction = { parts: [{ text: system }] }
  }

  const res = await fetch(
    `${GEMINI_BASE}/${model}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(25000),
    }
  )

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Gemini API error ${res.status}: ${err.slice(0, 300)}`)
  }

  const data = await res.json() as {
    candidates?: Array<{ content: { parts: Array<{ text: string }> } }>
  }
  return data.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
}
