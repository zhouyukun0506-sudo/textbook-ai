// Markdown 解析引擎:按标题分块、提取大纲、生成检索 Chunk。
// Markdown 无"页"概念,pageNo 复用为"块序号"(从 1 开始),bbox 用占位值。
import type { TextBlock, Chunk, BBox, OutlineNode } from '../shared/types'

const HEADING_RE = /^(#{1,6})\s+(.+)$/

interface Heading {
  level: number
  title: string
  lineIndex: number
}

/** 解析 Markdown 文本,提取标题结构和文本块。 */
export function parseMarkdown(text: string): { blocks: TextBlock[]; headings: Heading[] } {
  const lines = text.split(/\r?\n/)
  const headings: Heading[] = []
  const blocks: TextBlock[] = []
  let currentText: string[] = []
  let blockIdx = 1
  let lastHeadingTitle = ''

  const flushBlock = (text: string): void => {
    const trimmed = text.trim()
    if (!trimmed) return
    blocks.push({
      pageNo: blockIdx++,
      text: trimmed,
      bbox: { x: 0, y: (blockIdx - 1) * 20, w: 0, h: 18 }
    })
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const m = line.match(HEADING_RE)
    if (m) {
      // 遇到标题:先把之前累积的正文 flush 成一个块
      if (currentText.length > 0) {
        flushBlock(currentText.join('\n'))
        currentText = []
      }
      const level = m[1].length
      const title = m[2].trim()
      headings.push({ level, title, lineIndex: i })
      lastHeadingTitle = title
      // 标题本身也作为一个块,便于检索命中
      flushBlock(title)
    } else {
      currentText.push(line)
    }
  }
  // 收尾
  if (currentText.length > 0) {
    flushBlock(currentText.join('\n'))
  }

  return { blocks, headings }
}

/** 把 Markdown 文本块切成 ~500 字的 Chunk,跨块不合并。 */
export function buildMarkdownChunks(bookId: string, blocks: TextBlock[]): Chunk[] {
  const chunks: Chunk[] = []
  const targetLen = 500
  const overlapLen = 80
  let buffer: TextBlock[] = []
  let bufLen = 0
  let seq = 0

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
        source: 'text'
      })
    }
    const keep: TextBlock[] = []
    let keepLen = 0
    for (let i = buffer.length - 1; i >= 0 && keepLen < overlapLen; i--) {
      keep.unshift(buffer[i])
      keepLen += buffer[i].text.length
    }
    buffer = keep
    bufLen = keepLen
  }

  for (const block of blocks) {
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

/** 从 Markdown 标题直接提取 OutlineNode,无需 LLM。 */
export function extractMarkdownOutline(bookId: string, headings: Heading[]): OutlineNode[] {
  if (headings.length === 0) return []
  // 把 # / ## / ### 映射到 level 1/2/3
  const minLevel = Math.min(...headings.map((h) => h.level))
  const normalize = (lvl: number): 1 | 2 | 3 => {
    const rel = lvl - minLevel + 1
    return rel >= 3 ? 3 : (rel as 1 | 2)
  }
  return headings.map((h, i) => ({
    id: `${bookId}-md-o${i}`,
    title: h.title,
    level: normalize(h.level),
    pageNo: h.lineIndex + 1, // 用行号作为"页码",便于跳转定位
    chunkId: undefined
  }))
}
