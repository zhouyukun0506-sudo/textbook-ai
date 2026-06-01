import { useEffect, useRef, useState, memo } from 'react'
import type { CSSProperties } from 'react'
import type { BBox } from '@shared/types'
import type { LoadedPdf } from '../lib/pdfView'

interface Props {
  pdf: LoadedPdf
  pageNo: number
  cssScale: number
  /** 该页 scale=1 原始尺寸,用于精确占位(避免渲染后高度突变导致滚动跳动) */
  baseSize: { w: number; h: number }
  /** 该页若是高亮目标,传入 bbox(scale=1 坐标);否则 null */
  highlightBBox?: BBox | null
  /** 是否启用虚拟化:不在视口附近时不挂载 canvas,减少内存占用(连续模式用) */
  virtual?: boolean
}

/** 单页:虚拟化 + 双向 IntersectionObserver + 防抖重渲染,大幅优化大 PDF 性能。 */
function PdfPageInternal({
  pdf,
  pageNo,
  cssScale,
  baseSize,
  highlightBBox,
  virtual = false
}: Props): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const lastScaleRef = useRef<number>(cssScale)
  const [inView, setInView] = useState(!virtual)
  const [rendered, setRendered] = useState(false)

  // 双向 IntersectionObserver:进入视口附近才准备渲染,离开视口后卸载 canvas 释放内存
  useEffect(() => {
    if (!virtual || !wrapRef.current) return
    const el = wrapRef.current
    const io = new IntersectionObserver(
      (entries) => {
        setInView(entries.some((e) => e.isIntersecting))
      },
      // 上下各预留 400px(约半屏),平衡"滚动不闪白"与"内存占用"
      { root: null, rootMargin: '400px 0px' }
    )
    io.observe(el)
    return () => io.disconnect()
  }, [virtual])

  // 渲染:防抖 80ms + 避免重复渲染(zoom 没变时不重绘)
  useEffect(() => {
    if (!inView) {
      setRendered(false)
      return
    }
    const canvas = canvasRef.current
    if (!canvas) return
    // zoom 没变且已经渲染过 → 跳过,避免缩放稳定后的无谓重绘
    if (rendered && lastScaleRef.current === cssScale) return

    let cancelled = false
    const timer = setTimeout(() => {
      if (cancelled) return
      lastScaleRef.current = cssScale
      pdf.renderPage(pageNo, canvas, cssScale).then(() => {
        if (!cancelled) setRendered(true)
      })
    }, 80)

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [pdf, pageNo, cssScale, inView, rendered])

  // 占位/外框尺寸用已知的 baseSize 精确计算,渲染前后高度一致 → 滚动条稳定
  const boxW = baseSize.w * cssScale
  const boxH = baseSize.h * cssScale

  const hlStyle = (): CSSProperties | undefined => {
    if (!highlightBBox) return undefined
    return {
      position: 'absolute',
      left: highlightBBox.x * cssScale,
      top: highlightBBox.y * cssScale,
      width: highlightBBox.w * cssScale,
      height: highlightBBox.h * cssScale
    }
  }

  return (
    <div className="pdf-page" ref={wrapRef} data-page={pageNo}>
      <div className="pdf-page-canvas" style={{ width: boxW, height: boxH }}>
        {/* 不在视口附近时只保留精确占位,不挂载 canvas,大幅减少内存 */}
        {inView && <canvas ref={canvasRef} style={{ width: boxW, height: boxH }} />}
        {!rendered && <div className="pdf-page-skeleton" style={{ width: boxW, height: boxH }} />}
        {rendered && highlightBBox && (
          <div
            key={`${pageNo}-${highlightBBox.x}-${highlightBBox.y}-${highlightBBox.w}-${highlightBBox.h}`}
            className="pdf-highlight"
            style={hlStyle()}
          />
        )}
      </div>
      <div className="pdf-page-no">{pageNo}</div>
    </div>
  )
}

export default memo(PdfPageInternal)
