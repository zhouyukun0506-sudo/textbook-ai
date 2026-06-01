// 渲染进程内的 pdf.js 封装:加载 PDF、按设备像素比清晰渲染、返回页面尺寸。
import * as pdfjs from 'pdfjs-dist'
// Vite 通过 ?url 拿到 worker 的可访问地址
// @ts-expect-error - vite 资源 url 导入
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

export interface RenderInfo {
  /** CSS 像素宽高(用于布局与坐标换算,等于 baseSize * scale) */
  cssWidth: number
  cssHeight: number
  /** scale=1 时的原始尺寸,用于把 bbox 坐标换算到当前缩放 */
  baseWidth: number
  baseHeight: number
}

export interface LoadedPdf {
  numPages: number
  /** 各页 scale=1 时的原始尺寸(1-based 索引对应 pageSizes[pageNo-1]) */
  pageSizes: Array<{ width: number; height: number }>
  /** 按 CSS 缩放渲染一页到 canvas,内部按 devicePixelRatio 提升清晰度 */
  renderPage: (pageNo: number, canvas: HTMLCanvasElement, cssScale: number) => Promise<RenderInfo>
  /** 把某页栅格化为 PNG dataURL(用于 OCR) */
  rasterize: (pageNo: number, scale: number) => Promise<{ dataUrl: string; width: number; height: number }>
}

export async function loadPdf(data: Uint8Array): Promise<LoadedPdf> {
  const doc = await pdfjs.getDocument({ data }).promise

  // 预读各页尺寸:用于「适应页面」计算与连续模式占位,避免渲染后高度突变导致滚动跳动。
  // pdf.js 取 viewport 很轻量,这里串行读一遍即可(大书也只是读尺寸,不渲染)。
  const pageSizes: Array<{ width: number; height: number }> = []
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i)
    const vp = page.getViewport({ scale: 1 })
    pageSizes.push({ width: vp.width, height: vp.height })
    page.cleanup()
  }

  return {
    numPages: doc.numPages,
    pageSizes,
    renderPage: async (pageNo, canvas, cssScale) => {
      const page = await doc.getPage(pageNo)
      const cssViewport = page.getViewport({ scale: cssScale })
      // DPR 智能降级:大页面或高缩放时自动降低 DPR,避免内存/性能崩溃
      // 渲染面积 = CSS 宽 × CSS 高 × dpr²,是性能的关键瓶颈
      const rawDpr = window.devicePixelRatio || 1
      const cssArea = cssViewport.width * cssViewport.height
      const dpr =
        cssArea > 2_400_000 ? Math.min(rawDpr, 1.2) :
        cssArea > 1_200_000 ? Math.min(rawDpr, 1.6) :
        cssArea > 600_000  ? Math.min(rawDpr, 2) :
        Math.min(rawDpr, 2.5)
      const renderViewport = page.getViewport({ scale: cssScale * dpr })
      const ctx = canvas.getContext('2d')!
      canvas.width = Math.ceil(renderViewport.width)
      canvas.height = Math.ceil(renderViewport.height)
      // CSS 尺寸保持逻辑像素,浏览器把高分辨率位图缩放显示
      canvas.style.width = `${Math.floor(cssViewport.width)}px`
      canvas.style.height = `${Math.floor(cssViewport.height)}px`
      await page.render({ canvasContext: ctx, viewport: renderViewport }).promise
      const base = page.getViewport({ scale: 1 })
      return {
        cssWidth: cssViewport.width,
        cssHeight: cssViewport.height,
        baseWidth: base.width,
        baseHeight: base.height
      }
    },
    rasterize: async (pageNo, scale) => {
      const page = await doc.getPage(pageNo)
      const viewport = page.getViewport({ scale })
      const canvas = document.createElement('canvas')
      canvas.width = viewport.width
      canvas.height = viewport.height
      const ctx = canvas.getContext('2d')!
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      await page.render({ canvasContext: ctx, viewport }).promise
      return { dataUrl: canvas.toDataURL('image/png'), width: canvas.width, height: canvas.height }
    }
  }
}
