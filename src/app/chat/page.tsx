'use client'
import { useEffect, useRef, useState, useCallback } from 'react'
import Link from 'next/link'

function renderMarkdown(text: string) {
  const lines = text.split('\n')
  const elements: React.ReactNode[] = []
  let key = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^#{1,3}\s/.test(line)) {
      elements.push(<div key={key++} style={{ fontWeight: 700, fontSize: 15, marginTop: 10, marginBottom: 4, color: 'var(--accent)' }}>{inlineFormat(line.replace(/^#{1,3}\s/, ''))}</div>)
    } else if (/^[-*]\s/.test(line)) {
      elements.push(<div key={key++} style={{ display: 'flex', gap: 6, marginBottom: 2 }}><span style={{ color: 'var(--accent)', flexShrink: 0 }}>•</span><span>{inlineFormat(line.replace(/^[-*]\s/, ''))}</span></div>)
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
    if (p.startsWith('**') && p.endsWith('**')) return <strong key={i} style={{ fontWeight: 700 }}>{p.slice(2, -2)}</strong>
    if (p.startsWith('*') && p.endsWith('*')) return <em key={i}>{p.slice(1, -1)}</em>
    return p
  })
}

function formatDate(iso: string) {
  const d = new Date(iso), now = new Date(), diff = now.getTime() - d.getTime()
  if (diff < 60000) return 'たった今'
  if (diff < 3600000) return `${Math.floor(diff / 60000)}分前`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}時間前`
  if (diff < 7 * 86400000) return `${Math.floor(diff / 86400000)}日前`
  return `${d.getMonth() + 1}/${d.getDate()}`
}

type Mode = 'main' | 'roundtable'

interface SubMessage {
  persona: string
  content: string
  isReply?: boolean
}

interface Message {
  role: 'user' | 'assistant'
  persona: string
  content: string
  subMessages?: SubMessage[]
}

interface Session {
  id: string
  title: string
  messages: Message[]
  created_at: string
  updated_at: string
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
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [showHistory, setShowHistory] = useState(false)
  const [sessions, setSessions] = useState<Session[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [imageData, setImageData] = useState<string | null>(null)
  const [imageType, setImageType] = useState<string>('image/jpeg')
  const [imagePreview, setImagePreview] = useState<string | null>(null)
  const [expandedRoundtables, setExpandedRoundtables] = useState<Set<number>>(new Set())
  const bottomRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, loading])

  const saveSession = useCallback(async (msgs: Message[], sid: string | null, firstQuestion: string) => {
    const body = sid
      ? { id: sid, messages: msgs }
      : { title: firstQuestion.slice(0, 40), messages: msgs }
    const res = await fetch('/api/chat-sessions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    const data = await res.json()
    return data.id as string
  }, [])

  const loadHistory = async () => {
    setHistoryLoading(true)
    const res = await fetch('/api/chat-sessions')
    const data = await res.json()
    setSessions(data.sessions ?? [])
    setHistoryLoading(false)
  }

  const resumeSession = (session: Session) => {
    setMessages(session.messages)
    setSessionId(session.id)
    setMode('main')
    setShowHistory(false)
  }

  const deleteSession = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation()
    await fetch('/api/chat-sessions', {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }),
    })
    setSessions(prev => prev.filter(s => s.id !== id))
  }

  const handleImageSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = (ev) => {
      const img = new Image()
      img.onload = () => {
        const maxPx = 1024
        const scale = Math.min(1, maxPx / Math.max(img.width, img.height))
        const canvas = document.createElement('canvas')
        canvas.width = Math.round(img.width * scale)
        canvas.height = Math.round(img.height * scale)
        canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height)
        const compressed = canvas.toDataURL('image/jpeg', 0.8)
        setImagePreview(compressed)
        setImageType('image/jpeg')
        setImageData(compressed.split(',')[1])
      }
      img.src = ev.target?.result as string
    }
    reader.readAsDataURL(file)
    e.target.value = ''
  }

  const clearImage = () => { setImageData(null); setImagePreview(null) }

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value)
    const el = e.target
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 160) + 'px'
  }

  // 円卓+統合まとめを実行して結果を返す共通関数
  const runRoundtable = async (question: string): Promise<{ synthesis: string; subMessages: SubMessage[] }> => {
    setLoadingText('🤔 各AIが考え中...')
    const res1 = await fetch('/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, mode: 'round1' }),
    })
    const data1 = await res1.json()

    setLoadingText('💭 他の意見を受けて再考中...')
    const res2 = await fetch('/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, mode: 'round2', round1: data1.responses }),
    })
    const data2 = await res2.json()

    setLoadingText('🔮 統合まとめを作成中...')
    const res3 = await fetch('/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, mode: 'synthesis', round1: data1.responses, round2: data2.responses }),
    })
    const data3 = await res3.json()

    const subMessages: SubMessage[] = [
      ...data1.responses.map((r: { persona: string; content: string }) => ({ persona: r.persona, content: r.content })),
      ...data2.responses.map((r: { persona: string; content: string }) => ({ persona: r.persona + '_reply', content: r.content, isReply: true })),
    ]

    return { synthesis: data3.content, subMessages }
  }

  const sendMessage = async () => {
    if (!input.trim() || loading) return
    const question = input.trim()
    setInput('')
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
    setLoading(true)

    if (mode === 'main') {
      const history = messages
        .filter(m => m.persona !== 'error')
        .map(m => ({
          role: m.role,
          content: m.persona === 'roundtable_synthesis' ? `[円卓討論の統合結論]\n${m.content}` : m.content,
        }))
      const userMsg: Message = { role: 'user', persona: 'user', content: imagePreview ? `[画像添付]\n${question}` : question }
      const nextMessages = [...messages, userMsg]
      setMessages(nextMessages)
      setLoadingText('🤔 考え中...')
      const capturedImage = imageData
      const capturedType = imageType
      clearImage()
      try {
        const res = await fetch('/api/chat', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ question, mode: 'main', history, imageData: capturedImage, imageType: capturedType }),
        })
        const data = await res.json()
        const aiMsg: Message = { role: 'assistant', persona: 'main', content: data.content }
        const finalMessages = [...nextMessages, aiMsg]
        setMessages(finalMessages)
        saveSession(finalMessages, sessionId, question).then(id => { if (!sessionId) setSessionId(id) })
      } catch {
        setMessages(prev => [...prev, { role: 'assistant', persona: 'error', content: 'エラーが発生しました。再度お試しください。' }])
      }
    } else {
      // 円卓モード → 統合まとめ → メインへ移行
      const userMsg: Message = { role: 'user', persona: 'user', content: question }
      setMessages([userMsg])
      try {
        const { synthesis, subMessages } = await runRoundtable(question)
        const synthesisMsg: Message = { role: 'assistant', persona: 'roundtable_synthesis', content: synthesis, subMessages }
        const finalMessages = [userMsg, synthesisMsg]
        setMessages(finalMessages)
        setMode('main')
        saveSession(finalMessages, null, question).then(id => setSessionId(id))
      } catch {
        setMessages(prev => [...prev, { role: 'assistant', persona: 'error', content: 'エラーが発生しました。' }])
      }
    }

    setLoading(false)
    setLoadingText('')
  }

  // メインモードから円卓に投げる
  const sendToRoundtable = async () => {
    if (!input.trim() || loading) return
    const question = input.trim()
    setInput('')
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
    setLoading(true)

    const userMsg: Message = { role: 'user', persona: 'user', content: `🔄 円卓に投げる: ${question}` }
    const nextMessages = [...messages, userMsg]
    setMessages(nextMessages)

    try {
      const { synthesis, subMessages } = await runRoundtable(question)
      const synthesisMsg: Message = { role: 'assistant', persona: 'roundtable_synthesis', content: synthesis, subMessages }
      const finalMessages = [...nextMessages, synthesisMsg]
      setMessages(finalMessages)
      saveSession(finalMessages, sessionId, question).then(id => { if (!sessionId) setSessionId(id) })
    } catch {
      setMessages(prev => [...prev, { role: 'assistant', persona: 'error', content: 'エラーが発生しました。' }])
    }

    setLoading(false)
    setLoadingText('')
  }

  const clearChat = () => { setMessages([]); setInput(''); setSessionId(null) }

  const toggleRoundtable = (idx: number) => {
    setExpandedRoundtables(prev => {
      const next = new Set(prev)
      next.has(idx) ? next.delete(idx) : next.add(idx)
      return next
    })
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
          <div style={{ display: 'flex', gap: 6 }}>
            <button onClick={() => { setShowHistory(true); loadHistory() }} style={{ fontSize: 11, color: 'var(--muted)', background: 'none', border: '1px solid var(--border)', borderRadius: 6, padding: '4px 10px', cursor: 'pointer' }}>📋 履歴</button>
            {messages.length > 0 && (
              <button onClick={clearChat} style={{ fontSize: 11, color: 'var(--muted)', background: 'none', border: '1px solid var(--border)', borderRadius: 6, padding: '4px 10px', cursor: 'pointer' }}>新規</button>
            )}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          {([
            { id: 'main', label: '💬 メイン相談', desc: '継続的な対話' },
            { id: 'roundtable', label: '🔄 円卓議論', desc: '4AI討論→統合' },
          ] as const).map(m => (
            <button key={m.id} onClick={() => { setMode(m.id); clearChat() }} style={{
              flex: 1, padding: '8px 10px', borderRadius: 10, cursor: 'pointer', textAlign: 'center',
              border: `1px solid ${mode === m.id ? 'var(--accent)' : 'var(--border)'}`,
              background: mode === m.id ? 'rgba(99,102,241,0.15)' : 'var(--surface2)',
              color: mode === m.id ? 'var(--accent)' : 'var(--muted)',
            }}>
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
            <div style={{ textAlign: 'center', fontSize: 36, marginBottom: 10 }}>{mode === 'main' ? '💬' : '🔄'}</div>
            <div style={{ textAlign: 'center', fontSize: 13, marginBottom: 6 }}>
              {mode === 'main' ? 'あなたの状況を把握した上で、継続的に相談に応じます。' : '4つの視点で討論し、統合まとめをメイン相談に引き継ぎます。'}
            </div>
            <div style={{ textAlign: 'center', fontSize: 11, marginBottom: 20, opacity: 0.7 }}>
              {mode === 'main' ? 'メイン相談中に🔄ボタンで円卓にも投げられます' : '円卓終了後は自動でメイン相談に移行します'}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {SUGGESTIONS.map(q => (
                <button key={q} onClick={() => setInput(q)} style={{
                  background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10,
                  padding: '10px 14px', color: 'var(--text)', fontSize: 13, cursor: 'pointer', textAlign: 'left', lineHeight: 1.5
                }}>{q}</button>
              ))}
            </div>
          </div>
        )}

        {messages.map((msg, i) => {
          if (msg.persona === 'user') {
            return (
              <div key={i} style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 14 }}>
                <div style={{ background: 'var(--accent)', color: '#fff', borderRadius: '16px 16px 4px 16px', padding: '10px 14px', maxWidth: '85%', fontSize: 14, lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
                  {msg.content}
                </div>
              </div>
            )
          }

          if (msg.persona === 'error') {
            return <div key={i} style={{ color: 'var(--red)', fontSize: 13, marginBottom: 14, padding: '10px 14px', background: '#3b1515', borderRadius: 10 }}>{msg.content}</div>
          }

          if (msg.persona === 'main') {
            return (
              <div key={i} style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 11, color: 'var(--accent)', marginBottom: 6, fontWeight: 600 }}>🤖 投資アドバイザー</div>
                <div style={{ background: 'var(--surface)', border: '1px solid rgba(99,102,241,0.3)', borderRadius: '4px 16px 16px 16px', padding: '14px 16px', fontSize: 14, lineHeight: 1.8, color: 'var(--text)' }}>
                  {renderMarkdown(msg.content)}
                </div>
              </div>
            )
          }

          if (msg.persona === 'roundtable_synthesis') {
            const expanded = expandedRoundtables.has(i)
            const subCount = msg.subMessages?.length ?? 0
            return (
              <div key={i} style={{ marginBottom: 16 }}>
                {/* 統合まとめ */}
                <div style={{ fontSize: 11, color: '#f59e0b', marginBottom: 6, fontWeight: 600 }}>🔮 円卓 統合まとめ → 投資アドバイザー</div>
                <div style={{ background: 'var(--surface)', border: '1px solid rgba(245,158,11,0.4)', borderRadius: '4px 16px 16px 16px', padding: '14px 16px', fontSize: 14, lineHeight: 1.8, color: 'var(--text)' }}>
                  {renderMarkdown(msg.content)}
                </div>
                {/* 円卓の議論トグル */}
                {subCount > 0 && (
                  <button onClick={() => toggleRoundtable(i)} style={{
                    marginTop: 6, fontSize: 11, color: 'var(--muted)', background: 'none',
                    border: '1px solid var(--border)', borderRadius: 6, padding: '4px 10px', cursor: 'pointer',
                  }}>
                    {expanded ? '▲ 円卓の議論を閉じる' : `▶ 円卓の議論を見る（${subCount}件）`}
                  </button>
                )}
                {/* 折りたたみ内容 */}
                {expanded && msg.subMessages && (
                  <div style={{ marginTop: 8, paddingLeft: 8, borderLeft: '2px solid var(--border)' }}>
                    {msg.subMessages.map((sub, j) => {
                      const isReply = sub.persona.endsWith('_reply')
                      const personaId = isReply ? sub.persona.replace('_reply', '') : sub.persona
                      const persona = PERSONAS.find(p => p.id === personaId) ?? PERSONAS[0]
                      return (
                        <div key={j} style={{ marginBottom: 10 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                            <span style={{ fontSize: 12 }}>{persona.emoji}</span>
                            <span style={{ fontSize: 10, fontWeight: 600, color: persona.color }}>{persona.label}</span>
                            {isReply && <span style={{ fontSize: 9, color: 'var(--muted)', fontStyle: 'italic' }}>他の意見を受けて</span>}
                          </div>
                          <div style={{ background: 'var(--surface2)', border: `1px solid ${persona.color}22`, borderRadius: 8, padding: '8px 10px', fontSize: 12, lineHeight: 1.6, color: 'var(--text)' }}>
                            {renderMarkdown(sub.content)}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            )
          }

          // 従来の円卓メッセージ（後方互換）
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
              <div style={{ background: 'var(--surface)', border: `1px solid ${persona.color}33`, borderRadius: '4px 14px 14px 14px', padding: '11px 14px', fontSize: 14, lineHeight: 1.7, color: 'var(--text)' }}>
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
      <div style={{ padding: '12px 14px', borderTop: '1px solid var(--border)', background: 'var(--surface)', flexShrink: 0, paddingBottom: 'max(12px, env(safe-area-inset-bottom))' }}>
        {imagePreview && (
          <div style={{ marginBottom: 8, position: 'relative', display: 'inline-block' }}>
            <img src={imagePreview} alt="添付" style={{ height: 72, borderRadius: 8, border: '1px solid var(--border)', display: 'block' }} />
            <button onClick={clearImage} style={{ position: 'absolute', top: -6, right: -6, width: 20, height: 20, borderRadius: '50%', background: '#333', border: 'none', color: '#fff', fontSize: 12, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>×</button>
          </div>
        )}
        {!imagePreview && (
          <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 8 }}>
            {mode === 'main' ? 'Enterで改行 / ↑で送信 / 🔄で円卓に投げる' : 'Enterで改行 / ↑で送信（円卓→統合→メイン移行）'}
          </div>
        )}
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
          <input ref={fileInputRef} type="file" accept="image/*" onChange={handleImageSelect} style={{ display: 'none' }} />
          <button onClick={() => fileInputRef.current?.click()} style={{ width: 44, height: 44, borderRadius: 12, border: '1px solid var(--border)', background: 'var(--surface2)', color: 'var(--muted)', fontSize: 20, cursor: 'pointer', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>📷</button>
          <textarea
            ref={textareaRef}
            value={input}
            onChange={handleInput}
            placeholder={mode === 'main' ? '投資について相談する...' : '質問を入力（円卓ディスカッション開始）'}
            rows={3}
            style={{ flex: 1, background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 12, padding: '10px 12px', color: 'var(--text)', fontSize: 14, resize: 'none', outline: 'none', lineHeight: 1.6, minHeight: 56, maxHeight: 160 }}
          />
          {/* メインモードのみ：円卓に投げるボタン */}
          {mode === 'main' && (
            <button onClick={sendToRoundtable} disabled={loading || !input.trim()} style={{
              width: 44, height: 44, borderRadius: 12, border: 'none', flexShrink: 0,
              background: loading || !input.trim() ? 'var(--surface2)' : 'rgba(245,158,11,0.2)',
              color: loading || !input.trim() ? 'var(--muted)' : '#f59e0b',
              fontSize: 18, cursor: loading || !input.trim() ? 'not-allowed' : 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>🔄</button>
          )}
          <button onClick={sendMessage} disabled={loading || (!input.trim() && !imageData)} style={{
            width: 44, height: 44, borderRadius: 12, border: 'none', flexShrink: 0,
            background: loading || (!input.trim() && !imageData) ? 'var(--surface2)' : 'var(--accent)',
            color: loading || (!input.trim() && !imageData) ? 'var(--muted)' : '#fff',
            fontSize: 18, cursor: loading || (!input.trim() && !imageData) ? 'not-allowed' : 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>↑</button>
        </div>
      </div>

      {/* 履歴パネル */}
      {showHistory && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 50, background: 'rgba(0,0,0,0.6)' }} onClick={() => setShowHistory(false)}>
          <div style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: '85%', maxWidth: 400, background: 'var(--surface)', borderLeft: '1px solid var(--border)', display: 'flex', flexDirection: 'column', paddingBottom: 'env(safe-area-inset-bottom)' }} onClick={e => e.stopPropagation()}>
            <div style={{ padding: '16px 16px 12px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text)' }}>📋 過去の相談</div>
              <button onClick={() => setShowHistory(false)} style={{ background: 'none', border: 'none', color: 'var(--muted)', fontSize: 20, cursor: 'pointer' }}>×</button>
            </div>
            <div style={{ flex: 1, overflowY: 'auto', padding: '8px 0' }}>
              {historyLoading && <div style={{ color: 'var(--muted)', fontSize: 13, padding: '20px 16px', textAlign: 'center' }}>読み込み中...</div>}
              {!historyLoading && sessions.length === 0 && <div style={{ color: 'var(--muted)', fontSize: 13, padding: '20px 16px', textAlign: 'center' }}>まだ相談履歴がありません</div>}
              {sessions.map(s => (
                <div key={s.id} onClick={() => resumeSession(s)} style={{ padding: '12px 16px', cursor: 'pointer', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, color: 'var(--text)', fontWeight: 500, marginBottom: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.title}</div>
                    <div style={{ fontSize: 11, color: 'var(--muted)' }}>{formatDate(s.updated_at)} · {s.messages.filter(m => m.persona === 'user').length}問</div>
                  </div>
                  <button onClick={(e) => deleteSession(s.id, e)} style={{ background: 'none', border: 'none', color: 'var(--muted)', fontSize: 16, cursor: 'pointer', flexShrink: 0, padding: '2px 4px', opacity: 0.5 }}>🗑</button>
                </div>
              ))}
            </div>
            <div style={{ padding: '12px 16px', borderTop: '1px solid var(--border)' }}>
              <button onClick={() => { clearChat(); setShowHistory(false) }} style={{ width: '100%', padding: '10px', borderRadius: 10, cursor: 'pointer', background: 'rgba(99,102,241,0.15)', border: '1px solid var(--accent)', color: 'var(--accent)', fontSize: 13, fontWeight: 600 }}>
                ＋ 新しい相談を始める
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
