import { useEffect, useMemo, useState } from 'react'
import type { OutlineNode } from '@shared/types'

interface Props {
  bookId: string
  hasKey: boolean
  /** 是否为 PDF 文件(影响页码显示) */
  isPdf: boolean
  /** 点击大纲项跳转到对应页 */
  onJump: (pageNo: number) => void
}

export default function Outline({ bookId, hasKey, isPdf, onJump }: Props): JSX.Element {
  const [nodes, setNodes] = useState<OutlineNode[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [generating, setGenerating] = useState(false)
  // 折叠状态:记录被折叠的章/节 id
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

  useEffect(() => {
    void window.api.getOutline(bookId).then(setNodes)
  }, [bookId])

  const counts = useMemo(() => {
    const kp = nodes.filter((n) => n.level === 3).length
    return { total: nodes.length, kp }
  }, [nodes])

  const generate = async (): Promise<void> => {
    setGenerating(true)
    try {
      const result = await window.api.generateOutline(bookId)
      setNodes(result)
    } catch (e) {
      console.error(e)
    } finally {
      setGenerating(false)
    }
  }

  // 计算每个章/节后面紧跟、缩进更深的子节点,用于折叠
  const toggleCollapse = (id: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  // 某节点是否因任一祖先(层级更小的前驱)被折叠而隐藏
  const isHidden = (idx: number): boolean => {
    let needLevel = nodes[idx].level
    for (let i = idx - 1; i >= 0 && needLevel > 1; i--) {
      if (nodes[i].level < needLevel) {
        if (collapsed.has(nodes[i].id)) return true
        needLevel = nodes[i].level // 继续向更高层级的祖先查找
      }
    }
    return false
  }

  const hasChildren = (idx: number): boolean => {
    const lvl = nodes[idx].level
    return idx + 1 < nodes.length && nodes[idx + 1].level > lvl
  }

  return (
    <div className="reader-outline">
      <div className="outline-head">
        <span>知识地图</span>
        <span className="muted small">{counts.kp ? `${counts.kp} 知识点` : counts.total || ''}</span>
      </div>

      {nodes.length === 0 ? (
        <div className="outline-empty">
          {hasKey ? (
            <>
              <p>还没有生成知识地图。</p>
              <button className="ghost-btn outline-gen-btn" disabled={generating} onClick={generate}>
                {generating ? '通读全书提炼中…' : 'AI 生成详细知识地图'}
              </button>
              <p className="muted small" style={{ marginTop: 8 }}>
                会通读全书,拆解到每章每节下的具体知识点,耗时随书厚度增加。
              </p>
            </>
          ) : (
            <p>配置 API 后可生成详细知识地图。</p>
          )}
        </div>
      ) : (
        <div className="outline-list">
          {nodes.map((n, idx) =>
            isHidden(idx) ? null : (
              <div key={n.id} className={`outline-row outline-level-${n.level}`}>
                <button
                  className={`outline-item ${activeId === n.id ? 'active' : ''}`}
                  onClick={() => {
                    setActiveId(n.id)
                    onJump(n.pageNo)
                  }}
                >
                  {(n.level === 1 || n.level === 2) && hasChildren(idx) && (
                    <span
                      className="o-caret"
                      onClick={(e) => {
                        e.stopPropagation()
                        toggleCollapse(n.id)
                      }}
                    >
                      {collapsed.has(n.id) ? '▸' : '▾'}
                    </span>
                  )}
                  <span className="o-title">
                    {n.level === 3 && <span className="o-dot">·</span>}
                    {n.title}
                  </span>
                  <span className="o-page">{isPdf ? `p${n.pageNo}` : `¶${n.pageNo}`}</span>
                </button>
                {n.summary && <div className="o-summary">{n.summary}</div>}
              </div>
            )
          )}
          <button className="ghost-btn outline-regen" disabled={generating} onClick={generate}>
            {generating ? '重新提炼中…' : '↻ 重新生成'}
          </button>
        </div>
      )}
    </div>
  )
}
