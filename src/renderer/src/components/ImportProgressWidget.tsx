import type { Book } from '@shared/types'

interface Props {
  processing: Book[]
}

const STATUS_EMOJI: Record<Book['status'], string> = {
  importing: '📥',
  parsing: '📄',
  ocr: '🔍',
  indexing: '🧠',
  ready: '✅',
  error: '❌'
}

export default function ImportProgressWidget({ processing }: Props): JSX.Element | null {
  if (processing.length === 0) return null

  return (
    <div className="widget import-widget">
      <div className="widget-title">
        导入进度
        <span className="widget-badge">{processing.length}</span>
      </div>
      <div className="import-list">
        {processing.map((b) => (
          <div key={b.id} className="import-item">
            <div className="import-row">
              <span className="import-emoji">{STATUS_EMOJI[b.status]}</span>
              <span className="import-title" title={b.title}>
                {b.title}
              </span>
              <span className="import-pct">{b.progress ?? 0}%</span>
            </div>
            <div className="import-stage muted small">{b.stage || '处理中'}</div>
            <div className="import-bar">
              <div
                className="import-bar-fill"
                style={{ width: `${b.progress ?? 0}%` }}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
