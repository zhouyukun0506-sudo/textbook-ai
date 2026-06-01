import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import MarkdownRenderer from './MarkdownRenderer'
import 'katex/dist/katex.min.css'

interface Props {
  bookId: string
  gotoPage?: { pageNo: number; nonce: number } | null
}

const MIN_FONT = 12
const MAX_FONT = 24

export default function MarkdownViewer({ bookId, gotoPage }: Props): JSX.Element {
  const [content, setContent] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [fontSize, setFontSize] = useState(15)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    window.api
      .readMarkdownData(bookId)
      .then((text) => {
        if (cancelled) return
        if (text === null) {
          setError('未找到 Markdown 文件')
        } else {
          setContent(text)
        }
        setLoading(false)
      })
      .catch((e) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e))
          setLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [bookId])

  // 大纲跳转:pageNo 对应 Markdown 行号,滚动到对应标题锚点
  useEffect(() => {
    if (!gotoPage) return
    const targetLine = gotoPage.pageNo
    const el = scrollRef.current?.querySelector(`[data-md-line="${targetLine}"]`)
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }, [gotoPage])

  if (loading) return <div className="pdf-loading">正在加载 Markdown…</div>
  if (error) return <div className="pdf-loading error">{error}</div>

  return (
    <div className="md-viewer">
      <div className="md-toolbar">
        <div className="md-zoom">
          <button className="ghost-btn" onClick={() => setFontSize((s) => Math.max(MIN_FONT, s - 1))} title="缩小字体">
            −
          </button>
          <span className="zoom-label">{fontSize}px</span>
          <button className="ghost-btn" onClick={() => setFontSize((s) => Math.min(MAX_FONT, s + 1))} title="放大字体">
            ＋
          </button>
        </div>
      </div>
      <div className="md-scroll" ref={scrollRef}>
        <div className="md-content" style={{ fontSize: `${fontSize}px` }}>
          <MarkdownContent text={content} />
        </div>
      </div>
    </div>
  )
}

/** 渲染 Markdown,为标题注入源码行号用于大纲跳转 */
function MarkdownContent({ text }: { text: string }): JSX.Element {
  const makeHeading = (level: number) => {
    const Tag = `h${level}` as keyof JSX.IntrinsicElements
    return function HeadingComponent({
      children,
      node
    }: {
      children?: ReactNode
      node?: { position?: { start?: { line?: number } } }
    }): JSX.Element {
      const lineNo = node?.position?.start?.line
      return (
        <Tag data-md-line={lineNo} id={lineNo ? `md-line-${lineNo}` : undefined}>
          {children}
        </Tag>
      )
    }
  }

  return (
    <MarkdownRenderer
      inlineMermaid={true}
      components={{
        h1: makeHeading(1),
        h2: makeHeading(2),
        h3: makeHeading(3),
        h4: makeHeading(4),
        h5: makeHeading(5),
        h6: makeHeading(6),
        a: ({ href, children }: { href?: string; children?: React.ReactNode }) => (
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
