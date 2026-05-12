const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models'

type TextPart = { text: string }
type ImagePart = { inline_data: { mime_type: string; data: string } }
type Part = TextPart | ImagePart
export type GeminiMessage = { role: 'user' | 'model'; parts: Part[] }

export async function geminiGenerate({
  model = 'gemini-2.5-flash',
  system,
  messages,
  maxTokens = 1000,
  timeoutMs = 25000,
  disableThinking = false,
}: {
  model?: string
  system?: string
  messages: GeminiMessage[]
  maxTokens?: number
  timeoutMs?: number
  disableThinking?: boolean
}): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set')

  const generationConfig: Record<string, unknown> = { maxOutputTokens: maxTokens }
  if (disableThinking) {
    generationConfig.thinkingConfig = { thinkingBudget: 0 }
  }

  const body: Record<string, unknown> = {
    contents: messages,
    generationConfig,
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
      signal: AbortSignal.timeout(timeoutMs),
    }
  )

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Gemini API error ${res.status}: ${err.slice(0, 300)}`)
  }

  const data = await res.json() as {
    candidates?: Array<{ content: { parts: Array<{ text?: string; thought?: boolean }> } }>
  }
  const parts = data.candidates?.[0]?.content?.parts ?? []
  const textPart = parts.find(p => !p.thought && p.text != null) ?? parts[parts.length - 1]
  return textPart?.text ?? ''
}
