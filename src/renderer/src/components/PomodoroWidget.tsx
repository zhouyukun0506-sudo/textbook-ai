import type { PomodoroControls } from '../lib/usePomodoro'

interface Props {
  pomodoro: PomodoroControls
}

function fmt(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

export default function PomodoroWidget({ pomodoro }: Props): JSX.Element {
  const { phase, secondsLeft, running, completed, totalSeconds, toggle, reset, skip } = pomodoro
  const progress = totalSeconds > 0 ? 1 - secondsLeft / totalSeconds : 0

  // SVG 固定 viewBox，靠 CSS width 100% 自适应缩放
  const size = 100
  const stroke = 8
  const radius = (size - stroke) / 2
  const circ = 2 * Math.PI * radius
  const offset = circ - progress * circ
  const accent = phase === 'focus' ? 'var(--brass, #a8763e)' : '#4a7c6f'

  return (
    <div className="pomo-widget">
      <div className="pomo-head">
        <span className="pomo-phase" style={{ color: accent }}>
          {phase === 'focus' ? '专注' : '休息'}
        </span>
        <span className="pomo-rounds" title="今日完成的专注轮数">
          {'●'.repeat(Math.min(completed, 4))}
          {'○'.repeat(Math.max(0, 4 - completed))}
        </span>
      </div>

      <div className="pomo-ring">
        <svg width="100%" height="100%" viewBox={`0 0 ${size} ${size}`} style={{ display: 'block' }}>
          <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="var(--line, #e8e3d8)" strokeWidth={stroke} />
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke={accent}
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={circ}
            strokeDashoffset={offset}
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
            style={{ transition: 'stroke-dashoffset 0.4s linear' }}
          />
        </svg>
        <span className="pomo-time">{fmt(secondsLeft)}</span>
      </div>

      <div className="pomo-controls">
        <button className={`pomo-btn primary ${running ? 'on' : ''}`} onClick={toggle}>
          {running ? '暂停' : '开始'}
        </button>
        <button className="pomo-btn" onClick={skip} title="跳到下一阶段">
          跳过
        </button>
        <button className="pomo-btn" onClick={reset} title="重置为专注 25:00">
          重置
        </button>
      </div>
    </div>
  )
}
