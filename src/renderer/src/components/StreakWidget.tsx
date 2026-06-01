import { useMemo } from 'react'
import type { WeeklyStats } from '@shared/types'

interface Props {
  stats: WeeklyStats[]
}

export default function StreakWidget({ stats }: Props): JSX.Element {
  const streak = useMemo(() => {
    const daySet = new Set<string>()
    for (const week of stats) {
      if (week.dailySeconds) {
        for (const [date, sec] of Object.entries(week.dailySeconds)) {
          if (sec > 60) daySet.add(date) // 超过 1 分钟算阅读
        }
      }
    }
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const todayStr = today.toISOString().slice(0, 10)

    // 检查今天是否阅读了,没有则从昨天开始算
    let cursor = new Date(today)
    if (!daySet.has(todayStr)) {
      cursor.setDate(cursor.getDate() - 1)
    }

    let count = 0
    while (true) {
      const str = cursor.toISOString().slice(0, 10)
      if (daySet.has(str)) {
        count++
        cursor.setDate(cursor.getDate() - 1)
      } else {
        break
      }
    }
    return count
  }, [stats])

  const maxStreak = useMemo(() => {
    const daySet = new Set<string>()
    for (const week of stats) {
      if (week.dailySeconds) {
        for (const [date, sec] of Object.entries(week.dailySeconds)) {
          if (sec > 60) daySet.add(date)
        }
      }
    }
    const sorted = Array.from(daySet).sort()
    let max = 0
    let current = 0
    let prev: Date | null = null
    for (const d of sorted) {
      const date = new Date(d + 'T00:00:00')
      if (prev) {
        const diff = (date.getTime() - prev.getTime()) / (24 * 60 * 60 * 1000)
        if (diff === 1) {
          current++
        } else {
          current = 1
        }
      } else {
        current = 1
      }
      prev = date
      max = Math.max(max, current)
    }
    return max
  }, [stats])

  return (
    <div className="widget streak-widget" style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div className="widget-title" style={{ flexShrink: 0 }}>连续阅读</div>
      <div className="streak-body" style={{ flex: 1, minHeight: 0, alignItems: 'center', justifyContent: 'center', gap: 'clamp(8px, 2vw, 14px)' }}>
        <div className="streak-flame" style={{ width: 'clamp(32px, 18%, 48px)', height: 'auto', flexShrink: 0 }}>
          <svg width="100%" height="100%" viewBox="0 0 48 48" fill="none" style={{ display: 'block' }}>
            <path d="M24 4C24 4 12 16 12 28C12 34.6 17.4 40 24 40C30.6 40 36 34.6 36 28C36 22 30 14 24 4Z" fill="#e85d3e" opacity="0.2"/>
            <path d="M24 10C24 10 16 18 16 28C16 32.4 19.6 36 24 36C28.4 36 32 32.4 32 28C32 24 27 18 24 10Z" fill="#e85d3e"/>
            <path d="M24 16C24 16 20 22 20 28C20 30.2 21.8 32 24 32C26.2 32 28 30.2 28 28C28 26 25 22 24 16Z" fill="#ffb347"/>
          </svg>
        </div>
        <div className="streak-count" style={{ alignItems: 'baseline', gap: 'clamp(1px, 0.5vw, 2px)' }}>
          <span className="streak-number" style={{ fontSize: 'clamp(20px, 8vw, 36px)' }}>{streak}</span>
          <span className="streak-unit" style={{ fontSize: 'clamp(12px, 3vw, 15px)' }}>天</span>
        </div>
      </div>
      <div className="streak-sub" style={{ flexShrink: 0, fontSize: 'clamp(10px, 1.8vw, 12px)' }}>
        {streak > 0 ? '继续保持!' : '今天还没开始阅读'}
        {maxStreak > streak && ` · 最高纪录 ${maxStreak} 天`}
      </div>
    </div>
  )
}
