import { useEffect, useRef, useState, useCallback, memo } from 'react'
import type { ReactNode } from 'react'
import MarkdownRenderer from './MarkdownRenderer'
import 'katex/dist/katex.min.css'
import type { ChatTurn, ChatSession, BBox } from '@shared/types'

interface Props {
  bookId: string
  hasKey: boolean
  pageImageRequest?: { pageNo: number; pngDataUrl: string; nonce: number } | null
  onPageImageDocked?: (nonce: number) => void
  onCite: (pageNo: number, bbox: BBox) => void
}

type Mode = 'ask' | 'learn'

interface StreamingTurn {
  id: string
  mode: Mode
  question: string
  image?: ChatTurn['image']
  thinking: string
  answer: string
  citations: ChatTurn['citations']
  done: boolean
  error?: string
}

export default function ChatPanel({ bookId, hasKey, pageImageRequest, onPageImageDocked, onCite }: Props): JSX.Element {
  const [mode, setMode] = useState<Mode>('ask')
  const [turns, setTurns] = useState<ChatTurn[]>([])
  const [streamingTurn, setStreamingTurn] = useState<StreamingTurn | null>(null)
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [sessions, setSessions] = useState<ChatSession[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const streamUnsubRef = useRef<(() => void) | null>(null)
  const handledImageNonceRef = useRef<number | null>(null)
  // 流式 chunk 批处理:IPC 高频小 chunk 先攒到数组, RAF 批量更新,大幅减少 React 重渲染
  const pendingRef = useRef<{
    thinking: string[]
    answer: string[]
    citations: ChatTurn['citations'] | null
    done: boolean
    error: string | null
  }>({ thinking: [], answer: [], citations: null, done: false, error: null })
  const flushRafRef = useRef(0)

  // 加载会话列表:打开书时自动创建一个新会话,让用户每次都有空白的聊天界面
  const loadSessions = useCallback(async (): Promise<void> => {
    const list = await window.api.listChatSessions(bookId)
    setSessions(list)
    if (list.length === 0) {
      const s = await window.api.startChatSession(bookId)
      setSessions([s])
      setActiveSessionId(s.id)
      await window.api.setActiveSession(bookId, s.id)
      setTurns([])
    } else {
      // 默认打开最新的会话
      const latest = list[0]
      setActiveSessionId(latest.id)
      await window.api.setActiveSession(bookId, latest.id)
      const turns = await window.api.listChats(bookId)
      setTurns(turns)
    }
  }, [bookId])

  useEffect(() => {
    void loadSessions()
  }, [loadSessions])

  const startNewSession = useCallback(async (): Promise<void> => {
    if (loading) return
    const s = await window.api.startChatSession(bookId)
    setSessions((prev) => [s, ...prev])
    setActiveSessionId(s.id)
    await window.api.setActiveSession(bookId, s.id)
    setTurns([])
    setStreamingTurn(null)
    setErr(null)
  }, [bookId, loading])

  const switchSession = useCallback(async (sessionId: string): Promise<void> => {
    if (loading || sessionId === activeSessionId) return
    setActiveSessionId(sessionId)
    await window.api.setActiveSession(bookId, sessionId)
    const turns = await window.api.listChats(bookId)
    setTurns(turns)
    setStreamingTurn(null)
    setErr(null)
  }, [bookId, loading, activeSessionId])

  const deleteSession = useCallback(async (sessionId: string): Promise<void> => {
    if (loading) return
    await window.api.deleteChatSession(bookId, sessionId)
    setSessions((prev) => prev.filter((s) => s.id !== sessionId))
    if (activeSessionId === sessionId) {
      setActiveSessionId(null)
      setTurns([])
    }
  }, [bookId, loading, activeSessionId])

  useEffect(() => {
    if (!pageImageRequest || loading) return
    if (handledImageNonceRef.current === pageImageRequest.nonce) return
    handledImageNonceRef.current = pageImageRequest.nonce
    if (!hasKey) {
      setErr('请先在「设置」中配置 API,才能使用截图问答。')
      return
    }
    if (typeof window.api.askPageImage !== 'function') {
      setErr('截图问答接口尚未加载，请重启应用后再试。')
      return
    }
    setErr(null)
    setLoading(true)
    const question = `请分析当前 PDF 第 ${pageImageRequest.pageNo} 页截图`
    setStreamingTurn({
      id: `page-image-${pageImageRequest.nonce}`,
      mode: 'ask',
      question: `📷 第 ${pageImageRequest.pageNo} 页截图: ${question}`,
      image: { pageNo: pageImageRequest.pageNo, dataUrl: pageImageRequest.pngDataUrl },
      thinking: '',
      answer: '',
      citations: [],
      done: false
    })
    window.setTimeout(() => onPageImageDocked?.(pageImageRequest.nonce), 40)
    void (async (): Promise<void> => {
      try {
        const turn = await window.api.askPageImage(bookId, pageImageRequest.pageNo, pageImageRequest.pngDataUrl, question)
        setTurns((prev) => [...prev, turn])
        setStreamingTurn((prev) => (prev ? { ...prev, done: true, answer: turn.answer } : prev))
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        setStreamingTurn((prev) => (prev ? { ...prev, done: true, error: friendlyError(msg) } : prev))
      } finally {
        setLoading(false)
      }
    })()
  }, [bookId, hasKey, loading, onPageImageDocked, pageImageRequest])

  // 自动滚到底部:只在用户已经处于底部 80px 范围内时才滚动,避免打断阅读历史消息。
  // 流式过程中用 auto 而非 smooth,防止 smooth 动画和内容增长竞争导致上下抽搐。
  useEffect(() => {
    const el = listRef.current
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    if (nearBottom) {
      el.scrollTo({ top: el.scrollHeight, behavior: streamingTurn ? 'auto' : 'smooth' })
    }
  }, [turns, streamingTurn, loading])

  // 监听流式完成,清理状态
  useEffect(() => {
    if (streamingTurn?.done) {
      const timer = setTimeout(() => {
        setStreamingTurn(null)
        setLoading(false)
        if (streamUnsubRef.current) {
          streamUnsubRef.current()
          streamUnsubRef.current = null
        }
      }, 120)
      return () => clearTimeout(timer)
    }
  }, [streamingTurn?.done])

  // 组件卸载时清理订阅
  useEffect(() => {
    return () => {
      if (streamUnsubRef.current) {
        streamUnsubRef.current()
        streamUnsubRef.current = null
      }
    }
  }, [])

  const send = useCallback(async (): Promise<void> => {
    const q = input.trim()
    if (!q || loading) return
    if (!hasKey) {
      setErr('请先在「设置」中配置 API,才能使用问答功能。')
      return
    }
    setErr(null)
    setLoading(true)
    setInput('')

    // 清理旧的订阅
    if (streamUnsubRef.current) {
      streamUnsubRef.current()
      streamUnsubRef.current = null
    }

    const newStream: StreamingTurn = {
      id: '',
      mode,
      question: q,
      thinking: '',
      answer: '',
      citations: [],
      done: false
    }
    setStreamingTurn(newStream)

    try {
      const turnId = await window.api.askStream(bookId, q, mode)
      newStream.id = turnId

      const unsub = window.api.onChatStream((chunk) => {
        const buf = pendingRef.current
        if (chunk.type === 'thinking') buf.thinking.push(chunk.content)
        else if (chunk.type === 'answer') buf.answer.push(chunk.content)
        else if (chunk.type === 'citations') buf.citations = chunk.citations
        else if (chunk.type === 'done') {
          buf.done = true
          setTurns((t) => [...t, chunk.turn])
          void window.api.incrementChatCount()
          // 新会话的第一条消息完成后,用问题内容更新会话标题
          setSessions((prev) =>
            prev.map((s) =>
              s.id === activeSessionId && s.title === '新对话'
                ? { ...s, title: chunk.turn.question.slice(0, 24) || '新对话' }
                : s
            )
          )
        } else if (chunk.type === 'error') {
          buf.done = true
          buf.error = chunk.message
        }

        if (flushRafRef.current) return
        flushRafRef.current = requestAnimationFrame(() => {
          flushRafRef.current = 0
          const p = pendingRef.current
          pendingRef.current = { thinking: [], answer: [], citations: null, done: false, error: null }
          setStreamingTurn((prev) => {
            if (!prev) return prev
            const next = { ...prev }
            if (p.thinking.length) next.thinking = prev.thinking + p.thinking.join('')
            if (p.answer.length) next.answer = prev.answer + p.answer.join('')
            if (p.citations) next.citations = p.citations
            if (p.done) next.done = true
            if (p.error) { next.done = true; next.error = p.error }
            return next
          })
        })
      })
      streamUnsubRef.current = unsub
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setErr(friendlyError(msg))
      setStreamingTurn((prev) => (prev ? { ...prev, done: true, error: msg } : prev))
      setLoading(false)
    }
  }, [bookId, hasKey, input, loading, mode])

  const learnPrompts = [
    '请按知识点系统讲解本章的核心内容',
    '这一节最重要的概念有哪些?用中文解释',
    '帮我梳理这部分的逻辑脉络'
  ]

  return (
    <div className="chat-panel">
      <div className="session-bar">
        <button className="session-new" onClick={() => void startNewSession()} title="开始新对话">
          ＋ 新聊天
        </button>
        <div className="session-scroll">
          {sessions.map((s) => (
            <div
              key={s.id}
              className={`session-tab ${s.id === activeSessionId ? 'active' : ''}`}
              onClick={() => void switchSession(s.id)}
              title={s.title}
            >
              <span className="session-title">{s.title}</span>
              <button
                className="session-close"
                onClick={(e) => {
                  e.stopPropagation()
                  void deleteSession(s.id)
                }}
                title="删除此对话"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      </div>
      <div className="mode-switch">
        <button
          className={`mode-tab ${mode === 'ask' ? 'active' : ''}`}
          onClick={() => setMode('ask')}
        >
          提问模式
        </button>
        <button
          className={`mode-tab ${mode === 'learn' ? 'active' : ''}`}
          onClick={() => setMode('learn')}
        >
          学习模式
        </button>
      </div>
      <div className="mode-hint muted small">
        {mode === 'ask'
          ? '针对具体问题提问,AI 用中文作答并标注原文出处。'
          : '让 AI 像老师一样按知识点系统讲解,适合从头吃透一章。'}
      </div>

      <div className="chat-list" ref={listRef}>
        {turns.length === 0 && !streamingTurn && (
          <div className="chat-empty muted">
            {mode === 'learn' ? (
              <>
                <p>试试这些开场:</p>
                {learnPrompts.map((p) => (
                  <button key={p} className="chip" onClick={() => setInput(p)}>
                    {p}
                  </button>
                ))}
              </>
            ) : (
              <p>问点什么吧,例如:"第二章的核心假设是什么?"</p>
            )}
          </div>
        )}

        {turns.map((t) => (
          <TurnBlock key={t.id} turn={t} onCite={onCite} />
        ))}

        {streamingTurn && (
          <TurnBlock
            turn={{
              id: streamingTurn.id,
              bookId,
              mode: streamingTurn.mode,
              question: streamingTurn.question,
              image: streamingTurn.image,
              thinking: streamingTurn.thinking || undefined,
              answer: streamingTurn.answer,
              citations: streamingTurn.citations,
              createdAt: Date.now()
            }}
            onCite={onCite}
            streaming
            streamingError={streamingTurn.error}
          />
        )}

        {loading && !streamingTurn && (
          <div className="thinking muted">AI 正在阅读…</div>
        )}
      </div>

      {err && <div className="chat-error small">{err}</div>}

      <div className="chat-input">
        <textarea
          value={input}
          placeholder={mode === 'ask' ? '输入你的问题…' : '告诉 AI 你想学哪部分…'}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void send()
          }}
          rows={3}
        />
        <div className="chat-input-actions">
          <span className="muted small">⌘/Ctrl + Enter 发送</span>
          <button className="primary-btn" disabled={loading} onClick={send}>
            发送
          </button>
        </div>
      </div>
    </div>
  )
}

const TurnBlock = memo(function TurnBlock({
  turn,
  onCite,
  streaming,
  streamingError
}: {
  turn: ChatTurn
  onCite: (pageNo: number, bbox: BBox) => void
  streaming?: boolean
  streamingError?: string
}): JSX.Element {
  const hasThinking = !!turn.thinking && turn.thinking.trim().length > 0
  // 流式中默认展开 thinking;历史记录默认折叠
  const [thinkOpen, setThinkOpen] = useState(hasThinking && !!streaming)

  // 当同一个组件实例从流式变为完成时,自动折叠 thinking
  const wasStreamingRef = useRef(streaming)
  useEffect(() => {
    if (wasStreamingRef.current && !streaming && hasThinking) {
      setThinkOpen(false)
    }
    wasStreamingRef.current = streaming
  }, [streaming, hasThinking])

  return (
    <div className="turn">
      <div className="q">
        <span className="q-badge">{turn.mode === 'learn' ? '学' : '问'}</span>
        {turn.question}
      </div>
      {turn.image && (
        <div className="turn-image-card" data-page-image-dropzone>
          <img src={turn.image.dataUrl} alt={`第 ${turn.image.pageNo} 页截图`} />
          <span>第 {turn.image.pageNo} 页截图</span>
        </div>
      )}
      <div className="a">
        {hasThinking && (
          <div className={`think-block ${thinkOpen ? 'open' : ''}`}>
            <button className="think-toggle" onClick={() => setThinkOpen((v) => !v)}>
              <span className="think-caret">›</span>
              <span className="think-label">思考过程</span>
              {streaming && <span className="think-live">思考中…</span>}
            </button>
            {thinkOpen && (
              <div className="think-body">
                {turn.thinking}
              </div>
            )}
          </div>
        )}
        <div className="a-text">
          {streaming && !turn.answer ? (
            <span className="typing-cursor" />
          ) : streaming ? (
            // 流式过程中直接渲染纯文本,避免每帧都重新解析 Markdown AST
            <span>{turn.answer}</span>
          ) : (
            renderAnswer(turn.answer)
          )}
        </div>
        {streamingError && <div className="stream-error small">{streamingError}</div>}
        {turn.citations.length > 0 && (
          <div className="citations">
            <span className="cite-label muted small">原文出处:</span>
            {turn.citations.map((c, i) => (
              <button
                key={c.chunkId}
                className="cite-chip"
                title={c.snippet}
                onClick={() => onCite(c.pageNo, c.bbox)}
              >
                [{i + 1}] 第 {c.pageNo} 页
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
})

function friendlyError(msg: string): string {
  if (msg.includes('NO_API_KEY')) return '尚未配置 API Key,请到设置中填写。'
  const m = msg.match(/(?:OPENAI_FAILED|ANTHROPIC_FAILED|CHAT_FAILED|VISION_FAILED|OUTLINE_FAILED):(\d+):([\s\S]*)/)
  if (m) {
    const status = m[1]
    const detail = m[2].trim()
    return `调用模型失败(HTTP ${status})。${detail}`
  }
  return `出错了:${msg}`
}

function renderAnswer(text: string): ReactNode {
  return (
    <MarkdownRenderer
      components={{
        p: ({ children }: { children?: ReactNode }) => <p>{highlightTerms(children)}</p>,
        li: ({ children }: { children?: ReactNode }) => <li>{highlightTerms(children)}</li>,
        a: ({ href, children }: { href?: string; children?: ReactNode }) => (
          <a href={href} target="_blank" rel="noreferrer">
            {children}
          </a>
        )
      }}
    >
      {text}
    </MarkdownRenderer>
  )
}

const TERM_RE = /([一-龥]{1,12})\(([A-Za-z][A-Za-z0-9\s\-/]{1,40})\)/g

function highlightTerms(children: ReactNode): ReactNode {
  if (typeof children === 'string') return highlightString(children)
  if (Array.isArray(children)) return children.map((c, i) => <span key={i}>{highlightTerms(c)}</span>)
  return children
}

function highlightString(text: string): ReactNode {
  const out: ReactNode[] = []
  let last = 0
  let key = 0
  let m: RegExpExecArray | null
  TERM_RE.lastIndex = 0
  while ((m = TERM_RE.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index))
    out.push(
      <em className="term" key={key++}>
        {m[1]}({m[2]})
      </em>
    )
    last = m.index + m[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return out.length ? out : text
}
