// 文件名清理:把从网上下载的教材文件名里的无关噪声去掉,得到干净的书名。
// 纯本地、可单测;AI 重命名是在此基础上进一步优化(见 llm.refineBookInfo)。

/** 常见来源站点/分享标记噪声(整词或括注形式出现) */
const NOISE_TOKENS = [
  'z-lib', 'zlib', 'z-library', 'libgen', 'lib gen', 'pdfdrive', 'pdf drive',
  'annas-archive', 'anna archive', 'b-ok', 'bookzz', 'booksee', 'sci-hub',
  'oceanofpdf', 'free download', 'free ebook', 'ebook', 'epub', 'true pdf',
  'retail', 'scan', 'scanned', 'ocr', 'dpi', 'high quality', 'hq',
  'www', 'http', 'https', 'com', 'org', 'net'
]

/**
 * 清理下载来的 PDF 文件名:
 * - 去扩展名
 * - 去掉方括号/圆括号/花括号里的来源标记与噪声(如 [Z-Library]、(PDFDrive))
 * - 下划线/点/多重空格归一为单空格
 * - 去掉站点域名残留、首尾分隔符
 * 保留有意义的信息(书名、版次如 3rd Edition、作者)。
 */
export function cleanFilename(raw: string): string {
  let s = raw.replace(/\.[a-z0-9]{1,5}$/i, '') // 去扩展名

  // 去掉成对括号内"含噪声"的整段(如 [Z-Library]、(z-lib.org)、{libgen});
  // 不含噪声的括注(如 (3rd Edition))予以保留
  s = s.replace(/[[({][^\])}]*[\])}]/g, (m) => {
    const inner = m.slice(1, -1).toLowerCase()
    return NOISE_TOKENS.some((t) => inner.includes(t)) ? ' ' : m
  })

  // 分隔符归一:下划线、点(非小数)、多个空格 → 单空格
  s = s.replace(/[_]+/g, ' ').replace(/\s*\.\s*/g, ' ').replace(/\s{2,}/g, ' ')

  // 短语级噪声(跨词):如 "true pdf"、"free download"、"high quality scan"
  s = s.replace(/\b(true\s+pdf|free\s+(download|ebook)|high\s+quality|scanned?\s+copy|retail\s+pdf)\b/gi, ' ')

  // 按空格分词,剔除纯噪声词(域名后缀、站点名等)
  const cleaned = s
    .split(' ')
    .filter((w) => {
      // 含非 ASCII(中文等)的词一律保留
      if (/[^\x00-\x7f]/.test(w)) return true
      const lw = w.toLowerCase().replace(/[^a-z0-9-]/g, '')
      if (!lw) return false
      return !NOISE_TOKENS.includes(lw)
    })
    .join(' ')

  // 去掉残留的域名片段(如 zlib.io、pdfdrive.com)与首尾标点
  return cleaned
    .replace(/\b[\w-]+\.(com|org|net|io|info)\b/gi, '')
    .replace(/^[\s\-–—_·,.]+|[\s\-–—_·,.]+$/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}
