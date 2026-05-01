'use client'
import { useState } from 'react'
import Link from 'next/link'

interface Message {
  role: 'user' | 'assistant'
  persona: string
  content: string
}

const PERSONAS = [
  { id: 'conservative', label: '守りの分析家', emoji: '🛡️', color: '#3b82f6' },
  { id: 'growth', label: '成長論者', emoji: '🚀', color: '#22c55e' },
  { id: 'contrarian', label: '逆張り屋', emoji: '⚡', color: '#f59e0b' },
  { id: 'longterm', label: '長期思考家', emoji: '🌲', color: '#a78bfa' },
]

export default function ChatPage() {
  const [input, setInput] = useState('')
  const [messages, setMessages] = useState<Message[]>([])
  const [loading, setLoading] = useState(false)
  const [round, setRound] = useState<'idle' | 'round1' | 'round2'>('idle')

  const sendMessage = async () => {
    if (!input.trim() || loading) return
    const question = input.trim()
    setInput('')
    setLoading(true)
    setRound('round1')
    setMessages([{ role: 'user', persona: 'user', content: question }])

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question, mode: 'round1' }),
      })
      const data = await res.json()
      const round1Messages: Message[] = data.responses.map((r: { persona: string; content: string }) => ({
        role: 'assistant' as const,
        persona: r.persona,
        content: r.content,
      }))
      setMessages(prev => [...prev, ...round1Messages])
      setRound('round2')

      const res2 = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question, mode: 'round2', round1: data.responses }),
      })
      const data2 = await res2.json()
      const round2Messages: Message[] = data2.responses.map((r: { persona: string; content: string }) => ({
        role: 'assistant' as const,
        persona: r.persona + '_reply',
        content: r.content,
      }))
      setMessages(prev => [...prev, round2Messages[0]])
    } catch {
      setMessages(prev => [...prev, { role: 'assistant', persona: 'error', content: 'エラーが発生しました。再度お試しください。' }])
    }
    setLoading(false)
    setRound('idle')
  }

  return (
    <div style={{ maxWidth: 480, margin: '0 auto', display: 'flex', flexDirection: 'column', height: '100dvh' }}>
      {/* ヘッダー */}
      <div style={{ padding: '16px 12px 12px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Link href="/" style={{ color: 'var(--muted)', textDecoration: 'none', fontSize: 20 }}>←</Link>
          <div>
            <div style={{ fontSize: 11, color: 'var(--muted)' }}>マイ株デリック</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--accent)' }}>AI円卓相談</div>
          </div>
        </div>
        {/* ペルソナ一覧 */}
        <div style={{ display: 'flex', gap: 6, marginTop: 12, flexWrap: 'wrap' }}>
          {PERSONAS.map(p => (
            <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '4px 10px', borderRadius: 99, background: 'var(--surface2)', border: '1px solid var(--border)' }}>
              <span style={{ fontSize: 12 }}>{p.emoji}</span>
              <span style={{ fontSize: 11, color: p.color }}>{p.label}</span>
            </div>
          ))}
        </div>
      </div>

      {/* メッセージ一覧 */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '16px 12px' }}>
        {messages.length === 0 && (
          <div style={{ textAlign: 'center', color: 'var(--muted)', marginTop: 40 }}>
            <div style={{ fontSize: 40, marginBottom: 12 }}>💬</div>
            <div style={{ fontSize: 14, marginBottom: 20 }}>4人のAIが円卓で議論します</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 300, margin: '0 auto' }}>
              {['NTTの指値、このまま持ち続けるべき？', 'NISA枠で次に買うべき銘柄は？', '今の市場環境でリスクはどう見る？'].map(q => (
                <button key={q} onClick={() => setInput(q)} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, padding: '10px 14px', color: 'var(--text)', fontSize: 13, cursor: 'pointer', textAlign: 'left' }}>
                  {q}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((msg, i) => {
          if (msg.persona === 'user') {
            return (
              <div key={i} style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 16 }}>
                <div style={{ background: 'var(--accent)', color: '#fff', borderRadius: '14px 14px 2px 14px', padding: '10px 14px', maxWidth: '80%', fontSize: 14 }}>
                  {msg.content}
                </div>
              </div>
            )
          }

          const isReply = msg.persona.endsWith('_reply')
          const personaId = isReply ? msg.persona.replace('_reply', '') : msg.persona
          const persona = PERSONAS.find(p => p.id === personaId) ?? PERSONAS[0]

          return (
            <div key={i} style={{ marginBottom: 14 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                <span style={{ fontSize: 14 }}>{persona.emoji}</span>
                <span style={{ fontSize: 11, fontWeight: 600, color: persona.color }}>{persona.label}</span>
                {isReply && <span style={{ fontSize: 10, color: 'var(--muted)' }}>（他の意見を受けて）</span>}
              </div>
              <div style={{ background: 'var(--surface)', border: `1px solid ${persona.color}33`, borderRadius: '2px 14px 14px 14px', padding: '12px 14px', fontSize: 14, lineHeight: 1.6, color: 'var(--text)' }}>
                {msg.content}
              </div>
            </div>
          )
        })}

        {loading && (
          <div style={{ color: 'var(--muted)', fontSize: 13, textAlign: 'center', padding: 20 }}>
            {round === 'round1' ? '🤔 各AIが考え中...' : '💭 他の意見を受けて再考中...'}
          </div>
        )}
      </div>

      {/* 入力エリア */}
      <div style={{ padding: '12px', borderTop: '1px solid var(--border)', background: 'var(--surface)', flexShrink: 0, paddingBottom: 'max(12px, env(safe-area-inset-bottom))' }}>
        <div style={{ display: 'flex', gap: 8 }}>
          <textarea
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage() } }}
            placeholder="株について相談する..."
            rows={2}
            style={{ flex: 1, background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 10, padding: '10px 12px', color: 'var(--text)', fontSize: 14, resize: 'none', outline: 'none' }}
          />
          <button
            onClick={sendMessage}
            disabled={loading || !input.trim()}
            style={{ padding: '0 16px', borderRadius: 10, border: 'none', background: loading ? 'var(--surface2)' : 'var(--accent)', color: '#fff', fontSize: 18, cursor: loading ? 'not-allowed' : 'pointer', flexShrink: 0 }}
          >
            ↑
          </button>
        </div>
      </div>
    </div>
  )
}
