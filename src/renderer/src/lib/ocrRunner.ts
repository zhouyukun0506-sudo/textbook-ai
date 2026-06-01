// 渲染进程内的 OCR 执行器:对扫描页栅格化后用 Tesseract.js 本地识别,
// hybrid 模式下低置信度页改用云端视觉模型(经主进程,持有 key)。
// 识别坐标会换算回 PDF scale=1 坐标系,以便和文本页统一用于原文高亮回跳。
import { createWorker, type Worker } from 'tesseract.js'
import type { TextBlock, OcrPageResult, OcrMode } from '@shared/types'
import { loadPdf } from './pdfView'

const OCR_SCALE = 2.2 // 栅格化倍率:越高越清晰但越慢,2~2.5 对扫描件较稳

// Tesseract 资源已打包进 APP(public/tessdata/),安装后开箱即用,无需联网下载。
// 开发时由 Vite dev server 提供;生产时随 renderer 输出目录打包。
const TESS_OPTS = {
  workerPath: './tessdata/worker.min.js',
  corePath: './tessdata',
  langPath: './tessdata'
}

/** 带超时的 Promise 包装 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} 超时(${ms}ms)`)), ms)
    promise.then(
      (v) => { clearTimeout(timer); resolve(v) },
      (e) => { clearTimeout(timer); reject(e) }
    )
  })
}

export interface OcrProgress {
  done: number
  total: number
  pageNo: number
  via: 'local' | 'cloud'
}

/**
 * 对一本书的扫描页执行 OCR。
 * @returns 每页的识别结果(已换算坐标)
 */
export async function runOcr(
  bookId: string,
  pageNos: number[],
  mode: OcrMode,
  onProgress?: (p: OcrProgress) => void,
  shouldAbort?: () => boolean
): Promise<OcrPageResult[]> {
  if (pageNos.length === 0) return []

  const data = await window.api.readPdfData(bookId)
  if (!data) throw new Error('OCR 失败:未找到 PDF 数据')
  const pdf = await loadPdf(data)

  // 本地 worker 用 holder 持有,便于 finally 释放(避免闭包赋值干扰类型收窄)。
  // localBroken: 本地 worker 起不来(如 CSP/网络),则 hybrid 自动全程走云端。
  const holder: { worker: Worker | null; localBroken: boolean } = { worker: null, localBroken: false }
  const ensureWorker = async (): Promise<Worker> => {
    if (!holder.worker) {
      try {
        holder.worker = await withTimeout(
          createWorker('eng', 1, TESS_OPTS),
          25000,
          '本地 OCR 内核加载'
        )
      } catch (e) {
        holder.localBroken = true
        throw e
      }
    }
    return holder.worker
  }

  const results: OcrPageResult[] = []
  let done = 0

  try {
    for (const pageNo of pageNos) {
      if (shouldAbort?.()) throw new Error('__CANCELED__')
      const { dataUrl } = await pdf.rasterize(pageNo, OCR_SCALE)

      let blocks: TextBlock[] = []
      let confidence: number | undefined
      let via: 'local' | 'cloud' = 'local'

      // 纯云端,或本地内核起不来后的降级:直接走云端
      if (mode === 'cloud' || holder.localBroken) {
        via = 'cloud'
        blocks = await window.api.ocrPageCloud(bookId, pageNo, dataUrl)
      } else {
        // local 或 hybrid:先尝试本地识别
        let localOk = true
        try {
          const w = await ensureWorker()
          const { data: res } = await withTimeout(
            w.recognize(dataUrl),
            45000,
            `第 ${pageNo} 页本地识别`
          )
          confidence = res.confidence
          blocks = wordsToBlocks(res, pageNo, OCR_SCALE)
        } catch (e) {
          // 本地内核加载/识别失败(常见于 CSP 或离线无缓存,或超时)
          localOk = false
          holder.localBroken = true
          if (mode === 'local') {
            // 仅本地模式无从降级,如实抛出
            throw new Error(
              `本地 OCR 失败(可能是网络、安全策略或识别超时)。可在设置中改用「混合」或「云端」模式。原始错误:${
                e instanceof Error ? e.message : String(e)
              }`
            )
          }
        }

        // hybrid:本地失败、置信度偏低或几乎没识别出文字 → 云端兜底
        const needCloud = !localOk || confidence === undefined || confidence < 60 || blocks.length === 0
        if (mode === 'hybrid' && needCloud) {
          try {
            const cloudBlocks = await window.api.ocrPageCloud(bookId, pageNo, dataUrl)
            if (cloudBlocks.length > 0) {
              blocks = cloudBlocks
              via = 'cloud'
            }
          } catch (cloudErr) {
            // 云端也失败则保留本地结果(可能为空),但至少记录日志
            console.warn(`第 ${pageNo} 页云端 OCR 也失败:`, cloudErr)
          }
        }
      }

      results.push({ pageNo, blocks, confidence })
      done++
      onProgress?.({ done, total: pageNos.length, pageNo, via })
    }
  } finally {
    if (holder.worker) await holder.worker.terminate()
  }

  return results
}

/** 把 Tesseract 的行/词结果转成 TextBlock,坐标从栅格像素换算回 scale=1 */
function wordsToBlocks(
  res: { lines?: Array<{ text: string; bbox: { x0: number; y0: number; x1: number; y1: number } }> },
  pageNo: number,
  scale: number
): TextBlock[] {
  const lines = res.lines ?? []
  return lines
    .filter((l) => l.text && l.text.trim())
    .map((l) => ({
      pageNo,
      text: l.text.trim(),
      bbox: {
        x: l.bbox.x0 / scale,
        y: l.bbox.y0 / scale,
        w: (l.bbox.x1 - l.bbox.x0) / scale,
        h: (l.bbox.y1 - l.bbox.y0) / scale
      }
    }))
}
