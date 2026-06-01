import { useEffect, useRef, useState, useCallback, useLayoutEffect } from 'react'
import { flushSync } from 'react-dom'
import type { BBox } from '@shared/types'
import { loadPdf, type LoadedPdf } from '../lib/pdfView'
import PdfPage from './PdfPage'

interface Props {
  bookId: string
  highlight: { pageNo: number; bbox: BBox } | null
  gotoPage?: { pageNo: number; nonce: number } | null
  hasKey: boolean
  onAskPageImage: (pageNo: number, pngDataUrl: string, sourceRect: DOMRect) => void
}

type ViewMode = 'single' | 'book' | 'continuous'
/** fitMode 决定 zoom 如何随容器变化:width=适应宽度,page=适应整页,none=手动固定值 */
type FitMode = 'width' | 'page' | 'none'

const MIN_ZOOM = 0.2
const MAX_ZOOM = 5
const PAGE_GAP = 24 // 连续模式页间距,需与 CSS 一致(用于占位计算)
const WRAP_PAD = 28 // .pdf-canvas-wrap 内边距

export default function PdfViewer({ bookId, highlight, gotoPage, hasKey, onAskPageImage }: Props): JSX.Element {
  const [pdf, setPdf] = useState<LoadedPdf | null>(null)
  const [pageNo, setPageNo] = useState(1)
  const [mode, setMode] = useState<ViewMode>('continuous')
  const [zoom, setZoom] = useState(1)
  const [fitMode, setFitMode] = useState<FitMode>('page')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [captureError, setCaptureError] = useState<string | null>(null)
  const [capturing, setCapturing] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [wrapSize, setWrapSize] = useState({ w: 0, h: 0 })
  const zoomAnchorRef = useRef<{ pageNo: number; ratio: number } | null>(null)

  // 加载 PDF
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    window.api
      .readPdfData(bookId)
      .then(async (data) => {
        if (!data) throw new Error('未找到 PDF 文件')
        const loaded = await loadPdf(data)
        if (!cancelled) {
          setPdf(loaded)
          setLoading(false)
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e))
          setLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [bookId])

  // 监听容器尺寸,用于 fit 计算
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    let timer: number | null = null
    const ro = new ResizeObserver((entries) => {
      const r = entries[0].contentRect
      if (timer) clearTimeout(timer)
      timer = window.setTimeout(() => {
        setWrapSize({ w: r.width, h: r.height })
      }, 100)
    })
    ro.observe(el)
    return () => {
      ro.disconnect()
      if (timer) clearTimeout(timer)
    }
  }, [pdf])

  // 当前参考页尺寸(适应计算以当前页为准,兼容不规则尺寸的 PDF)
  const refSize = useCallback((): { w: number; h: number } => {
    const sizes = pdf?.pageSizes
    if (!sizes || sizes.length === 0) return { w: 612, h: 792 }
    const s = sizes[Math.min(pageNo, sizes.length) - 1] ?? sizes[0]
    return { w: s.width, h: s.height }
  }, [pdf, pageNo])

  // 计算 fit 模式下的 zoom:可用宽高扣掉留白;书本模式按两页并排算宽
  const computeFitZoom = useCallback(
    (fm: FitMode): number => {
      if (fm === 'none' || wrapSize.w === 0) return zoom
      const { w, h } = refSize()
      const availW = wrapSize.w - WRAP_PAD * 2
      const availH = wrapSize.h - WRAP_PAD * 2
      const pageW = mode === 'book' ? w * 2 + 2 : w
      const byW = availW / pageW
      if (fm === 'width') return clampZoom(byW)
      // page:同时满足宽和高,取较小者,保证整页可见(不规则尺寸也不会被截断)
      const byH = availH / h
      return clampZoom(Math.min(byW, byH))
    },
    [wrapSize, refSize, mode, zoom]
  )

  // fit 模式下,容器尺寸/页面/模式变化时重算 zoom
  useEffect(() => {
    if (fitMode === 'none') return
    setZoom(computeFitZoom(fitMode))
  }, [fitMode, wrapSize, mode, pageNo, computeFitZoom])

  const scrollToPage = useCallback((p: number) => {
    const el = scrollRef.current?.querySelector(`[data-page="${p}"]`)
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [])

  const scrollToHighlight = useCallback((target: { pageNo: number; bbox: BBox }) => {
    const scroller = scrollRef.current
    const pageEl = scroller?.querySelector(`[data-page="${target.pageNo}"]`) as HTMLElement | null
    if (!scroller || !pageEl) return
    const top = pageEl.offsetTop + target.bbox.y * zoom - Math.max(48, scroller.clientHeight * 0.18)
    scroller.scrollTo({ top: Math.max(0, top), behavior: 'smooth' })
  }, [zoom])

  useEffect(() => {
    if (!highlight) return
    setPageNo(highlight.pageNo)
    if (mode === 'continuous') setTimeout(() => scrollToHighlight(highlight), 120)
  }, [highlight, mode, scrollToHighlight])

  useEffect(() => {
    if (!gotoPage) return
    setPageNo(gotoPage.pageNo)
    if (mode === 'continuous') setTimeout(() => scrollToPage(gotoPage.pageNo), 80)
  }, [gotoPage, mode, scrollToPage])

  useEffect(() => {
    const el = scrollRef.current
    if (!el || mode !== 'continuous') return
    let raf = 0
    const updateCurrentPage = (): void => {
      raf = 0
      const pages = el.querySelectorAll<HTMLElement>('[data-page]')
      const anchor = el.scrollTop + el.clientHeight * 0.38
      let bestPage = pageNo
      let bestDist = Number.POSITIVE_INFINITY
      for (const page of pages) {
        const top = page.offsetTop
        const dist = Math.abs(top - anchor)
        if (dist < bestDist) {
          bestDist = dist
          bestPage = Number(page.dataset.page) || bestPage
        }
      }
      setPageNo((prev) => (prev === bestPage ? prev : bestPage))
    }
    const onScroll = (): void => {
      if (raf) return
      raf = requestAnimationFrame(updateCurrentPage)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    updateCurrentPage()
    return () => {
      el.removeEventListener('scroll', onScroll)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [mode, pageNo])

  // 触控板捏合 / Ctrl(⌘)+滚轮 → 50ms 节流 + flushSync + 同步恢复
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    let lastTime = 0
    let pendingDelta = 0
    const handler = (e: WheelEvent): void => {
      if (!(e.ctrlKey || e.metaKey)) return
      e.preventDefault()
      pendingDelta += e.deltaY
      const now = performance.now()
      if (now - lastTime < 50) return
      lastTime = now
      const delta = pendingDelta
      pendingDelta = 0
      if (Math.abs(delta) < 0.5) return
      const factor = Math.exp(-delta * 0.004)
      // 记录缩放前锚点
      if (scrollRef.current && mode === 'continuous') {
        const scroller = scrollRef.current
        const viewCenter = scroller.scrollTop + scroller.clientHeight / 2
        const pages = scroller.querySelectorAll<HTMLElement>('[data-page]')
        const scrollerRect = scroller.getBoundingClientRect()
        for (const page of pages) {
          const rect = page.getBoundingClientRect()
          const top = rect.top - scrollerRect.top + scroller.scrollTop
          const bottom = top + rect.height
          if (viewCenter >= top && viewCenter <= bottom) {
            zoomAnchorRef.current = { pageNo: Number(page.dataset.page), ratio: (viewCenter - top) / rect.height }
            break
          }
        }
      }
      flushSync(() => {
        setFitMode('none')
        setZoom((z) => clampZoom(z * factor))
      })
      // 同步恢复 scroll
      if (scrollRef.current && zoomAnchorRef.current && mode === 'continuous') {
        const scroller = scrollRef.current
        const anchor = zoomAnchorRef.current
        const pageEl = scroller.querySelector(`[data-page="${anchor.pageNo}"]`) as HTMLElement | null
        if (pageEl) {
          const rect = pageEl.getBoundingClientRect()
          const scrollerRect = scroller.getBoundingClientRect()
          const top = rect.top - scrollerRect.top + scroller.scrollTop
          const newCenter = top + rect.height * anchor.ratio
          scroller.scrollTop = Math.max(0, newCenter - scroller.clientHeight / 2)
        }
      }
      // 惯性衰减：保留未消耗的部分进入下一次
      const remaining = delta * 0.25
      if (Math.abs(remaining) > 0.5) {
        pendingDelta = remaining
      }
    }
    el.addEventListener('wheel', handler, { passive: false })
    return () => el.removeEventListener('wheel', handler)
  }, [pdf, mode])

  // ⚠️ 以下两个 useCallback 必须在所有 early return 之前调用，否则 hooks 数量不一致
  const hlFor = useCallback((p: number): BBox | null => {
    return highlight && highlight.pageNo === p ? highlight.bbox : null
  }, [highlight])
  const sizeFor = useCallback((p: number): { w: number; h: number } => {
    const s = pdf?.pageSizes[p - 1] ?? pdf?.pageSizes[0] ?? { width: 612, height: 792 }
    return { w: s.width, h: s.height }
  }, [pdf])

  if (loading) return <div className="pdf-loading">正在加载 PDF…</div>
  if (error) return <div className="pdf-loading error">{error}</div>
  if (!pdf) return <div className="pdf-loading error">PDF 加载失败</div>

  const total = pdf.numPages

  const bookSpread = (): number[] => {
    if (pageNo <= 1) return [1]
    const left = pageNo % 2 === 0 ? pageNo : pageNo - 1
    return [left, left + 1].filter((p) => p <= total)
  }

  const step = mode === 'book' ? 2 : 1
  const canPrev = pageNo > 1
  const canNext = pageNo < total

  const nudgeZoom = (factor: number): void => {
    const scroller = scrollRef.current
    if (scroller && mode === 'continuous') {
      const viewCenter = scroller.scrollTop + scroller.clientHeight / 2
      const pages = scroller.querySelectorAll<HTMLElement>('[data-page]')
      const scrollerRect = scroller.getBoundingClientRect()
      for (const page of pages) {
        const rect = page.getBoundingClientRect()
        const top = rect.top - scrollerRect.top + scroller.scrollTop
        const bottom = top + rect.height
        if (viewCenter >= top && viewCenter <= bottom) {
          zoomAnchorRef.current = {
            pageNo: Number(page.dataset.page),
            ratio: (viewCenter - top) / rect.height
          }
          break
        }
      }
    }
    flushSync(() => {
      setFitMode('none')
      setZoom((z) => clampZoom(z * factor))
    })
    if (scroller && zoomAnchorRef.current && mode === 'continuous') {
      const anchor = zoomAnchorRef.current
      const pageEl = scroller.querySelector(`[data-page="${anchor.pageNo}"]`) as HTMLElement | null
      if (pageEl) {
        const rect = pageEl.getBoundingClientRect()
        const scrollerRect = scroller.getBoundingClientRect()
        const top = rect.top - scrollerRect.top + scroller.scrollTop
        const newCenter = top + rect.height * anchor.ratio
        scroller.scrollTop = Math.max(0, newCenter - scroller.clientHeight / 2)
      }
    }
  }

  const capturePageForAi = async (): Promise<void> => {
    if (!pdf || capturing || !hasKey) return
    setCapturing(true)
    setCaptureError(null)
    try {
      const spread = mode === 'book' ? bookSpread() : [pageNo]

      let dataUrl: string
      let sourceRect: DOMRect

      if (spread.length === 2) {
        // 双页模式：合并两页为一张图
        const leftResult = await pdf.rasterize(spread[0], 1.8)
        const rightResult = await pdf.rasterize(spread[1], 1.8)
        const width = leftResult.width + rightResult.width
        const height = Math.max(leftResult.height, rightResult.height)
        const canvas = document.createElement('canvas')
        canvas.width = width
        canvas.height = height
        const ctx = canvas.getContext('2d')!
        ctx.fillStyle = '#ffffff'
        ctx.fillRect(0, 0, canvas.width, canvas.height)

        const loadImg = (src: string) =>
          new Promise<HTMLImageElement>((res, rej) => {
            const img = new Image()
            img.onload = () => res(img)
            img.onerror = rej
            img.src = src
          })

        const leftImg = await loadImg(leftResult.dataUrl)
        const rightImg = await loadImg(rightResult.dataUrl)
        ctx.drawImage(leftImg, 0, 0)
        ctx.drawImage(rightImg, leftResult.width, 0)
        dataUrl = canvas.toDataURL('image/png')

        // sourceRect: 双页总区域
        const leftEl = scrollRef.current?.querySelector(`[data-page="${spread[0]}"] .pdf-page-canvas`) as HTMLElement | null
        const rightEl = scrollRef.current?.querySelector(`[data-page="${spread[1]}"] .pdf-page-canvas`) as HTMLElement | null
        if (leftEl && rightEl) {
          const leftRect = leftEl.getBoundingClientRect()
          const rightRect = rightEl.getBoundingClientRect()
          sourceRect = new DOMRect(
            leftRect.left,
            Math.min(leftRect.top, rightRect.top),
            rightRect.right - leftRect.left,
            Math.max(leftRect.bottom, rightRect.bottom) - Math.min(leftRect.top, rightRect.top)
          )
        } else {
          sourceRect = scrollRef.current?.getBoundingClientRect() ?? new DOMRect(0, 0, 1, 1)
        }
      } else {
        const targetPage = spread[0]
        const result = await pdf.rasterize(targetPage, 1.8)
        dataUrl = result.dataUrl
        const pageEl = scrollRef.current?.querySelector(`[data-page="${targetPage}"] .pdf-page-canvas`) as HTMLElement | null
        sourceRect = pageEl?.getBoundingClientRect() ?? scrollRef.current?.getBoundingClientRect() ?? new DOMRect(0, 0, 1, 1)
      }

      // Phase 1: 彩虹光带沿着页面边框流动（fixed 定位，不干扰 PDF DOM）
      const spreadEls = spread
        .map((p) => scrollRef.current?.querySelector(`[data-page="${p}"] .pdf-page-canvas`) as HTMLElement | null)
        .filter(Boolean) as HTMLElement[]
      if (spreadEls.length > 0) {
        const rects = spreadEls.map((el) => el.getBoundingClientRect())
        const left = Math.min(...rects.map((r) => r.left))
        const top = Math.min(...rects.map((r) => r.top))
        const right = Math.max(...rects.map((r) => r.right))
        const bottom = Math.max(...rects.map((r) => r.bottom))
        const pad = 6
        const strokeW = 4
        const rx = 8
        const w = right - left + pad * 2
        const h = bottom - top + pad * 2
        // 圆角矩形周长近似
        const straight = 2 * (w + h) - 8 * rx
        const arc = 2 * Math.PI * rx
        const perimeter = straight + arc
        const dashLen = perimeter * 0.85

        const aura = document.createElement('div')
        aura.style.cssText = `position:fixed;left:${left - pad}px;top:${top - pad}px;width:${w}px;height:${h}px;z-index:9999;pointer-events:none;`
        aura.innerHTML = `
          <svg width="${w}" height="${h}" style="overflow:visible">
            <defs>
              <linearGradient id="sg" x1="0" y1="0" x2="1" y2="0">
                <stop offset="0%" stop-color="#ff3e75"/>
                <stop offset="14%" stop-color="#ff9f43"/>
                <stop offset="28%" stop-color="#feca57"/>
                <stop offset="42%" stop-color="#48dbfb"/>
                <stop offset="56%" stop-color="#1dd1a1"/>
                <stop offset="70%" stop-color="#5f27cd"/>
                <stop offset="84%" stop-color="#ff9ff3"/>
                <stop offset="100%" stop-color="#ff3e75"/>
              </linearGradient>
            </defs>
            <rect x="${strokeW / 2}" y="${strokeW / 2}" width="${w - strokeW}" height="${h - strokeW}" rx="${rx}" ry="${rx}"
              fill="none" stroke="url(#sg)" stroke-width="${strokeW}" stroke-linecap="round"
              stroke-dasharray="${dashLen} ${perimeter - dashLen}" stroke-dashoffset="0">
              <animate attributeName="stroke-dashoffset" from="0" to="-${perimeter}" dur="2.8s" repeatCount="indefinite"/>
            </rect>
            <rect x="${strokeW / 2}" y="${strokeW / 2}" width="${w - strokeW}" height="${h - strokeW}" rx="${rx}" ry="${rx}"
              fill="none" stroke="url(#sg)" stroke-width="${strokeW * 4}" stroke-linecap="round"
              stroke-dasharray="${dashLen} ${perimeter - dashLen}" stroke-dashoffset="0"
              opacity="0.35">
              <animate attributeName="stroke-dashoffset" from="0" to="-${perimeter}" dur="2.8s" repeatCount="indefinite"/>
            </rect>
          </svg>
        `
        document.body.appendChild(aura)
        // 提前 300ms 触发灵魂飞入，让光带和灵魂化重叠，消灭卡顿感
        window.setTimeout(() => {
          onAskPageImage(spread[0], dataUrl, sourceRect)
        }, 500)
        await new Promise((r) => window.setTimeout(r, 800))
        aura.remove()
      } else {
        onAskPageImage(spread[0], dataUrl, sourceRect)
      }
    } catch (e) {
      setCaptureError(`截图失败:${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setCapturing(false)
    }
  }

  return (
    <div className="pdf-viewer">
      <div className="pdf-toolbar">
        <div className="pdf-view-modes">
          <button className={`seg ${mode === 'single' ? 'active' : ''}`} onClick={() => setMode('single')}>
            单页
          </button>
          <button className={`seg ${mode === 'book' ? 'active' : ''}`} onClick={() => setMode('book')}>
            书本
          </button>
          <button className={`seg ${mode === 'continuous' ? 'active' : ''}`} onClick={() => setMode('continuous')}>
            连续
          </button>
        </div>

        {mode !== 'continuous' && (
          <div className="pdf-nav">
            <button className="ghost-btn" disabled={!canPrev} onClick={() => setPageNo((p) => Math.max(1, p - step))}>
              ‹
            </button>
            <span className="page-indicator">
              {mode === 'book' ? bookSpread().join('–') : pageNo} / {total}
            </span>
            <button className="ghost-btn" disabled={!canNext} onClick={() => setPageNo((p) => Math.min(total, p + step))}>
              ›
            </button>
          </div>
        )}

        <div className="pdf-zoom">
          <button
            className={`page-ai-btn ${capturing ? 'listening' : ''}`}
            disabled={!hasKey || capturing}
            onClick={() => void capturePageForAi()}
            title={!hasKey ? '需先在设置中配置 API' : '截图当前页并发送给 AI'}
          >
            <span className="page-ai-orb" />
            <span>{capturing ? '截取中' : '问 AI'}</span>
          </button>
          {captureError && <span className="pdf-capture-error">{captureError}</span>}
          <button className="ghost-btn" onClick={() => nudgeZoom(1 / 1.15)} title="缩小">
            −
          </button>
          <span className="zoom-label">{Math.round(zoom * 100)}%</span>
          <button className="ghost-btn" onClick={() => nudgeZoom(1.15)} title="放大">
            ＋
          </button>
          <button
            className={`seg-fit ${fitMode === 'width' ? 'active' : ''}`}
            onClick={() => setFitMode('width')}
            title="适应宽度"
          >
            适宽
          </button>
          <button
            className={`seg-fit ${fitMode === 'page' ? 'active' : ''}`}
            onClick={() => setFitMode('page')}
            title="适应整页(完整显示,适合不规则尺寸)"
          >
            整页
          </button>
        </div>
      </div>

      <div className={`pdf-canvas-wrap mode-${mode}`} ref={scrollRef}>
        {mode === 'single' && (
          <PdfPage pdf={pdf} pageNo={pageNo} cssScale={zoom} baseSize={sizeFor(pageNo)} highlightBBox={hlFor(pageNo)} />
        )}

        {mode === 'book' && (
          <div className="pdf-spread">
            {bookSpread().map((p) => (
              <PdfPage key={p} pdf={pdf} pageNo={p} cssScale={zoom} baseSize={sizeFor(p)} highlightBBox={hlFor(p)} />
            ))}
          </div>
        )}

        {mode === 'continuous' && (
          <div className="pdf-continuous" style={{ gap: PAGE_GAP }}>
            {Array.from({ length: total }, (_, i) => i + 1).map((p) => (
              <PdfPage key={p} pdf={pdf} pageNo={p} cssScale={zoom} baseSize={sizeFor(p)} highlightBBox={hlFor(p)} virtual />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function clampZoom(z: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z))
}
