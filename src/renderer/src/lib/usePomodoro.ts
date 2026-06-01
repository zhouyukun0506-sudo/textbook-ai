import { useState, useEffect, useRef, useCallback } from 'react'

export type PomodoroPhase = 'focus' | 'break'

export interface PomodoroState {
  phase: PomodoroPhase
  /** 剩余秒数 */
  secondsLeft: number
  running: boolean
  /** 已完成的专注轮数(走完一个 focus 阶段 +1) */
  completed: number
  /** 当前阶段的总时长(秒),用于画进度环 */
  totalSeconds: number
}

export interface PomodoroControls extends PomodoroState {
  start: () => void
  pause: () => void
  toggle: () => void
  reset: () => void
  /** 跳到下一阶段(focus↔break) */
  skip: () => void
}

const FOCUS_SECONDS = 25 * 60
const BREAK_SECONDS = 5 * 60

function phaseDuration(phase: PomodoroPhase): number {
  return phase === 'focus' ? FOCUS_SECONDS : BREAK_SECONDS
}

/**
 * App 级番茄钟:状态存在内存,切换页面/回主页都继续走(仅运行时联动,关 app 重置)。
 * 用 endTimestamp（目标结束时刻）+ 每秒 tick 计算剩余，避免后台节流导致计时漂移。
 */
export function usePomodoro(): PomodoroControls {
  const [phase, setPhase] = useState<PomodoroPhase>('focus')
  const [secondsLeft, setSecondsLeft] = useState(FOCUS_SECONDS)
  const [running, setRunning] = useState(false)
  const [completed, setCompleted] = useState(0)

  // 运行时记录目标结束时刻，tick 时用它反推剩余秒数（不受 setInterval 抖动影响）
  const endRef = useRef<number>(0)
  const phaseRef = useRef<PomodoroPhase>(phase)
  phaseRef.current = phase

  // 阶段切换：focus 走完 +1 轮并进入 break，break 走完回 focus
  const advancePhase = useCallback(() => {
    const cur = phaseRef.current
    const nextPhase: PomodoroPhase = cur === 'focus' ? 'break' : 'focus'
    if (cur === 'focus') setCompleted((c) => c + 1)
    setPhase(nextPhase)
    const dur = phaseDuration(nextPhase)
    setSecondsLeft(dur)
    endRef.current = Date.now() + dur * 1000
    // 阶段结束后自动暂停，等用户主动开始下一段（更符合休息节奏）
    setRunning(false)
  }, [])

  useEffect(() => {
    if (!running) return
    const tick = (): void => {
      const remain = Math.round((endRef.current - Date.now()) / 1000)
      if (remain <= 0) {
        advancePhase()
      } else {
        setSecondsLeft(remain)
      }
    }
    const id = window.setInterval(tick, 250)
    return () => window.clearInterval(id)
  }, [running, advancePhase])

  const start = useCallback(() => {
    setRunning((r) => {
      if (r) return r
      endRef.current = Date.now() + secondsLeft * 1000
      return true
    })
  }, [secondsLeft])

  const pause = useCallback(() => setRunning(false), [])

  const toggle = useCallback(() => {
    setRunning((r) => {
      if (!r) endRef.current = Date.now() + secondsLeft * 1000
      return !r
    })
  }, [secondsLeft])

  const reset = useCallback(() => {
    setRunning(false)
    setPhase('focus')
    setSecondsLeft(FOCUS_SECONDS)
  }, [])

  const skip = useCallback(() => {
    setRunning(false)
    advancePhase()
  }, [advancePhase])

  return {
    phase,
    secondsLeft,
    running,
    completed,
    totalSeconds: phaseDuration(phase),
    start,
    pause,
    toggle,
    reset,
    skip
  }
}
