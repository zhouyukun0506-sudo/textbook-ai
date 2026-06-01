import { useMemo } from 'react'
import type { WeeklyStats } from '@shared/types'

interface Props {
  stats: WeeklyStats[]
}

function getWeekStart(ts: number): number {
  const d = new Date(ts)
  const day = d.getDay() || 7
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() - day + 1)
  return d.getTime()
}

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (h > 0) return `${h}.${Math.round(m / 6)} 小时`
  return `${m} 分钟`
}

export default function WeeklyReport({ stats }: Props): JSX.Element | null {
  const thisWeekStart = useMemo(() => getWeekStart(Date.now()), [])
  const lastWeekStart = thisWeekStart - 7 * 24 * 60 * 60 * 1000

  const thisWeek = stats.find((s) => s.weekStart === thisWeekStart)
  const lastWeek = stats.find((s) => s.weekStart === lastWeekStart)

  const thisSeconds = thisWeek?.totalSeconds ?? 0
  const lastSeconds = lastWeek?.totalSeconds ?? 0
  const chatCount = thisWeek?.chatCount ?? 0
  const knowledgeCount = thisWeek?.knowledgeCount ?? 0

  const targetSeconds = 20 * 3600
  const progress = Math.min(100, Math.round((thisSeconds / targetSeconds) * 100))

  const diffSeconds = thisSeconds - lastSeconds
  const diffText = diffSeconds >= 0
    ? `比上周多 ${formatDuration(Math.abs(diffSeconds))}`
    : `比上周少 ${formatDuration(Math.abs(diffSeconds))}`

  // SVG viewBox 固定 72×72，通过 CSS 宽度 100% 自动缩放
  const size = 72
  const stroke = 7
  const radius = (size - stroke) / 2
  const circumference = 2 * Math.PI * radius
  const offset = circumference - (progress / 100) * circumference

  return (
    <div className="weekly-report" style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div className="weekly-report-title" style={{ flexShrink: 0 }}>本周研读周报</div>
      <div className="weekly-report-body" style={{ flex: 1, minHeight: 0 }}>
        <div className="weekly-report-ring" style={{ width: '40%', maxWidth: 80, minWidth: 48 }}>
          <svg width="100%" height="100%" viewBox={`0 0 ${size} ${size}`} style={{ display: 'block' }}>
            <circle
              cx={size / 2}
              cy={size / 2}
              r={radius}
              fill="none"
              stroke="#e8e3d8"
              strokeWidth={stroke}
            />
            <circle
              cx={size / 2}
              cy={size / 2}
              r={radius}
              fill="none"
              stroke="#4a7c6f"
              strokeWidth={stroke}
              strokeLinecap="round"
              strokeDasharray={circumference}
              strokeDashoffset={offset}
              transform={`rotate(-90 ${size / 2} ${size / 2})`}
              style={{ transition: 'stroke-dashoffset 0.6s ease' }}
            />
          </svg>
          <span className="weekly-report-percent" style={{ fontSize: 'clamp(11px, 2.5vw, 15px)' }}>{progress}%</span>
        </div>
        <div className="weekly-report-info">
          <div className="weekly-report-hours">
            <span className="weekly-report-label" style={{ fontSize: 'clamp(10px, 1.8vw, 13px)' }}>累计阅读时长</span>
            <span className="weekly-report-value" style={{ fontSize: 'clamp(16px, 3.5vw, 22px)' }}>{formatDuration(thisSeconds)}</span>
          </div>
          {lastSeconds > 0 || thisSeconds > 0 ? (
            <span className={`weekly-report-diff ${diffSeconds >= 0 ? 'up' : 'down'}`} style={{ fontSize: 'clamp(10px, 1.5vw, 12px)' }}>
              {diffText}
            </span>
          ) : (
            <span className="weekly-report-diff neutral" style={{ fontSize: 'clamp(10px, 1.5vw, 12px)' }}>开始阅读吧</span>
          )}
        </div>
      </div>
      <div className="weekly-report-footer" style={{ flexShrink: 0 }}>
        <div className="weekly-report-stat">
          <span className="weekly-report-stat-value" style={{ fontSize: 'clamp(14px, 2.5vw, 18px)' }}>{chatCount}</span>
          <span className="weekly-report-stat-label" style={{ fontSize: 'clamp(10px, 1.5vw, 12px)' }}>翻译批注数</span>
        </div>
        <div className="weekly-report-stat">
          <span className="weekly-report-stat-value" style={{ fontSize: 'clamp(14px, 2.5vw, 18px)' }}>{knowledgeCount}</span>
          <span className="weekly-report-stat-label" style={{ fontSize: 'clamp(10px, 1.5vw, 12px)' }}>AI 生成摘要</span>
        </div>
      </div>
    </div>
  )
}
