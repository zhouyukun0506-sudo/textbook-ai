import { useState, useEffect, useRef, useCallback } from 'react'
import type { Book, BBox } from '@shared/types'
import type { PomodoroControls } from '../lib/usePomodoro'
import PdfViewer from './PdfViewer'
import MarkdownViewer from './MarkdownViewer'
import KnowledgeViewer from './KnowledgeViewer'
import ChatPanel from './ChatPanel'
import Outline from './Outline'

interface Props {
  book: Book
  hasKey: boolean
  onBack: () => void
  pomodoro: PomodoroControls
}

const DEFAULT_LEFT_W = 232
const DEFAULT_RIGHT_W = 420
const MIN_LEFT_W = 180
const MAX_LEFT_W = 400
const MIN_RIGHT_W = 300
const MAX_RIGHT_W = 600
const COLLAPSE_THRESHOLD = 60

// 番茄钟剩余时间 mm:ss
function fmtPomo(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

export default function Reader({ book, hasKey, onBack, pomodoro }: Props): JSX.Element {
  const [highlight, setHighlight] = useState<{ pageNo: number; bbox: BBox } | null>(null)
  const [gotoPage, setGotoPage] = useState<{ pageNo: number; nonce: number } | null>(null)
  const [pageImageRequest, setPageImageRequest] = useState<{
    pageNo: number
    pngDataUrl: string
    nonce: number
    sourceRect: DOMRect
  } | null>(null)
  const [view, setView] = useState<'source' | 'knowledge'>('source')
  const [liveStage, setLiveStage] = useState(book.stage)

  // 侧边栏宽度与折叠状态
  const [leftW, setLeftW] = useState(DEFAULT_LEFT_W)
  const [rightW, setRightW] = useState(DEFAULT_RIGHT_W)
  const [leftCollapsed, setLeftCollapsed] = useState(false)
  const [rightCollapsed, setRightCollapsed] = useState(false)

  // 拖拽状态(幽灵指示条模式:拖拽时不实时重渲染,松开时才应用)
  const dragRef = useRef<'left' | 'right' | null>(null)
  const startXRef = useRef(0)
  const startWRef = useRef(0)
  const ghostRef = useRef<HTMLDivElement | null>(null)

  const isMarkdown = book.fileType === 'markdown'

  useEffect(() => {
    const unsub = window.api.onBookProgress((b) => {
      if (b.id === book.id) setLiveStage(b.stage)
    })
    return unsub
  }, [book.id])

  const handleJump = (pageNo: number, bbox?: BBox): void => {
    setGotoPage({ pageNo, nonce: Date.now() })
    if (bbox) setHighlight({ pageNo, bbox })
    setView('source')
  }

  // 创建/移除拖拽遮罩(覆盖目标面板区域,不触发React重渲染)
  const showGhost = (side: 'left' | 'right', x: number) => {
    if (!ghostRef.current) {
      const el = document.createElement('div')
      el.className = 'reader-resizer-ghost'
      el.innerHTML = '<div class="reader-ghost-line"></div><span class="reader-ghost-text">释放以调整宽度</span>'
      document.body.appendChild(el)
      ghostRef.current = el
    }
    const el = ghostRef.current
    const bodyH = document.documentElement.clientHeight
    if (side === 'left') {
      el.style.left = '0px'
      el.style.top = '46px'
      el.style.width = `${x}px`
      el.style.height = `${bodyH - 46}px`
    } else {
      el.style.left = `${x}px`
      el.style.top = '46px'
      el.style.width = `${document.documentElement.clientWidth - x}px`
      el.style.height = `${bodyH - 46}px`
    }
    el.style.display = 'flex'
  }
  const hideGhost = () => {
    if (ghostRef.current) {
      ghostRef.current.style.display = 'none'
    }
  }

  // 拖拽逻辑(遮罩模式:拖拽时不重渲染,松开才应用)
  const onDragStart = useCallback((side: 'left' | 'right', e: React.MouseEvent) => {
    e.preventDefault()
    dragRef.current = side
    startXRef.current = e.clientX
    startWRef.current = side === 'left' ? leftW : rightW
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    showGhost(side, e.clientX)
  }, [leftW, rightW])

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const side = dragRef.current
      if (!side) return
      showGhost(side, e.clientX)
    }
    const onUp = (e: MouseEvent) => {
      const side = dragRef.current
      dragRef.current = null
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      hideGhost()
      if (!side) return

      const delta = side === 'left' ? e.clientX - startXRef.current : startXRef.current - e.clientX
      let newW = startWRef.current + delta
      if (side === 'left') {
        newW = Math.max(0, Math.min(MAX_LEFT_W, newW))
        if (newW < COLLAPSE_THRESHOLD) {
          setLeftCollapsed(true)
          setLeftW(DEFAULT_LEFT_W)
        } else {
          setLeftCollapsed(false)
          setLeftW(Math.max(MIN_LEFT_W, newW))
        }
      } else {
        newW = Math.max(0, Math.min(MAX_RIGHT_W, newW))
        if (newW < COLLAPSE_THRESHOLD) {
          setRightCollapsed(true)
          setRightW(DEFAULT_RIGHT_W)
        } else {
          setRightCollapsed(false)
          setRightW(Math.max(MIN_RIGHT_W, newW))
        }
      }
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      if (ghostRef.current) {
        ghostRef.current.remove()
        ghostRef.current = null
      }
    }
  }, [])

  const toggleLeft = () => {
    if (leftCollapsed) {
      setLeftCollapsed(false)
      setLeftW(DEFAULT_LEFT_W)
    } else {
      setLeftCollapsed(true)
    }
  }
  const toggleRight = () => {
    if (rightCollapsed) {
      setRightCollapsed(false)
      setRightW(DEFAULT_RIGHT_W)
    } else {
      setRightCollapsed(true)
    }
  }

  return (
    <div className="reader">
      <div className="reader-bar">
        <button className="ghost-btn" onClick={onBack}>
          ‹ 书房
        </button>
        <button
          className={`reader-toggle ${leftCollapsed ? 'collapsed' : ''}`}
          onClick={toggleLeft}
          title={leftCollapsed ? '展开大纲' : '收起大纲'}
        >
          {leftCollapsed ? '›' : '‹'}
        </button>
        <span className="reader-title" title={book.title}>
          {book.title}
        </span>
        {liveStage && <span className="reader-stage">{liveStage}</span>}
        <div className="reader-view-toggle">
          <button className={view === 'source' ? 'active' : ''} onClick={() => setView('source')}>
            原文
          </button>
          <button className={view === 'knowledge' ? 'active' : ''} onClick={() => setView('knowledge')}>
            知识拆解
          </button>
        </div>
        {!isMarkdown && book.hasScanned && <span className="scan-badge">含扫描页 · 已 OCR</span>}
        {isMarkdown && <span className="scan-badge">Markdown</span>}
        <div
          className={`reader-pomo ${pomodoro.running ? 'running' : ''} ${pomodoro.phase}`}
          title={pomodoro.phase === 'focus' ? '专注计时' : '休息计时'}
        >
          <span className="reader-pomo-dot" aria-hidden="true" />
          <span className="reader-pomo-label">{pomodoro.phase === 'focus' ? '专注' : '休息'}</span>
          <span className="reader-pomo-time">{fmtPomo(pomodoro.secondsLeft)}</span>
          <button
            className="reader-pomo-btn"
            onClick={pomodoro.toggle}
            title={pomodoro.running ? '暂停' : '开始'}
          >
            {pomodoro.running ? '⏸' : '▶'}
          </button>
        </div>
        <button
          className={`reader-toggle ${rightCollapsed ? 'collapsed' : ''}`}
          onClick={toggleRight}
          title={rightCollapsed ? '展开对话' : '收起对话'}
        >
          {rightCollapsed ? '‹' : '›'}
        </button>
      </div>
      <div className="reader-body">
        {!leftCollapsed && (
          <>
            <div className="reader-outline" style={{ width: leftW }}>
              <Outline
                bookId={book.id}
                hasKey={hasKey}
                isPdf={!isMarkdown}
                onJump={(pageNo) => setGotoPage({ pageNo, nonce: Date.now() })}
              />
            </div>
            <div className="reader-resizer" onMouseDown={(e) => onDragStart('left', e)} />
          </>
        )}
        {leftCollapsed && (
          <div className="reader-collapsed-hint" onClick={toggleLeft} title="展开大纲">
            知识地图
          </div>
        )}

        <div className="reader-left">
          {view === 'knowledge' ? (
            <KnowledgeViewer bookId={book.id} isPdf={!isMarkdown} onJump={handleJump} />
          ) : isMarkdown ? (
            <MarkdownViewer bookId={book.id} gotoPage={gotoPage} />
          ) : (
            <PdfViewer
              bookId={book.id}
              highlight={highlight}
              gotoPage={gotoPage}
              hasKey={hasKey}
              onAskPageImage={(pageNo, pngDataUrl, sourceRect) =>
                setPageImageRequest({ pageNo, pngDataUrl, sourceRect, nonce: Date.now() })
              }
            />
          )}
        </div>

        {!rightCollapsed && (
          <>
            <div className="reader-resizer" onMouseDown={(e) => onDragStart('right', e)} />
            <div className="reader-right" style={{ width: rightW }}>
              <ChatPanel
                bookId={book.id}
                hasKey={hasKey}
                pageImageRequest={pageImageRequest}
                onPageImageDocked={(nonce) => {
                  if (pageImageRequest?.nonce !== nonce) return
                  animatePageImageToChat(pageImageRequest.pngDataUrl, pageImageRequest.sourceRect)
                }}
                onCite={(pageNo, bbox) => setHighlight({ pageNo, bbox })}
              />
            </div>
          </>
        )}
        {rightCollapsed && (
          <div className="reader-collapsed-hint" onClick={toggleRight} title="展开对话">
            AI 对话
          </div>
        )}
      </div>
    </div>
  )
}

function animatePageImageToChat(pngDataUrl: string, sourceRect: DOMRect): void {
  const target =
    document.querySelector<HTMLElement>('[data-page-image-dropzone]:last-of-type') ??
    document.querySelector<HTMLElement>('.chat-input')
  if (!target) return
  const targetRect = target.getBoundingClientRect()

  const soulSize = Math.min(sourceRect.width, sourceRect.height)
  const soul = document.createElement('div')
  soul.className = 'soul-flight'
  soul.style.left = `${sourceRect.left + sourceRect.width / 2}px`
  soul.style.top = `${sourceRect.top + sourceRect.height / 2}px`
  soul.style.width = `${soulSize}px`
  soul.style.height = `${soulSize}px`
  soul.innerHTML = `<div class="soul-orb"><img src="${pngDataUrl}" alt="" /></div>`
  document.body.appendChild(soul)

  const endX = targetRect.left + targetRect.width / 2
  const endY = targetRect.top + targetRect.height / 2

  // Phase 2: 灵魂化（0.35s，弹簧感）
  requestAnimationFrame(() => soul.classList.add('morphing'))

  // Phase 3: 飞行（0.65s，发射感）——与灵魂化重叠 200ms，衔接更连贯
  window.setTimeout(() => {
    requestAnimationFrame(() => {
      soul.style.left = `${endX}px`
      soul.style.top = `${endY}px`
      soul.classList.add('flying')
    })
  }, 200)

  // Phase 4: 爆开消散 + 滚底（弹性放大）
  window.setTimeout(() => {
    soul.classList.add('vanish')
    const chatList = document.querySelector('.chat-list') as HTMLElement | null
    if (chatList) chatList.scrollTo({ top: chatList.scrollHeight, behavior: 'smooth' })
  }, 850)

  window.setTimeout(() => soul.remove(), 1100)
}
