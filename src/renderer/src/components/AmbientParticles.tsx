import { useEffect, useRef } from 'react'

/* ============================================================
   鼠标拖尾光尘 — 暖金色系，低调隐约
   ============================================================ */

interface Spark {
  x: number
  y: number
  vx: number
  vy: number
  life: number
  decay: number
  size: number
  hue: number
  sat: number
  trail: { x: number; y: number }[]
}

const MAX_TRAIL = 22
const MAX_SPARKS = 180

export default function AmbientParticles(): JSX.Element | null {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const mouseRef = useRef({ x: -9999, y: -9999, px: -9999, py: -9999, active: false })
  const sparksRef = useRef<Spark[]>([])
  const rafRef = useRef(0)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d', { alpha: true })
    if (!ctx) return

    const dpr = Math.min(window.devicePixelRatio || 1, 2)

    const resize = () => {
      const w = window.innerWidth
      const h = window.innerHeight
      canvas.width = w * dpr
      canvas.height = h * dpr
      canvas.style.width = w + 'px'
      canvas.style.height = h + 'px'
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    resize()

    let resizeTimer: ReturnType<typeof setTimeout>
    const onResize = () => {
      clearTimeout(resizeTimer)
      resizeTimer = setTimeout(resize, 120)
    }
    window.addEventListener('resize', onResize, { passive: true })

    const sparks: Spark[] = []
    sparksRef.current = sparks

    const onMouseMove = (e: MouseEvent) => {
      const m = mouseRef.current
      m.px = m.x
      m.py = m.y
      m.x = e.clientX
      m.y = e.clientY
      m.active = true

      const dx = m.x - m.px
      const dy = m.y - m.py
      const speed = Math.sqrt(dx * dx + dy * dy)

      const count = Math.min(3, Math.max(0, Math.floor(speed * 0.12)))
      for (let i = 0; i < count && sparks.length < MAX_SPARKS; i++) {
        const angle = Math.atan2(dy, dx) + (Math.random() - 0.5) * 1.0
        const spread = Math.random() * 10
        // 暖金色系：琥珀到淡金
        const hue = 34 + Math.random() * 18
        const sat = 45 + Math.random() * 20
        sparks.push({
          x: m.x + Math.cos(angle) * spread,
          y: m.y + Math.sin(angle) * spread,
          vx: Math.cos(angle) * (speed * 0.05 + Math.random() * 0.8) + (Math.random() - 0.5) * 0.5,
          vy: Math.sin(angle) * (speed * 0.05 + Math.random() * 0.8) + (Math.random() - 0.5) * 0.5,
          life: 1,
          decay: 0.02 + Math.random() * 0.02,
          size: 0.8 + Math.random() * 1.4,
          hue,
          sat,
          trail: [{ x: m.x, y: m.y }],
        })
      }
    }
    const onMouseLeave = () => {
      mouseRef.current.active = false
    }
    window.addEventListener('mousemove', onMouseMove, { passive: true })
    window.addEventListener('mouseleave', onMouseLeave)

    const animate = () => {
      const w = window.innerWidth
      const h = window.innerHeight
      ctx.clearRect(0, 0, w, h)

      for (let i = sparks.length - 1; i >= 0; i--) {
        const s = sparks[i]
        s.life -= s.decay
        if (s.life <= 0) {
          sparks.splice(i, 1)
          continue
        }
        s.vx *= 0.97
        s.vy *= 0.97
        s.x += s.vx
        s.y += s.vy
        s.trail.push({ x: s.x, y: s.y })
        if (s.trail.length > MAX_TRAIL) s.trail.shift()
      }

      // 大面积 glow（screen 混合，极淡）
      ctx.globalCompositeOperation = 'screen'

      for (const s of sparks) {
        const len = s.trail.length
        if (len < 2) continue

        for (let i = 0; i < len - 1; i++) {
          const a = s.trail[i]
          const b = s.trail[i + 1]
          const t = (i + 1) / len
          const segAlpha = t * s.life * 0.12
          const segWidth = s.size * t * 2.5 * s.life
          ctx.beginPath()
          ctx.moveTo(a.x, a.y)
          ctx.lineTo(b.x, b.y)
          ctx.strokeStyle = `hsla(${s.hue}, ${s.sat}%, 58%, ${segAlpha})`
          ctx.lineWidth = Math.max(0.3, segWidth)
          ctx.lineCap = 'round'
          ctx.stroke()
        }

        const outerR = s.size * 10 * s.life
        const og = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, outerR)
        og.addColorStop(0, `hsla(${s.hue}, ${s.sat}%, 55%, ${s.life * 0.08})`)
        og.addColorStop(0.5, `hsla(${s.hue}, ${s.sat - 10}%, 50%, ${s.life * 0.03})`)
        og.addColorStop(1, `hsla(${s.hue}, ${s.sat - 20}%, 45%, 0)`)
        ctx.fillStyle = og
        ctx.beginPath()
        ctx.arc(s.x, s.y, outerR, 0, Math.PI * 2)
        ctx.fill()
      }

      // 核心绘制（source-over）
      ctx.globalCompositeOperation = 'source-over'

      for (const s of sparks) {
        const len = s.trail.length
        if (len < 2) continue

        for (let i = Math.max(0, len - 3); i < len - 1; i++) {
          const a = s.trail[i]
          const b = s.trail[i + 1]
          const t = (i + 1) / len
          ctx.beginPath()
          ctx.moveTo(a.x, a.y)
          ctx.lineTo(b.x, b.y)
          ctx.strokeStyle = `hsla(${s.hue}, ${s.sat}%, 42%, ${t * s.life * 0.25})`
          ctx.lineWidth = s.size * t * 1.0 * s.life
          ctx.lineCap = 'round'
          ctx.stroke()
        }

        const midR = s.size * 3.0 * s.life
        const mg = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, midR)
        mg.addColorStop(0, `hsla(${s.hue}, ${s.sat}%, 48%, ${s.life * 0.22})`)
        mg.addColorStop(1, `hsla(${s.hue}, ${s.sat - 10}%, 42%, 0)`)
        ctx.fillStyle = mg
        ctx.beginPath()
        ctx.arc(s.x, s.y, midR, 0, Math.PI * 2)
        ctx.fill()

        ctx.save()
        ctx.shadowColor = `hsla(${s.hue}, ${s.sat}%, 50%, ${s.life * 0.25})`
        ctx.shadowBlur = s.size * 5 * s.life
        ctx.fillStyle = `hsla(${s.hue}, ${s.sat}%, 30%, ${s.life * 0.6})`
        ctx.beginPath()
        ctx.arc(s.x, s.y, s.size * s.life, 0, Math.PI * 2)
        ctx.fill()
        ctx.restore()

        ctx.fillStyle = `hsla(${s.hue + 5}, 25%, 82%, ${s.life * 0.25})`
        ctx.beginPath()
        ctx.arc(s.x - s.size * 0.2 * s.life, s.y - s.size * 0.2 * s.life, s.size * 0.25 * s.life, 0, Math.PI * 2)
        ctx.fill()
      }

      rafRef.current = requestAnimationFrame(animate)
    }

    rafRef.current = requestAnimationFrame(animate)

    return () => {
      cancelAnimationFrame(rafRef.current)
      window.removeEventListener('resize', onResize)
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseleave', onMouseLeave)
      clearTimeout(resizeTimer)
    }
  }, [])

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
        zIndex: 0,
      }}
    />
  )
}
