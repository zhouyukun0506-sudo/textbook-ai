import { useEffect, useRef, useState } from 'react'

declare global {
  interface Window {
    mermaid?: {
      initialize: (cfg: Record<string, unknown>) => void
      render: (id: string, code: string) => Promise<{ svg: string }>
    }
  }
}

let mermaidInitialized = false

function waitForMermaid(maxMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (window.mermaid) {
      resolve()
      return
    }
    const start = Date.now()
    const timer = setInterval(() => {
      if (window.mermaid) {
        clearInterval(timer)
        resolve()
        return
      }
      if (Date.now() - start > maxMs) {
        clearInterval(timer)
        reject(new Error('Mermaid 库未加载'))
      }
    }, 100)
  })
}

interface Props {
  code: string
}

export default function MermaidBlock({ code }: Props): JSX.Element {
  const [svg, setSvg] = useState<string>('')
  const [err, setErr] = useState<string | null>(null)

  // 缩放/平移状态
  const [scale, setScale] = useState(1)
  const [tx, setTx] = useState(0)
  const [ty, setTy] = useState(0)
  const dragging = useRef(false)
  const lastPos = useRef({ x: 0, y: 0 })
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let canceled = false
    waitForMermaid()
      .then(() => {
        if (canceled) return
        if (!mermaidInitialized && window.mermaid) {
          window.mermaid.initialize({
            startOnLoad: false,
            securityLevel: 'strict',
            theme: 'base',
            themeVariables: {
              fontSize: '17px',
              fontFamily: 'var(--font-sans, "SF Pro", "PingFang SC", system-ui, sans-serif)',
              primaryColor: '#e8e0f0',
              primaryTextColor: '#2d2a33',
              primaryBorderColor: '#7c6f9e',
              lineColor: '#6b5b8a',
              secondaryColor: '#f0ebe3',
              tertiaryColor: '#e3edf5',
              background: '#ffffff',
              mainBkg: '#e8e0f0',
              secondBkg: '#f0ebe3',
              nodeBorder: '#7c6f9e',
              clusterBkg: '#f8f6fa',
              clusterBorder: '#c4b9d6',
              titleColor: '#2d2a33',
              edgeLabelBackground: '#ffffff',
              nodeTextColor: '#2d2a33'
            },
            flowchart: {
              htmlLabels: true,
              curve: 'basis',
              padding: 16,
              nodeSpacing: 40,
              rankSpacing: 50,
              useMaxWidth: true
            }
          })
          mermaidInitialized = true
        }
        const id = `mermaid-${Math.random().toString(36).slice(2, 10)}`
        return window.mermaid!.render(id, code.trim())
      })
      .then((res) => {
        if (canceled || !res) return
        setSvg(res.svg)
        setErr(null)
      })
      .catch((e) => {
        if (canceled) return
        setErr(e instanceof Error ? e.message : String(e))
      })
    return () => { canceled = true }
  }, [code])

  // 缩放
  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault()
    const delta = e.deltaY
    setScale((prev) => {
      const next = delta > 0 ? prev * 0.92 : prev * 1.08
      return Math.max(0.3, Math.min(3, next))
    })
  }

  // 拖拽平移
  const onMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return
    dragging.current = true
    lastPos.current = { x: e.clientX, y: e.clientY }
    document.body.style.cursor = 'grabbing'
  }

  const onMouseMove = (e: React.MouseEvent) => {
    if (!dragging.current) return
    const dx = e.clientX - lastPos.current.x
    const dy = e.clientY - lastPos.current.y
    lastPos.current = { x: e.clientX, y: e.clientY }
    setTx((prev) => prev + dx)
    setTy((prev) => prev + dy)
  }

  const onMouseUp = () => {
    dragging.current = false
    document.body.style.cursor = ''
  }

  const resetView = () => {
    setScale(1)
    setTx(0)
    setTy(0)
  }

  if (err) {
    return (
      <pre className="mermaid-error">
        <code>{code}</code>
        <div className="mermaid-err-msg">图表渲染失败: {err}</div>
      </pre>
    )
  }

  if (!svg) {
    return <div className="mermaid-block">加载图表...</div>
  }

  return (
    <div
      ref={wrapRef}
      className="mermaid-block"
      onWheel={onWheel}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onMouseLeave={onMouseUp}
      style={{ cursor: dragging.current ? 'grabbing' : 'grab' }}
    >
      <div className="mermaid-zoom-hint">
        滚轮缩放 · 拖拽移动
        {scale !== 1 || tx !== 0 || ty !== 0 ? (
          <button className="mermaid-reset" onClick={resetView}>重置</button>
        ) : null}
      </div>
      <div
        className="mermaid-svg-wrap"
        style={{
          transform: `translate(${tx}px, ${ty}px) scale(${scale})`,
          transformOrigin: 'center center'
        }}
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    </div>
  )
}
