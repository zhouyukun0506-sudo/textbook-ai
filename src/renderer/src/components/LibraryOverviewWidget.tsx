import { useMemo } from 'react'
import type { Book } from '@shared/types'

interface Props {
  books: Book[]
}

// 文艺纸感配色循环,给学科分布条上色
const PALETTE = ['#a8763e', '#4a7c6f', '#6b5b95', '#b5654a', '#7a8450', '#9a6a8c']

export default function LibraryOverviewWidget({ books }: Props): JSX.Element {
  const { total, ready, processing, subjects } = useMemo(() => {
    const ready = books.filter((b) => b.status === 'ready')
    const processing = books.filter((b) => b.status !== 'ready' && b.status !== 'error')
    const map = new Map<string, number>()
    for (const b of ready) {
      const s = b.subject?.trim() || '未分类'
      map.set(s, (map.get(s) ?? 0) + 1)
    }
    const subjects = [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
    return { total: books.length, ready: ready.length, processing: processing.length, subjects }
  }, [books])

  const maxCount = Math.max(1, ...subjects.map(([, c]) => c))

  return (
    <div className="libov-widget">
      <div className="widget-title">书库总览</div>
      <div className="libov-stats">
        <div className="libov-stat">
          <span className="libov-num">{total}</span>
          <span className="libov-label">总藏书</span>
        </div>
        <div className="libov-stat">
          <span className="libov-num">{ready}</span>
          <span className="libov-label">已就绪</span>
        </div>
        <div className="libov-stat">
          <span className="libov-num">{processing}</span>
          <span className="libov-label">处理中</span>
        </div>
      </div>
      <div className="libov-dist">
        {subjects.length === 0 ? (
          <span className="libov-empty">还没有就绪的书</span>
        ) : (
          subjects.map(([name, count], i) => (
            <div key={name} className="libov-bar-row" title={`${name} · ${count} 本`}>
              <span className="libov-bar-name">{name}</span>
              <div className="libov-bar-track">
                <div
                  className="libov-bar-fill"
                  style={{ width: `${(count / maxCount) * 100}%`, background: PALETTE[i % PALETTE.length] }}
                />
              </div>
              <span className="libov-bar-count">{count}</span>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
