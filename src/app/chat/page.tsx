'use client'
import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'

function renderMarkdown(text: string) {
  const lines = text.split('\n')
  const elements: React.ReactNode[] = []
  let key = 0

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    if (/^#{1,3}\s/.test(line)) {
      const content = line.replace(/^#{1,3}\s/, '')
      elements.push(
        <div key={key++} style={{ fontWeight: 700, fontSize: 15, marginTop: 10, marginBottom: 4, color: 'var(--accent)' }}>
          {inlineFormat(content)}
        </div>
      )
    } else if (/^[-*]\s/.test(line)) {
      elements.push(
        <div key={key++} style={{ display: 'flex', gap: 6, marginBottom: 2 }}>
          <span style={{ color: 'var(--accent)', flexShrink: 0 }}>•</span>
          <span>{inlineFormat(line.replace(/^[-*]\s/, ''))}</span>
        </div>
      )
    } else if (/^---+$/.test(line.trim())) {
      elements.push(<hr key={key++} style={{ border: 'none', borderTop: '1px solid var(--border)', margin: '10px 0' }} />)
    } else if (line.trim() === '') {
      elements.push(<div key={key++} style={{ height: 6 }} />)
    } else {
      elements.push(<div key={key++} style={{ marginBottom: 2 }}>{inlineFormat(line)}</div>)
    }
  }
  return elements
}

function inlineFormat(text: string): React.ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*|\*[^*]+\*)/g)
  return parts.map((p, i) => {
    if (p.startsWith('**') && p.endsWith('**'))
      return <strong key={i} style={{ fontWeight: 700, color: 'var(--text)' }}>{p.slice(2, -2)}</strong>
    if (p.startsWith('*') && p.endsWith('*'))
      return <em key={i}>{p.slice(1, -1)}</em>
    return p
  })
}

type Mode = 'main' | 'roundtable'

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

const SUGGESTIONS = [
  'NTTの指値、このまま維持すべきか？期限6/16まであと46日。',
  'NISA成長枠の残り136万円、何に投資するのがよいか？',
  '川崎重工と東京海上、どちらを優先的に買い増すべきか？',
  '今の円安傾向はポートフォリオにどう影響する？',
]

export default function ChatPage() {
  const [mode, setMode] = useState<Mode>('main')
  const [input, setInput] = useState('')
  const [messages, setMessages] = useState<Message[]>([])
  const [loading, setLoading] = useState(false)
  const [loadingText, setLoadingText] = useState('')
  const bottomRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, loading])

  // textareaの高さを内容に合わせて自動調整
  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value)
    const el = e.target
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 160) + 'px'
  }

  const sendMessage = async () => {
    if (!input.trim() || loading) return
    const question = input.trim()
    setInput('')
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
    setLoading(true)

    if (mode === 'main') {
      // 会話履歴を保持したメインチャット
      const history = messages
        .filter(m => m.persona !== 'error')
        .map(m => ({ role: m.role, content: m.content }))

      const userMsg: Message = { role: 'user', persona: 'user', content: question }
      setMessages(prev => [...prev, userMsg])
      setLoadingText('🤔 考え中...')

      try {
        const res = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ question, mode: 'main', history }),
        })
        const data = await res.json()
        setMessages(prev => [...prev, { role: 'assistant', persona: 'main', content: data.content }])
      } catch {
        setMessages(prev => [...prev, { role: 'assistant', persona: 'error', content: 'エラーが発生しました。再度お試しください。' }])
      }
    } else {
      // 円卓モード（毎回リセット）
      setMessages([{ role: 'user', persona: 'user', content: question }])
      setLoadingText('🤔 各AIが考え中...')

      try {
        const res = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ question, mode: 'round1' }),
        })
        const data = await res.json()
        setMessages(prev => [
          ...prev,
          ...data.responses.map((r: { persona: string; content: string }) => ({
            role: 'assistant' as const, persona: r.persona, content: r.content,
          }))
        ])

        setLoadingText('💭 他の意見を受けて再考中...')
        const res2 = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ question, mode: 'round2', round1: data.responses }),
        })
        const data2 = await res2.json()
        setMessages(prev => [
          ...prev,
          ...data2.responses.map((r: { persona: string; content: string }) => ({
            role: 'assistant' as const, persona: r.persona + '_reply', content: r.content,
          }))
        ])
      } catch {
        setMessages(prev => [...prev, { role: 'assistant', persona: 'error', content: 'エラーが発生しました。' }])
      }
    }

    setLoading(false)
    setLoadingText('')
  }

  const clearChat = () => {
    setMessages([])
    setInput('')
  }

  return (
    <div style={{ maxWidth: 520, margin: '0 auto', display: 'flex', flexDirection: 'column', height: '100dvh' }}>
      {/* ヘッダー */}
      <div style={{ padding: '14px 14px 10px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Link href="/" style={{ color: 'var(--muted)', textDecoration: 'none', fontSize: 20 }}>←</Link>
            <div>
              <div style={{ fontSize: 11, color: 'var(--muted)' }}>マイ株デリック</div>
              <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--accent)' }}>AI投資相談</div>
            </div>
          </div>
          {messages.length > 0 && (
            <button onClick={clearChat} style={{ fontSize: 11, color: 'var(--muted)', background: 'none', border: '1px solid var(--border)', borderRadius: 6, padding: '4px 10px', cursor: 'pointer' }}>
              会話をリセット
            </button>
          )}
        </div>

        {/* モード切替 */}
        <div style={{ display: 'flex', gap: 6 }}>
          {([
            { id: 'main', label: '💬 メイン相談', desc: '継続的な対話' },
            { id: 'roundtable', label: '🔄 円卓議論', desc: '4AI同時討論' },
          ] as const).map(m => (
            <button
              key={m.id}
              onClick={() => { setMode(m.id); clearChat() }}
              style={{
                flex: 1, padding: '8px 10px', borderRadius: 10, cursor: 'pointer', textAlign: 'center',
                border: `1px solid ${mode === m.id ? 'var(--accent)' : 'var(--border)'}`,
                background: mode === m.id ? 'rgba(99,102,241,0.15)' : 'var(--surface2)',
                color: mode === m.id ? 'var(--accent)' : 'var(--muted)',
              }}
            >
              <div style={{ fontSize: 12, fontWeight: 600 }}>{m.label}</div>
              <div style={{ fontSize: 10, marginTop: 2, opacity: 0.7 }}>{m.desc}</div>
            </button>
          ))}
        </div>
      </div>

      {/* メッセージ一覧 */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '16px 14px' }}>
        {messages.length === 0 && (
          <div style={{ color: 'var(--muted)', marginTop: 20 }}>
            <div style={{ textAlign: 'center', fontSize: 36, marginBottom: 10 }}>
              {mode === 'main' ? '💬' : '🔄'}
            </div>
            <div style={{ textAlign: 'center', fontSize: 13, marginBottom: 6 }}>
              {mode === 'main'
                ? 'あなたの状況を把握した上で、継続的に相談に応じます。'
                : '同じ質問を4つの視点で分析し、互いに討論します。'}
            </div>
            <div style={{ textAlign: 'center', fontSize: 11, color: 'var(--muted)', marginBottom: 20, opacity: 0.7 }}>
              {mode === 'main' ? '会話の文脈を引き継ぎます' : '質問ごとに新規ディスカッション'}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {SUGGESTIONS.map(q => (
                <button key={q} onClick={() => setInput(q)} style={{
                  background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10,
                  padding: '10px 14px', color: 'var(--text)', fontSize: 13, cursor: 'pointer', textAlign: 'left', lineHeight: 1.5
                }}>
                  {q}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((msg, i) => {
          if (msg.persona === 'user') {
            return (
              <div key={i} style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 14 }}>
                <div style={{
                  background: 'var(--accent)', color: '#fff',
                  borderRadius: '16px 16px 4px 16px', padding: '10px 14px',
                  maxWidth: '85%', fontSize: 14, lineHeight: 1.6, whiteSpace: 'pre-wrap'
                }}>
                  {msg.content}
                </div>
              </div>
            )
          }

          if (msg.persona === 'error') {
            return (
              <div key={i} style={{ color: 'var(--red)', fontSize: 13, marginBottom: 14, padding: '10px 14px', background: '#3b1515', borderRadius: 10 }}>
                {msg.content}
              </div>
            )
          }

          if (msg.persona === 'main') {
            return (
              <div key={i} style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 11, color: 'var(--accent)', marginBottom: 6, fontWeight: 600 }}>🤖 投資アドバイザー</div>
                <div style={{
                  background: 'var(--surface)', border: '1px solid rgba(99,102,241,0.3)',
                  borderRadius: '4px 16px 16px 16px', padding: '14px 16px',
                  fontSize: 14, lineHeight: 1.8, color: 'var(--text)',
                }}>
                  {renderMarkdown(msg.content)}
                </div>
              </div>
            )
          }

          // 円卓モード
          const isReply = msg.persona.endsWith('_reply')
          const personaId = isReply ? msg.persona.replace('_reply', '') : msg.persona
          const persona = PERSONAS.find(p => p.id === personaId) ?? PERSONAS[0]

          return (
            <div key={i} style={{ marginBottom: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 5 }}>
                <span style={{ fontSize: 13 }}>{persona.emoji}</span>
                <span style={{ fontSize: 11, fontWeight: 600, color: persona.color }}>{persona.label}</span>
                {isReply && <span style={{ fontSize: 10, color: 'var(--muted)', fontStyle: 'italic' }}>他の意見を受けて</span>}
              </div>
              <div style={{
                background: 'var(--surface)', border: `1px solid ${persona.color}33`,
                borderRadius: '4px 14px 14px 14px', padding: '11px 14px',
                fontSize: 14, lineHeight: 1.7, color: 'var(--text)',
              }}>
                {renderMarkdown(msg.content)}
              </div>
            </div>
          )
        })}

        {loading && (
          <div style={{ color: 'var(--muted)', fontSize: 13, padding: '12px 0', display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ animation: 'pulse 1.5s infinite' }}>⏳</span> {loadingText}
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* 入力エリア */}
      <div style={{
        padding: '12px 14px', borderTop: '1px solid var(--border)', background: 'var(--surface)',
        flexShrink: 0, paddingBottom: 'max(12px, env(safe-area-inset-bottom))'
      }}>
        {mode === 'main' && (
          <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 8 }}>
            Enterで改行 / 送信ボタン（↑）で送信
          </div>
        )}
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
          <textarea
            ref={textareaRef}
            value={input}
            onChange={handleInput}
            placeholder={mode === 'main' ? '投資について相談する...' : '質問を入力（円卓ディスカッション開始）'}
            rows={3}
            style={{
              flex: 1, background: 'var(--surface2)', border: '1px solid var(--border)',
              borderRadius: 12, padding: '10px 12px', color: 'var(--text)', fontSize: 14,
              resize: 'none', outline: 'none', lineHeight: 1.6, minHeight: 56, maxHeight: 160,
            }}
          />
          <button
            onClick={sendMessage}
            disabled={loading || !input.trim()}
            style={{
              width: 44, height: 44, borderRadius: 12, border: 'none', flexShrink: 0,
              background: loading || !input.trim() ? 'var(--surface2)' : 'var(--accent)',
              color: loading || !input.trim() ? 'var(--muted)' : '#fff',
              fontSize: 18, cursor: loading || !input.trim() ? 'not-allowed' : 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >
            ↑
          </button>
        </div>
      </div>
    </div>
  )
}
