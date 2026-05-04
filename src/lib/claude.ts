import Anthropic from '@anthropic-ai/sdk'

type TextPart = { text: string }
type ImagePart = { inline_data: { mime_type: string; data: string } }
type Part = TextPart | ImagePart
export type ClaudeMessage = { role: 'user' | 'model'; parts: Part[] }

// GeminiMessageと同じ型シグネチャで呼べるように合わせている
export async function claudeGenerate({
  model = 'claude-sonnet-4-6',
  system,
  messages,
  maxTokens = 1000,
}: {
  model?: string
  system?: string
  messages: ClaudeMessage[]
  maxTokens?: number
  timeoutMs?: number // Geminiとの互換のため受け取るが未使用（SDKのデフォルトタイムアウトに任せる）
}): Promise<string> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

  // Gemini形式（role:'model', parts配列）→ Anthropic形式（role:'assistant', content配列）に変換
  const anthropicMessages: Anthropic.MessageParam[] = messages.map(m => ({
    role: m.role === 'model' ? 'assistant' : 'user',
    content: m.parts.map(p => {
      if ('inline_data' in p) {
        return {
          type: 'image' as const,
          source: {
            type: 'base64' as const,
            media_type: p.inline_data.mime_type as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
            data: p.inline_data.data,
          },
        }
      }
      return { type: 'text' as const, text: p.text }
    }),
  }))

  const response = await client.messages.create({
    model,
    max_tokens: maxTokens,
    ...(system ? { system } : {}),
    messages: anthropicMessages,
  })

  const textBlock = response.content.find(b => b.type === 'text')
  return textBlock?.type === 'text' ? textBlock.text : ''
}
