import { useMemo } from 'react'
import type { WeeklyStats } from '@shared/types'

interface Props {
  stats: WeeklyStats[]
}

const LEVELS = [
  { min: 0, color: '#ebedf0' },
  { min: 1, color: '#c6e48b' },
  { min: 1800, color: '#7bc96f' },
  { min: 3600, color: '#239a3b' },
  { min: 7200, color: '#196127' }
]

function getColor(seconds: number): string {
  for (let i = LEVELS.length - 1; i >= 0; i--) {
    if (seconds >= LEVELS[i].min) return LEVELS[i].color
  }
  return LEVELS[0].color
}

function formatDateLabel(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00')
  return `${d.getMonth() + 1}月${d.getDate()}日`
}

export default function HeatmapWidget({ stats }: Props): JSX.Element {
  const days = useMemo(() => {
    const map = new Map<string, number>()
    for (const week of stats) {
      if (week.dailySeconds) {
        for (const [date, sec] of Object.entries(week.dailySeconds)) {
          map.set(date, (map.get(date) || 0) + sec)
        }
      }
    }
    // 生成最近 56 天(8 周)的日期列表
    const result: { date: string; seconds: number }[] = []
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    for (let i = 55; i >= 0; i--) {
      const d = new Date(today)
      d.setDate(d.getDate() - i)
      const dateStr = d.toISOString().slice(0, 10)
      result.push({ date: dateStr, seconds: map.get(dateStr) || 0 })
    }
    return result
  }, [stats])

  const maxSec = useMemo(() => Math.max(1, ...days.map((d) => d.seconds)), [days])

  // 7 行(周一到周日) × 8 列(8 周)
  const rows: { date: string; seconds: number }[][] = []
  for (let r = 0; r < 7; r++) {
    const row: { date: string; seconds: number }[] = []
    for (let c = 0; c < 8; c++) {
      const idx = c * 7 + r
      row.push(days[idx] || { date: '', seconds: 0 })
    }
    rows.push(row)
  }

  return (
    <div className="widget heatmap-widget" style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div className="widget-title" style={{ flexShrink: 0 }}>阅读热力图</div>
      <div className="heatmap-grid" style={{ flex: 1, minHeight: 0, justifyContent: 'center' }}>
        {rows.map((row, ri) => (
          <div key={ri} className="heatmap-row" style={{ flex: 1 }}>
            {row.map((d, ci) => (
              <div
                key={ci}
                className="heatmap-cell"
                style={{ background: d.date ? getColor(d.seconds) : 'transparent', flex: 1, borderRadius: 'clamp(1px, 0.3vw, 3px)' }}
                title={d.date ? `${formatDateLabel(d.date)} · ${Math.round(d.seconds / 60)} 分钟` : ''}
              />
            ))}
          </div>
        ))}
      </div>
      <div className="heatmap-legend" style={{ flexShrink: 0 }}>
        <span className="heatmap-legend-label" style={{ fontSize: 'clamp(9px, 1.5vw, 11px)' }}>少</span>
        {LEVELS.slice(1).map((l) => (
          <span key={l.min} className="heatmap-legend-dot" style={{ background: l.color, width: 'clamp(8px, 1.5vw, 12px)', height: 'clamp(8px, 1.5vw, 12px)' }} />
        ))}
        <span className="heatmap-legend-label" style={{ fontSize: 'clamp(9px, 1.5vw, 11px)' }}>多</span>
      </div>
    </div>
  )
}
