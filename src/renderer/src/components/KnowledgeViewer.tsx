import { useEffect, useMemo, useState, useRef } from 'react'
import type { BBox, Chunk, KnowledgeNode } from '@shared/types'
import MarkdownRenderer from './MarkdownRenderer'
import 'katex/dist/katex.min.css'

interface Props {
  bookId: string
  /** 是否为 PDF 文件(影响页码显示) */
  isPdf: boolean
  onJump: (pageNo: number, bbox?: BBox) => void
}

export default function KnowledgeViewer({ bookId, isPdf, onJump }: Props): JSX.Element {
  const [nodes, setNodes] = useState<KnowledgeNode[]>([])
  const [loading, setLoading] = useState(false)
  const [genError, setGenError] = useState<string | null>(null)
  const [liveStage, setLiveStage] = useState<string | undefined>(undefined)
  const [chunks, setChunks] = useState<Chunk[]>([])
  const [search, setSearch] = useState('')
  const listRef = useRef<HTMLDivElement>(null)

  const load = async (): Promise<void> => {
    setLoading(true)
    setGenError(null)
    try {
      const data = await window.api.getKnowledgeNodes(bookId)
      setNodes(data)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
    void window.api.getBookChunks(bookId).then(setChunks)
  }, [bookId])

  useEffect(() => {
    const unsub = window.api.onBookProgress((book) => {
      if (book.id !== bookId) return
      setLiveStage(book.stage)
      if (!book.stage) {
        void window.api.getKnowledgeNodes(bookId).then(setNodes)
      }
    })
    return unsub
  }, [bookId])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return nodes
    return nodes.filter(
      (n) =>
        n.title.toLowerCase().includes(q) ||
        n.content.toLowerCase().includes(q) ||
        (n.category ?? '').toLowerCase().includes(q)
    )
  }, [nodes, search])

  const byCategory = useMemo(() => {
    const map = new Map<string, KnowledgeNode[]>()
    for (const n of filtered) {
      const cat = n.category || '未分类'
      const arr = map.get(cat) ?? []
      arr.push(n)
      map.set(cat, arr)
    }
    return map
  }, [filtered])

  const regenerate = async (): Promise<void> => {
    setLoading(true)
    setGenError(null)
    try {
      const data = await window.api.generateKnowledge(bookId)
      setNodes(data)
      void window.api.incrementKnowledgeCount()
    } catch (e) {
      setGenError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  const clearAll = async (): Promise<void> => {
    if (!confirm('确定清空所有知识点?清空后需重新生成。')) return
    await window.api.clearKnowledge(bookId)
    setNodes([])
  }

  if (nodes.length === 0 && !loading) {
    return (
      <div className="knowledge-viewer">
        <div className="knowledge-empty">
          <div className="empty-icon">✦</div>
          <p>还没有生成知识点拆解。</p>
          {genError && <p className="error small">{genError}</p>}
          <button className="ghost-btn" disabled={loading} onClick={regenerate}>
            {loading ? '拆解中…' : 'AI 深度拆解知识点'}
          </button>
          {liveStage && <p className="muted small knowledge-stage">{liveStage}</p>}
          <p className="muted small" style={{ marginTop: 8 }}>
            会通读全书，逐 chunk 提取详细知识点，耗时随书厚度增加。
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="knowledge-viewer">
      <div className="knowledge-toolbar">
        <input
          className="knowledge-search"
          placeholder="搜索知识点…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <button className="ghost-btn small" disabled={loading} onClick={regenerate}>
          {loading ? '拆解中…' : '↻ 重新生成'}
        </button>
        {nodes.length > 0 && (
          <button className="ghost-btn small danger" onClick={clearAll}>
            🗑 清空
          </button>
        )}
      </div>
      {liveStage && <div className="knowledge-stage muted small">{liveStage}</div>}

      <div className="knowledge-list" ref={listRef}>
        {loading && nodes.length === 0 && (
          <div className="knowledge-loading">
            <div className="spinner" />
            <p className="muted small">AI 正在深度拆解知识点，请稍候…</p>
          </div>
        )}

        {filtered.length === 0 && !loading && (
          <div className="knowledge-empty">
            <p>没有匹配的知识点。</p>
          </div>
        )}

        {Array.from(byCategory.entries()).map(([category, items]) => (
          <div key={category} className="knowledge-group">
            <div className="knowledge-group-title">{category}</div>
            {items.map((n) => (
              <KnowledgeCard key={n.id} node={n} chunks={chunks} isPdf={isPdf} onJump={onJump} />
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}

function KnowledgeCard({
  node,
  chunks,
  isPdf,
  onJump
}: {
  node: KnowledgeNode
  chunks: Chunk[]
  isPdf: boolean
  onJump: (pageNo: number, bbox?: BBox) => void
}): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null)

  const diffClass =
    node.difficulty === 'basic'
      ? 'diff-basic'
      : node.difficulty === 'advanced'
        ? 'diff-advanced'
        : 'diff-intermediate'

  const handleContextMenu = (e: React.MouseEvent): void => {
    e.preventDefault()
    setMenuPos({ x: e.clientX, y: e.clientY })
  }

  const closeMenu = (): void => setMenuPos(null)

  const doJump = (): void => {
    const source = node.chunkId ? chunks.find((c) => c.id === node.chunkId) : undefined
    onJump(source?.pageNo ?? node.pageNo, source?.bbox)
    closeMenu()
  }

  return (
    <>
      <div
        className={`knowledge-card ${expanded ? 'expanded' : ''}`}
        onContextMenu={handleContextMenu}
      >
        <div className="knowledge-card-head" onClick={() => setExpanded((v) => !v)}>
          <span className="knowledge-card-title">{node.title}</span>
          <div className="knowledge-card-meta">
            {node.difficulty && (
              <span className={`knowledge-diff ${diffClass}`}>
                {node.difficulty === 'basic'
                  ? '基础'
                  : node.difficulty === 'advanced'
                    ? '进阶'
                    : '中等'}
              </span>
            )}
            <button
              className="knowledge-source"
              onClick={(e) => {
                e.stopPropagation()
                doJump()
              }}
              title="跳回原文"
            >
              p{node.pageNo}
            </button>
          </div>
        </div>
        {expanded && (
          <div className="knowledge-card-body">
            <MarkdownRenderer>{node.content}</MarkdownRenderer>
          </div>
        )}
      </div>

      {menuPos && (
        <>
          <div className="ctx-menu-backdrop" onClick={closeMenu} />
          <div
            className="ctx-menu"
            style={{ left: menuPos.x, top: menuPos.y }}
          >
            <button className="ctx-item" onClick={doJump}>
              📖 跳转到原文 {isPdf ? `(p${node.pageNo})` : `(¶${node.pageNo})`}
            </button>
            <button className="ctx-item" onClick={closeMenu}>
              取消
            </button>
          </div>
        </>
      )}
    </>
  )
}
