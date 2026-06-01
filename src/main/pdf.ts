// PDF 解析:用 pdfjs-dist 抽取每页文本及坐标,聚合成块再切分为语义 Chunk。
// 第一版只处理文本型 PDF;无文本层(扫描件)时返回空块,交由上层提示用户。
import type { Chunk, TextBlock, BBox, PageKind } from '../shared/types'

// pdfjs-dist v4 为 ESM-only,主进程为 CJS,用动态 import() 兼容两种模块系统。
// 用 Function 包一层避免 TS 把 import() 降级成 require()。
const dynamicImport = new Function('m', 'return import(m)') as (m: string) => Promise<any>
let pdfjsPromise: Promise<any> | null = null
function getPdfjs(): Promise<any> {
  if (!pdfjsPromise) {
    pdfjsPromise = dynamicImport('pdfjs-dist/legacy/build/pdf.mjs')
  }
  return pdfjsPromise
}

export interface ParseResult {
  pageCount: number
  blocks: TextBlock[]
  /** 每页的类型:有文本层为 text,几乎无文字的视为 scanned(需 OCR) */
  pageKinds: PageKind[]
  /** 各页尺寸(scale=1),OCR 时把识别坐标对齐到该尺寸 */
  pageSizes: Array<{ width: number; height: number }>
}

interface RawItem {
  str: string
  x: number
  y: number
  w: number
  h: number
}

/** 让出事件循环,避免长解析阻塞主进程(界面假死) */
function yieldToLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

/** 解析 PDF 字节流,返回页数、文本块、各页类型与尺寸。
 *  onPage 每解析完一页回调一次,用于上报进度。 */
export async function parsePdf(
  data: Uint8Array,
  onPage?: (done: number, total: number) => void
): Promise<ParseResult> {
  const pdfjs = await getPdfjs()
  const doc = await pdfjs.getDocument({ data, useSystemFonts: true, isEvalSupported: false }).promise
  const blocks: TextBlock[] = []
  const pageKinds: PageKind[] = []
  const pageSizes: Array<{ width: number; height: number }> = []

  // 图片操作常量(从 pdfjs 模块获取)
  const OPS = pdfjs.OPS as Record<string, number>
  const IMAGE_OPS = new Set<number>([
    OPS.paintImageXObject,
    OPS.paintImageMaskXObject,
    OPS.paintInlineImageXObject,
    OPS.paintImageXObjectRepeat,
    OPS.paintImageMaskXObjectRepeat,
    OPS.paintImageMaskXObjectGroup,
    OPS.paintInlineImageXObjectGroup
  ])

  for (let pageNo = 1; pageNo <= doc.numPages; pageNo++) {
    const page = await doc.getPage(pageNo)
    const viewport = page.getViewport({ scale: 1 })
    const pageHeight = viewport.height
    const pageArea = viewport.width * viewport.height
    pageSizes.push({ width: viewport.width, height: viewport.height })
    const content = await page.getTextContent()

    const items: RawItem[] = []
    let charCount = 0
    for (const item of content.items as Array<{ str: string; transform: number[]; width: number; height: number }>) {
      if (!item.str || !item.str.trim()) continue
      charCount += item.str.trim().length
      const tx = item.transform
      const x = tx[4]
      const yBottom = tx[5]
      const h = item.height || Math.abs(tx[3]) || 10
      // 转成左上原点坐标系,方便前端高亮
      const y = pageHeight - yBottom - h
      items.push({ str: item.str, x, y, w: item.width || 0, h })
    }

    // 获取操作列表,统计图片操作数量(用于判断扫描页)
    let imgOps = 0
    try {
      const opList = await page.getOperatorList()
      for (const fn of opList.fnArray) {
        if (IMAGE_OPS.has(fn)) imgOps++
      }
    } catch {
      // getOperatorList 失败不影响,保守按文本层判断
    }

    // 文本密度:每平方像素多少个字符(典型值:文本页 0.001~0.005,扫描页 < 0.0003)
    const textDensity = pageArea > 0 ? charCount / pageArea : 0

    // 扫描页判断:
    // 1. 字符极少(<30)且有图片 → 扫描页
    // 2. 字符不少但图片很多(>3)且文本密度极低(<0.0003) → 可能是扫描件带隐藏OCR层
    // 3. 其他 → 文本页
    const isScanned =
      (charCount < 30 && imgOps > 0) ||
      (charCount >= 30 && imgOps > 3 && textDensity < 0.0003)

    const kind: PageKind = isScanned ? 'scanned' : 'text'
    pageKinds.push(kind)
    if (kind === 'text') {
      const lineBlocks = groupIntoLines(items, pageNo)
      blocks.push(...lineBlocks)
    }
    page.cleanup()
    onPage?.(pageNo, doc.numPages)
    // 每页让出一次事件循环,保持主进程响应
    await yieldToLoop()
  }

  const pageCount = doc.numPages
  await doc.destroy()
  return { pageCount, blocks, pageKinds, pageSizes }
}

/** 按纵坐标将文本片段聚合为行级文本块 */
function groupIntoLines(items: RawItem[], pageNo: number): TextBlock[] {
  if (items.length === 0) return []
  // 先按 y 再按 x 排序
  items.sort((a, b) => a.y - b.y || a.x - b.x)
  const lines: RawItem[][] = []
  const yTol = 4 // 同一行的 y 容差
  for (const it of items) {
    const last = lines[lines.length - 1]
    if (last && Math.abs(last[0].y - it.y) <= yTol) {
      last.push(it)
    } else {
      lines.push([it])
    }
  }

  return lines.map((line) => {
    line.sort((a, b) => a.x - b.x)
    const text = line.map((i) => i.str).join(' ').replace(/\s+/g, ' ').trim()
    const bbox = mergeBBox(line)
    return { pageNo, text, bbox }
  }).filter((b) => b.text.length > 0)
}

function mergeBBox(items: RawItem[]): BBox {
  const x0 = Math.min(...items.map((i) => i.x))
  const y0 = Math.min(...items.map((i) => i.y))
  const x1 = Math.max(...items.map((i) => i.x + i.w))
  const y1 = Math.max(...items.map((i) => i.y + i.h))
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

const SECTION_RE = /^(chapter\s+\d+|section\s+\d+|\d+(\.\d+)*\s+[A-Z])/i

/** 将文本块切成 ~目标字数的 Chunk,跨页不合并,保留页码与 bbox。
 *  idStart 用于在已有 chunk 之上继续编号(OCR 增量场景)。 */
export function buildChunks(
  bookId: string,
  blocks: TextBlock[],
  source: 'text' | 'ocr' = 'text',
  idStart = 0
): Chunk[] {
  const chunks: Chunk[] = []
  const targetLen = 500 // 目标字符数
  const overlapLen = 80 // 重叠,接续上下文

  let currentSection: string | undefined
  let buffer: TextBlock[] = []
  let bufLen = 0
  let seq = idStart

  const flush = (): void => {
    if (buffer.length === 0) return
    const text = buffer.map((b) => b.text).join('\n').trim()
    if (text.length > 0) {
      chunks.push({
        id: `${bookId}-c${seq++}`,
        bookId,
        text,
        pageNo: buffer[0].pageNo,
        bbox: mergeBlockBBox(buffer),
        section: currentSection,
        source
      })
    }
    // 保留尾部若干块作为重叠
    const keep: TextBlock[] = []
    let keepLen = 0
    for (let i = buffer.length - 1; i >= 0 && keepLen < overlapLen; i--) {
      keep.unshift(buffer[i])
      keepLen += buffer[i].text.length
    }
    buffer = keep
    bufLen = keepLen
  }

  let lastPage = blocks.length ? blocks[0].pageNo : 1
  for (const block of blocks) {
    if (SECTION_RE.test(block.text) && block.text.length < 80) {
      flush()
      buffer = []
      bufLen = 0
      currentSection = block.text
    }
    // 跨页则先 flush,保证 chunk 不横跨页码(便于回跳)
    if (block.pageNo !== lastPage) {
      flush()
      buffer = []
      bufLen = 0
      lastPage = block.pageNo
    }
    buffer.push(block)
    bufLen += block.text.length
    if (bufLen >= targetLen) flush()
  }
  flush()
  return chunks
}

function mergeBlockBBox(blocks: TextBlock[]): BBox {
  const x0 = Math.min(...blocks.map((b) => b.bbox.x))
  const y0 = Math.min(...blocks.map((b) => b.bbox.y))
  const x1 = Math.max(...blocks.map((b) => b.bbox.x + b.bbox.w))
  const y1 = Math.max(...blocks.map((b) => b.bbox.y + b.bbox.h))
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}
