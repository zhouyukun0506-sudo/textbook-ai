// Office 文件(docx/pptx/xlsx) → Markdown 转换器
// 统一转为 Markdown 后复用现有的 Markdown pipeline。

import mammoth from 'mammoth'
import PptxParser from 'node-pptx-parser'
import xlsx from 'xlsx'

/** 支持的 Office 扩展名(小写) */
export const OFFICE_EXTS = new Set(['docx', 'pptx', 'xlsx', 'ppt', 'xls'])

/** 判断文件扩展名是否为支持的 Office 格式 */
export function isOfficeFile(ext: string): boolean {
  return OFFICE_EXTS.has(ext.toLowerCase())
}

/**
 * 将 Office 文件转为 Markdown 文本。
 * - docx: 用 mammoth.convertToMarkdown 提取结构化 Markdown
 * - pptx: 用 node-pptx-parser 按幻灯片提取文本,每页一个 # Slide N 标题
 * - xlsx: 用 xlsx 读取各 sheet,转为 Markdown 表格
 * - ppt/xls(旧格式): xlsx 库可读取 xls; ppt 旧格式暂不支持,返回空文本并抛异常提示
 */
export async function convertOfficeToMarkdown(srcPath: string, ext: string): Promise<string> {
  const lower = ext.toLowerCase()
  switch (lower) {
    case 'docx':
      return convertDocx(srcPath)
    case 'pptx':
      return convertPptx(srcPath)
    case 'ppt':
      throw new Error('旧版 .ppt 格式暂不支持,请转换为 .pptx 后重试。')
    case 'xlsx':
    case 'xls':
      return convertXlsx(srcPath)
    default:
      throw new Error(`不支持的 Office 格式: ${ext}`)
  }
}

/** 判断一行文本是否像标题(短行 + 特定前缀/格式,排除列表项) */
function looksLikeHeading(line: string): boolean {
  const trimmed = line.trim()
  if (trimmed.length === 0 || trimmed.length > 80) return false
  // 排除列表项: 1. xxx  或  - xxx  后面紧跟正文的不算标题
  if (/^\d+\.\s+\S+/.test(trimmed) && trimmed.length > 30) return false
  // 中文章节号: 一、二、 第X章  1.  1.1  Chapter  Section  等
  const headingPatterns = [
    /^[一二三四五六七八九十零百千]+[、\.]/,
    /^第[一二三四五六七八九十零百千\d]+[章节篇部分]/,
    /^\d+\.\d+/,
    /^\d+\s+\S+/, // 纯数字开头+空格+文字,如 "1 引言"
    /^Chapter\s+\d+/i,
    /^Section\s+\d+/i,
    /^Part\s+\d+/i,
    /^Appendix\s+[A-Z\d]/i,
    /^Abstract/i,
    /^Introduction/i,
    /^Conclusion/i,
    /^References?/i,
    /^Bibliography/i,
    /^Acknowledgments?/i,
    /^Preface/i,
    /^Foreword/i,
    /^Table of Contents/i,
    /^Index/i,
    /^Glossary/i,
    /^Exercises?/i,
    /^Problems?/i,
    /^Solutions?/i,
    /^Summary/i,
    /^Overview/i,
    /^Background/i,
    /^Methodology/i,
    /^Results?/i,
    /^Discussion/i,
    /^Future Work/i
  ]
  return headingPatterns.some((re) => re.test(trimmed))
}

/** 提取可能被 HTML 锚点包裹的粗体标题 */
function extractBoldTitle(line: string): string | null {
  // 匹配 <a id="..."></a>__标题__  或  __标题__
  const m = line.trim().match(/^(?:<a\s+id="[^"]*"><\/a>)?__(.+)__$/)
  return m ? m[1].trim() : null
}

/** 启发式后处理:把 mammoth 输出的 __粗体短行__ 等疑似标题转为 Markdown # 标题 */
function postProcessDocxMarkdown(md: string): string {
  const lines = md.split('\n')
  const out: string[] = []
  let prevEmpty = true

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()

    // 1) 整行被 __ 包裹(可能带 HTML 锚点)且看起来像标题 → 转一级标题
    const boldTitle = extractBoldTitle(trimmed)
    if (boldTitle) {
      if (looksLikeHeading(boldTitle) || (prevEmpty && boldTitle.length < 50)) {
        out.push(`# ${boldTitle}`)
        prevEmpty = false
        continue
      }
    }

    // 2) 独立短行(前后空行)看起来像标题 → 转二级标题
    const nextEmpty = i + 1 >= lines.length || lines[i + 1].trim() === ''
    if (looksLikeHeading(trimmed) && trimmed.length < 50 && prevEmpty && nextEmpty) {
      out.push(`## ${trimmed}`)
      prevEmpty = false
      continue
    }

    out.push(line)
    prevEmpty = trimmed === ''
  }

  return out.join('\n')
}

async function convertDocx(srcPath: string): Promise<string> {
  // mammoth 实际支持 convertToMarkdown,但类型声明未包含,用类型断言绕过
  const result = await (mammoth as unknown as { convertToMarkdown: typeof mammoth.convertToHtml }).convertToMarkdown({ path: srcPath })
  // mammoth 的 Markdown 输出可能包含 HTML 残留,做简单清理
  let md = result.value
  // 把多余的空行压缩
  md = md.replace(/\n{3,}/g, '\n\n')
  // 启发式识别标题并转为 Markdown 标题语法
  md = postProcessDocxMarkdown(md)
  return md.trim()
}

async function convertPptx(srcPath: string): Promise<string> {
  const parser = new PptxParser(srcPath)
  const slides = await parser.extractText()
  const parts: string[] = []
  for (const slide of slides) {
    const slideNum = slide.id
    parts.push(`# Slide ${slideNum}`)
    // 过滤掉空段落,保留格式
    const texts = slide.text.map((t) => t.trim()).filter((t) => t.length > 0)
    if (texts.length === 0) {
      parts.push('(无内容)')
    } else {
      parts.push(...texts)
    }
    parts.push('') // 空行分隔
  }
  return parts.join('\n').trim()
}

async function convertXlsx(srcPath: string): Promise<string> {
  const workbook = xlsx.readFile(srcPath)
  const parts: string[] = []

  for (const sheetName of workbook.SheetNames) {
    parts.push(`## Sheet: ${sheetName}`)
    const sheet = workbook.Sheets[sheetName]
    // 读取为二维数组(保留空单元格)
    const data = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: '' }) as unknown[][]
    if (data.length === 0) {
      parts.push('(空表)')
      parts.push('')
      continue
    }

    // 转为 Markdown 表格
    const rows = data.map((row) => {
      const cells = (row as unknown[]).map((c) => String(c ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' '))
      return `| ${cells.join(' | ')} |`
    })

    // 添加表头分隔线(取第一行的列数)
    const colCount = (data[0] as unknown[]).length
    const separator = `| ${Array(colCount).fill('---').join(' | ')} |`

    // 如果只有一行数据,也添加分隔线以符合 Markdown 表格语法
    rows.splice(1, 0, separator)

    parts.push(...rows)
    parts.push('')
  }

  return parts.join('\n').trim()
}
