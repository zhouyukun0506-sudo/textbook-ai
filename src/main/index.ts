import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron'
import { join } from 'path'
import { promises as fs } from 'fs'
import { randomUUID } from 'crypto'
import { IPC } from '../shared/ipc'
import type { Book, ChatTurn, ChatSession, ChatStreamChunk, OutlineNode, OcrPlan, OcrPageResult, TextBlock, WeeklyStats, WidgetConfig, ShelfLayout } from '../shared/types'
import * as store from './store'
import { getPublicConfig, setConfig, testProfile, getActiveProfile } from './config'
import { parsePdf, buildChunks } from './pdf'
import { parseMarkdown, buildMarkdownChunks, extractMarkdownOutline } from './markdown'
import { isOfficeFile, convertOfficeToMarkdown } from './office'
import { retrieve } from './index-service'
import { chat, chatStream, parseThinking, extractCitations, visionOcr, analyzePageImage, extractOutline, translateQuery, refineBookInfo, extractKnowledgePoints, extractKnowledgeFromChunk, mergeAdjacentChunks, type OutlineItem, type KnowledgePoint } from './llm'
import { cleanFilename } from './titles'

let mainWindow: BrowserWindow | null = null

// 已请求取消的书 id:流水线在每个阶段检查,命中则中断且不再写库
const canceled = new Set<string>()

// 每本书当前活跃的聊天会话 id
const activeSessions = new Map<string, string>()

/** 获取或创建该书的活跃会话 */
async function ensureActiveSession(bookId: string): Promise<string> {
  let sid = activeSessions.get(bookId)
  if (!sid) {
    const session = await store.startChatSession(bookId)
    sid = session.id
    activeSessions.set(bookId, sid)
  }
  return sid
}

/** 若该书已被取消则抛出特定错误,用于中断流水线 */
function throwIfCanceled(bookId: string): void {
  if (canceled.has(bookId)) throw new Error('__CANCELED__')
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 1040,
    minHeight: 680,
    show: false,
    title: 'TextbookAI',
    backgroundColor: '#f4f0e8',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function emitProgress(book: Book): void {
  if (canceled.has(book.id)) return // 已取消的书不再向 UI 推送进度
  mainWindow?.webContents.send(IPC.bookProgress, { ...book })
}

/** PDF 导入流水线:拷贝 → 解析 → 判定扫描页 → (交给渲染进程 OCR) → 分块 → 索引。 */
async function runImportPipeline(book: Book, srcPath: string): Promise<void> {
  try {
    throwIfCanceled(book.id)
    book.status = 'parsing'
    book.progress = 8
    book.stage = '解析 PDF'
    await store.upsertBook(book)
    emitProgress(book)

    const data = await fs.readFile(srcPath)
    const { pageCount, blocks, pageKinds, pageSizes } = await parsePdf(
      new Uint8Array(data),
      (done, total) => {
        // 解析占总进度的 8%~32%
        book.progress = 8 + Math.round((done / total) * 24)
        book.stage = `解析 PDF ${done}/${total} 页`
        emitProgress(book)
      }
    )
    throwIfCanceled(book.id)
    book.pageCount = pageCount
    await store.savePageMeta(book.id, { kinds: pageKinds, sizes: pageSizes })

    const scannedCount = pageKinds.filter((k) => k === 'scanned').length
    book.hasScanned = scannedCount > 0

    // 文本页先分块入库
    const textChunks = buildChunks(book.id, blocks, 'text', 0)
    await store.saveChunks(book.id, textChunks)

    if (scannedCount > 0) {
      // 有扫描页:等待渲染进程做 OCR(它能用 canvas 栅格化 + Tesseract.js)
      book.status = 'ocr'
      book.progress = 32
      book.stage = `待 OCR ${scannedCount} 个扫描页`
      await store.upsertBook(book)
      emitProgress(book)
      return // 后续由 submitOcrResults 接力
    }

    if (blocks.length === 0) {
      book.status = 'error'
      book.error = '未能从该 PDF 提取到文本,且未检测到可识别的扫描页。'
      await store.upsertBook(book)
      emitProgress(book)
      return
    }

    await finalizeIndexing(book)
  } catch (err) {
    failBook(book, err)
  }
}

/** Markdown 导入流水线:拷贝 → 读取文本 → 按标题分块 → 索引(无 OCR,秒完成)。 */
async function runMarkdownPipeline(book: Book, srcPath: string): Promise<void> {
  try {
    throwIfCanceled(book.id)
    book.status = 'parsing'
    book.progress = 20
    book.stage = '解析 Markdown'
    await store.upsertBook(book)
    emitProgress(book)

    const text = await fs.readFile(srcPath, 'utf-8')
    throwIfCanceled(book.id)

    const { blocks, headings } = parseMarkdown(text)
    book.pageCount = headings.length || 1
    book.hasScanned = false

    const chunks = buildMarkdownChunks(book.id, blocks)
    await store.saveChunks(book.id, chunks)

    // Markdown 直接从头标题提取大纲,无需 LLM
    const outline = extractMarkdownOutline(book.id, headings)
    if (outline.length > 0) {
      await store.saveOutline(book.id, outline)
    }

    book.progress = 80
    book.stage = '建立索引'
    await store.upsertBook(book)
    emitProgress(book)

    await finalizeIndexing(book)
  } catch (err) {
    failBook(book, err)
  }
}

/** OCR 完成或纯文本书:本地建立检索索引(BM25,无需 API)+ 尽力生成大纲 */
async function finalizeIndexing(book: Book): Promise<void> {
  throwIfCanceled(book.id)
  const cfg = await getPublicConfig()
  const hasKey = cfg.profiles.some((p) => p.hasKey)

  // BM25 检索是纯本地的,解析完即可问答;以下需要对话模型,有 key 才做。
  if (hasKey) {
    // 1) AI 优化书名 + 学科分类(失败不影响后续)
    book.status = 'indexing'
    book.stage = 'AI 优化书名与分类'
    book.progress = 90
    await store.upsertBook(book)
    emitProgress(book)
    // 收集书库已有学科,让 AI 优先匹配用户自定义分类
    const allBooks = await store.listBooks()
    const existingSubjects = Array.from(
      new Set(allBooks.map((b) => b.subject?.trim()).filter((s): s is string => !!s && s !== '未分类'))
    )
    await refineBookMeta(book, existingSubjects)

    // 2) 提炼知识地图
    book.stage = '提炼章节大纲'
    book.progress = 92
    await store.upsertBook(book)
    emitProgress(book)
    try {
      await buildOutline(book.id)
    } catch {
      /* 大纲可后续手动生成,不阻塞问答 */
    }
  }

  book.status = 'ready'
  book.progress = 100
  book.stage = undefined
  book.error = hasKey ? undefined : '已可问答(本地检索)。配置 API Key 后可生成章节大纲并获得更好的中英文检索。'
  if (canceled.has(book.id)) {
    await store.deleteBook(book.id)
    return
  }
  await store.upsertBook(book)
  emitProgress(book)

  // 3) 后台异步拆解知识点(不阻塞 UI,失败静默)
  if (hasKey) {
    void buildKnowledge(book.id)
  }
}

/** 用正文样本让 AI 优化书名 + 判定学科,写回 book(原地修改,失败静默)。
 *  用户已手动改名(customTitle)/改分类(customSubject)的书:保留其自定义值。
 *  existingSubjects: 当前书库中已有的学科列表,AI 优先从中选择。 */
async function refineBookMeta(book: Book, existingSubjects?: string[]): Promise<void> {
  try {
    const chunks = await store.getChunks(book.id)
    if (chunks.length === 0) return
    const sample = chunks.slice(0, 6).map((c) => c.text).join(' ').slice(0, 1500)
    const info = await refineBookInfo(book.originalTitle ?? book.title, sample, existingSubjects)
    if (info) {
      // 自定义书名/分类的书分别跳过对应字段
      if (info.title && !book.customTitle) book.title = info.title
      if (!book.customSubject) book.subject = info.subject || book.subject || '未分类'
    }
  } catch {
    /* 优化失败保留清理后的文件名,不影响导入 */
  }
}

function failBook(book: Book, err: unknown): void {
  // 用户主动取消:不写错误状态,记录已被取消并删除处理留下来的痕迹
  if (canceled.has(book.id) || (err instanceof Error && err.message === '__CANCELED__')) {
    void store.deleteBook(book.id)
    return
  }
  book.status = 'error'
  book.error = err instanceof Error ? err.message : String(err)
  void store.upsertBook(book).then(() => emitProgress(book))
}

/** 拆解全书知识点:map-reduce 分批提取,合并去重后保存。
 *  通过 book.stage 上报进度,UI 可实时看到生成状态。
 *  优化: BATCH 20 + 并发 3 批,大幅提升大文件处理速度。 */
/** 单 chunk 深度拆解流水线。
 *  每个 500 字符的 chunk 独占一次 LLM 调用，不再一批 10 个 chunk 争抢 8192 token。
 *  质量提升核心：一个 chunk 通常只含 1-5 个知识点，每个知识点分到 1000-8000 token 的完整教案空间。
 */
async function buildKnowledge(bookId: string): Promise<void> {
  const book = await store.getBook(bookId)
  if (!book || book.status !== 'ready') return
  // TS 在闭包中无法跟踪非空窄化，创建不可变引用供 worker 使用
  const bookRef = book

  const chunks = await store.getChunks(bookId)
  if (chunks.length === 0) return

  // 过滤无内容 chunk：目录页、纯图表、空白页等
  const validChunks = chunks.filter((c) => c.text.trim().length >= 80)
  if (validChunks.length === 0) {
    bookRef.stage = undefined
    bookRef.error = '未找到有效内容片段，无法拆解知识点'
    emitProgress(bookRef)
    return
  }

  const cfg = await getPublicConfig()
  // 合并相邻 chunk 为超级 chunk：上下文更连贯，请求数更少。
  // 目标从 1500 提到 4500，可把大书的 LLM 请求组数显著压低。
  const superChunks = mergeAdjacentChunks(
    validChunks.map((c) => ({ id: c.id, pageNo: c.pageNo, text: c.text, section: c.section })),
    4500
  )
  // 并发放开：默认 8，上限 15。用户说不用在乎 token 用量，那就榨干 API 吞吐量
  const CONCURRENCY = Math.max(1, Math.min(15, cfg.knowledgeConcurrency ?? 8))
  // 知识拆解专用模型（留空则使用对话模型）
  const knowledgeModel = cfg.knowledgeModel ?? ''

  bookRef.stage = `AI 拆解知识点 0/${superChunks.length} 组`
  emitProgress(bookRef)

  // 直接在 Map 中去重,避免先攒一个大数组再遍历(省一份内存拷贝)
  const seen = new Map<string, KnowledgePoint & { sourceChunkIds: string[] }>()
  const queue = superChunks.map((sc) => ({ ...sc }))
  let completed = 0
  let firstErr: Error | null = null

  async function worker(): Promise<void> {
    while (queue.length > 0) {
      const sc = queue.shift()!
      try {
        const points = await extractKnowledgeFromChunk({
          id: sc.id,
          pageNo: sc.pageNo,
          text: sc.text,
          section: sc.section
        }, knowledgeModel)
        for (const p of points) {
          const item = { ...p, sourceChunkIds: sc.sourceChunkIds }
          const existing = seen.get(p.title)
          if (!existing || item.content.length > existing.content.length) {
            seen.set(p.title, item)
          }
        }
      } catch (e) {
        if (!firstErr) firstErr = e instanceof Error ? e : new Error(String(e))
      }
      completed++
      bookRef.stage = `AI 拆解知识点 ${completed}/${superChunks.length} 组`
      emitProgress(bookRef)
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()))

  // 全部失败才报错
  const errMsg = (firstErr as Error | null)?.message
  if (seen.size === 0 && errMsg) {
    bookRef.stage = undefined
    bookRef.error = `知识点拆解失败: ${errMsg}`
    emitProgress(bookRef)
    return
  }

  const nodes = Array.from(seen.values())
    .sort((a, b) => a.pageNo - b.pageNo)
    .map((p, i) => ({
      id: `${bookId}-k${i}`,
      bookId,
      title: p.title,
      content: p.content,
      pageNo: p.pageNo,
      chunkId: pickKnowledgeChunkId(p, chunks),
      difficulty: p.difficulty,
      category: p.category
    }))

  await store.saveKnowledgeNodes(bookId, nodes)
  bookRef.stage = undefined
  bookRef.error = undefined
  emitProgress(bookRef)
}

function pickKnowledgeChunkId(
  point: KnowledgePoint & { sourceChunkIds?: string[] },
  chunks: Awaited<ReturnType<typeof store.getChunks>>
): string | undefined {
  const sourceIds = point.sourceChunkIds ?? []
  const samePageSource = sourceIds
    .map((id) => chunks.find((c) => c.id === id))
    .find((c) => c && c.pageNo === point.pageNo)
  if (samePageSource) return samePageSource.id

  const firstSource = sourceIds
    .map((id) => chunks.find((c) => c.id === id))
    .find(Boolean)
  if (firstSource) return firstSource.id

  return chunks.find((c) => c.pageNo === point.pageNo)?.id
}

/** 从 chunk 抽样提炼大纲。PDF 用 LLM 通读;Markdown 直接从标题提取(已预存则复用)。 */
async function buildOutline(bookId: string): Promise<OutlineNode[]> {
  const book = await store.getBook(bookId)
  // Markdown 已预存大纲(导入时从头标题提取),直接复用
  if (book?.fileType === 'markdown') {
    const existing = await store.getOutline(bookId)
    if (existing.length > 0) return existing
    // 若预存丢失,从 source.md 重新解析
    const text = await store.readMarkdownData(bookId)
    if (text) {
      const { headings } = parseMarkdown(text)
      const outline = extractMarkdownOutline(bookId, headings)
      if (outline.length > 0) {
        await store.saveOutline(bookId, outline)
        return outline
      }
    }
    return []
  }

  // PDF:用 LLM 通读全书后提炼
  const chunks = await store.getChunks(bookId)
  if (chunks.length === 0) return []

  const byPage = new Map<number, string>()
  for (const c of chunks) {
    byPage.set(c.pageNo, (byPage.get(c.pageNo) ?? '') + ' ' + c.text)
  }
  const pages = [...byPage.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([pageNo, text]) => ({ pageNo, text: text.trim() }))

  const PAGES_PER_BATCH = 5
  const batches: Array<typeof pages> = []
  for (let i = 0; i < pages.length; i += PAGES_PER_BATCH) {
    batches.push(pages.slice(i, i + PAGES_PER_BATCH))
  }

  const all: OutlineItem[] = []
  for (let b = 0; b < batches.length; b++) {
    if (book) {
      book.stage = `提炼知识点 第 ${b + 1}/${batches.length} 批`
      emitProgress(book)
    }
    try {
      const items = await extractOutline(batches[b])
      // 校验:如果该批返回的所有 pageNo 完全相同,说明 AI 没有正确追踪页码,整批丢弃
      const uniquePages = new Set(items.map((i) => i.pageNo))
      if (items.length > 2 && uniquePages.size === 1) {
        console.warn(`[buildOutline] batch ${b + 1} all pageNo=${items[0]?.pageNo}, dropped`)
        continue
      }
      all.push(...items)
    } catch (err) {
      if (b === 0) throw err
    }
  }

  const merged = mergeOutline(all)
  const outline: OutlineNode[] = merged.map((o, i) => {
    const target = chunks.find((c) => c.pageNo >= o.pageNo) ?? chunks[0]
    return {
      id: `${bookId}-o${i}`,
      title: o.title,
      level: o.level,
      pageNo: o.pageNo,
      summary: o.summary,
      chunkId: target?.id
    }
  })
  await store.saveOutline(bookId, outline)
  return outline
}

/** 合并多批结果:按页码排序,去掉跨批重复的同名章节标题,保持层级顺序稳定。 */
function mergeOutline(items: OutlineItem[]): OutlineItem[] {
  const sorted = [...items].sort((a, b) => a.pageNo - b.pageNo || a.level - b.level)
  const seen = new Set<string>()
  const out: OutlineItem[] = []
  for (const it of sorted) {
    // 章/节:同名只保留首次(避免相邻批边界把同一标题各报一次);知识点保留全部细节
    const key = `${it.level}|${normalizeTitle(it.title)}`
    if (it.level !== 3 && seen.has(key)) continue
    seen.add(key)
    out.push(it)
  }
  return out
}

function normalizeTitle(t: string): string {
  return t.toLowerCase().replace(/\s+/g, '').replace(/[第章节.、:：()()]/g, '')
}

function registerIpc(): void {
  ipcMain.handle(IPC.listBooks, () => store.listBooks())

  ipcMain.handle(IPC.importFile, async (): Promise<Book | null> => {
    const result = await dialog.showOpenDialog({
      title: '选择教材文件',
      properties: ['openFile'],
      filters: [
        { name: '教材文件', extensions: ['pdf', 'md', 'docx', 'pptx', 'xlsx', 'ppt', 'xls'] },
        { name: 'PDF', extensions: ['pdf'] },
        { name: 'Office', extensions: ['docx', 'pptx', 'xlsx', 'ppt', 'xls'] },
        { name: 'Markdown', extensions: ['md'] }
      ]
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const srcPath = result.filePaths[0]
    const id = randomUUID()
    const ext = srcPath.split(/[\\/]/).pop()?.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase() ?? 'pdf'
    const rawName = srcPath.split(/[\\/]/).pop()?.replace(/\.[a-z0-9]+$/i, '') ?? '未命名教材'
    const cleaned = cleanFilename(rawName) || rawName
    const isMarkdown = ext === 'md'
    const isOffice = isOfficeFile(ext)

    const book: Book = {
      id,
      title: cleaned,
      originalTitle: rawName,
      filePath: srcPath,
      fileType: isMarkdown || isOffice ? 'markdown' : 'pdf',
      pageCount: 0,
      status: 'importing',
      srcLang: 'en',
      createdAt: Date.now(),
      progress: 0
    }
    await store.upsertBook(book)

    let savedPath: string
    if (isOffice) {
      // Office 文件先转为 Markdown,再保存副本
      const mdText = await convertOfficeToMarkdown(srcPath, ext)
      savedPath = await store.saveMarkdownCopy(id, srcPath, mdText)
    } else if (isMarkdown) {
      savedPath = await store.saveMarkdownCopy(id, srcPath)
    } else {
      savedPath = await store.savePdfCopy(id, srcPath)
    }
    book.filePath = savedPath
    await store.upsertBook(book)

    if (isMarkdown || isOffice) {
      void runMarkdownPipeline(book, savedPath)
    } else {
      void runImportPipeline(book, savedPath)
    }
    return book
  })

  ipcMain.handle(IPC.deleteBook, (_e, bookId: string) => store.deleteBook(bookId))
  ipcMain.handle(IPC.renameBook, async (_e, bookId: string, title: string): Promise<Book | null> => {
    const trimmed = title.trim()
    if (!trimmed) return null
    const book = await store.getBook(bookId)
    if (!book) return null
    book.title = trimmed
    book.customTitle = true // 标记为自定义,AI 整理时跳过改名
    await store.upsertBook(book)
    emitProgress(book)
    return book
  })
  ipcMain.handle(IPC.renameSubject, async (_e, from: string, to: string): Promise<Book[]> => {
    const target = to.trim()
    if (!target) return store.listBooks()
    const books = await store.listBooks()
    let changed = false
    for (const book of books) {
      const subj = book.subject?.trim() || '未分类'
      if (subj !== from) continue
      book.subject = target
      book.customSubject = true // 标记为自定义分类,AI 整理时不再重新归类
      await store.upsertBook(book)
      changed = true
    }
    if (changed) {
      // 统一刷新:避免逐本 emitProgress 与最终返回值之间的竞态
      const updated = await store.listBooks()
      for (const b of updated) {
        const subj = b.subject?.trim() || '未分类'
        if (subj === target) emitProgress(b)
      }
      return updated
    }
    return store.listBooks()
  })
  ipcMain.handle(IPC.cancelImport, async (_e, bookId: string) => {
    // 标记取消:流水线下个检查点会中断;立即删除记录与已落地的数据
    canceled.add(bookId)
    await store.deleteBook(bookId)
    // 稍后清理标记,避免无界增长(此时流水线早已中断)
    setTimeout(() => canceled.delete(bookId), 60_000)
  })
  ipcMain.handle(IPC.rebuildIndex, async (_e, bookId: string) => {
    const book = await store.getBook(bookId)
    if (!book) return
    // 删除旧索引数据
    await store.deleteChunks(bookId)
    await store.deleteOutline(bookId)
    await store.deleteKnowledgeNodes(bookId)
    // 重置书状态
    book.status = 'importing'
    book.progress = 0
    book.stage = '重新建立索引'
    book.error = undefined
    await store.upsertBook(book)
    emitProgress(book)
    // 根据文件类型重新跑 pipeline
    const srcPath = book.filePath
    if (book.fileType === 'markdown') {
      void runMarkdownPipeline(book, srcPath)
    } else {
      void runImportPipeline(book, srcPath)
    }
  })
  ipcMain.handle(IPC.organizeLibrary, () => organizeLibrary())
  ipcMain.handle(IPC.getBookChunks, (_e, bookId: string) => store.getChunks(bookId))

  ipcMain.handle(IPC.readPdfData, async (_e, bookId: string) => {
    const buf = await store.readPdfData(bookId)
    if (!buf) return null
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  })

  ipcMain.handle(IPC.readMarkdownData, async (_e, bookId: string) => store.readMarkdownData(bookId))

  function friendlyError(msg: string): string {
    if (msg.includes('NO_API_KEY')) return '尚未配置 API Key,请到设置中填写。'
    const m = msg.match(/(?:OPENAI_FAILED|ANTHROPIC_FAILED|CHAT_FAILED|VISION_FAILED|OUTLINE_FAILED):(\d+):([\s\S]*)/)
    if (m) {
      const status = m[1]
      const detail = m[2].trim()
      return `调用模型失败(HTTP ${status})。${detail}`
    }
    return `出错了:${msg}`
  }

  ipcMain.handle(IPC.ask, async (_e, bookId: string, question: string, mode: 'ask' | 'learn'): Promise<ChatTurn> => {
    // 中文问题先转英文检索词(只用对话接口),与原问题一起做 BM25 检索
    const enQuery = await translateQuery(question)
    const queries = enQuery ? [question, enQuery] : [question]
    // 学习模式要系统讲解,召回更多片段;提问模式聚焦
    const topK = mode === 'learn' ? 12 : 8
    const contextChunks = await retrieve(bookId, queries, topK)
    const { answer, citations, thinking } = await chat(question, contextChunks, mode)
    const turn: ChatTurn = {
      id: randomUUID(),
      bookId,
      sessionId: await ensureActiveSession(bookId),
      mode,
      question,
      thinking,
      answer,
      citations,
      createdAt: Date.now()
    }
    await store.appendChat(turn)
    return turn
  })

  // 流式问答:立即返回 turnId,内容通过 chat:streamChunk 事件推送
  ipcMain.handle(IPC.askStream, async (event, bookId: string, question: string, mode: 'ask' | 'learn'): Promise<string> => {
    const turnId = randomUUID()
    const sender = event.sender

    // 启动异步流式任务(不阻塞返回 turnId)
    void (async (): Promise<void> => {
      try {
        sender.send(IPC.chatStream, { type: 'stage', stage: 'retrieving' })

        const enQuery = await translateQuery(question)
        const queries = enQuery ? [question, enQuery] : [question]
        const topK = mode === 'learn' ? 12 : 8
        const contextChunks = await retrieve(bookId, queries, topK)

        sender.send(IPC.chatStream, { type: 'stage', stage: 'thinking' })

        // 用数组累积避免 O(n²) 字符串拼接,长流式回答性能大幅提升
        const thinkingParts: string[] = []
        const answerParts: string[] = []
        const stream = chatStream(question, contextChunks, mode)
        for await (const chunk of stream) {
          if (chunk.type === 'thinking') {
            thinkingParts.push(chunk.content)
            sender.send(IPC.chatStream, { type: 'thinking', content: chunk.content })
          } else {
            answerParts.push(chunk.content)
            sender.send(IPC.chatStream, { type: 'answer', content: chunk.content })
          }
        }
        const fullThinking = thinkingParts.join('')
        const fullAnswer = answerParts.join('')

        sender.send(IPC.chatStream, { type: 'stage', stage: 'answering' })

        // 如果流式中没分出 thinking(模型不支持原生 reasoning),再尝试从 answer 内容解析
        const { thinking: parsedThinking, answer: parsedAnswer } = fullThinking
          ? { thinking: undefined, answer: fullAnswer }
          : parseThinking(fullAnswer)
        const finalThinking = fullThinking || parsedThinking
        const finalAnswer = fullThinking ? fullAnswer : parsedAnswer

        const citations = extractCitations(finalAnswer, contextChunks)
        sender.send(IPC.chatStream, { type: 'citations', citations })

        const turn: ChatTurn = {
          id: turnId,
          bookId,
          sessionId: await ensureActiveSession(bookId),
          mode,
          question,
          thinking: finalThinking || undefined,
          answer: finalAnswer,
          citations,
          createdAt: Date.now()
        }
        await store.appendChat(turn)
        sender.send(IPC.chatStream, { type: 'done', turn })
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        sender.send(IPC.chatStream, { type: 'error', message: friendlyError(msg) })
      }
    })()

    return turnId
  })

  ipcMain.handle(IPC.askPageImage, async (_e, bookId: string, pageNo: number, pngDataUrl: string, prompt?: string): Promise<ChatTurn> => {
    const question = prompt?.trim() || `请分析当前 PDF 第 ${pageNo} 页截图`
    const answer = await analyzePageImage(pngDataUrl, pageNo, question)
    const turn: ChatTurn = {
      id: randomUUID(),
      bookId,
      sessionId: await ensureActiveSession(bookId),
      mode: 'ask',
      question: `📷 第 ${pageNo} 页截图: ${question}`,
      image: { pageNo, dataUrl: pngDataUrl },
      answer,
      citations: [],
      createdAt: Date.now()
    }
    await store.appendChat(turn)
    return turn
  })

  ipcMain.handle(IPC.listChats, async (_e, bookId: string) => {
    const sid = activeSessions.get(bookId)
    return store.listChats(bookId, sid)
  })

  // ---- 大纲 ----
  ipcMain.handle(IPC.getOutline, async (_e, bookId: string) => {
    const existing = await store.getOutline(bookId)
    if (existing.length > 0) return existing
    // Markdown 未预存大纲时本地提取;PDF 由 buildOutline 走 LLM
    const book = await store.getBook(bookId)
    if (book?.fileType === 'markdown') {
      const text = await store.readMarkdownData(bookId)
      if (text) {
        const { headings } = parseMarkdown(text)
        const outline = extractMarkdownOutline(bookId, headings)
        if (outline.length > 0) {
          await store.saveOutline(bookId, outline)
          return outline
        }
      }
    }
    return []
  })
  ipcMain.handle(IPC.generateOutline, (_e, bookId: string) => buildOutline(bookId))

  // ---- 知识点拆解 ----
  ipcMain.handle(IPC.knowledgeGet, async (_e, bookId: string) => store.getKnowledgeNodes(bookId))
  ipcMain.handle(IPC.knowledgeGenerate, async (_e, bookId: string) => {
    await buildKnowledge(bookId)
    return store.getKnowledgeNodes(bookId)
  })
  ipcMain.handle(IPC.knowledgeClear, async (_e, bookId: string) => {
    await store.deleteKnowledgeNodes(bookId)
    const book = await store.getBook(bookId)
    if (book) {
      book.stage = undefined
      book.error = undefined
      await store.upsertBook(book)
      emitProgress(book)
    }
  })

  // ---- OCR 协作 ----
  ipcMain.handle(IPC.getOcrPlan, async (_e, bookId: string): Promise<OcrPlan> => {
    const meta = await store.getPageMeta(bookId)
    const active = await getActiveProfile()
    const pageNos: number[] = []
    meta.kinds.forEach((k, i) => {
      if (k === 'scanned') pageNos.push(i + 1)
    })
    return { pageNos, mode: active?.ocrMode ?? 'hybrid' }
  })

  ipcMain.handle(IPC.ocrPageCloud, async (_e, _bookId: string, _pageNo: number, pngDataUrl: string): Promise<TextBlock[]> => {
    const text = await visionOcr(pngDataUrl)
    const lines = text.split(/\n+/).filter((l) => l.trim())
    if (lines.length === 0) return []

    // 尝试获取页面尺寸,使坐标分布更合理(按行均匀分布)
    let pageHeight = 1100
    try {
      const meta = await store.getPageMeta(_bookId)
      const size = meta.sizes[_pageNo - 1]
      if (size?.height) pageHeight = size.height
    } catch {
      // 忽略获取尺寸失败,用默认值
    }

    const lineHeight = Math.max(14, Math.min(24, pageHeight / Math.max(lines.length, 1)))
    const topMargin = pageHeight * 0.06
    return lines.map((line, i) => ({
      pageNo: _pageNo,
      text: line.trim(),
      bbox: {
        x: pageHeight * 0.05,
        y: topMargin + i * lineHeight,
        w: pageHeight * 0.9,
        h: lineHeight
      }
    }))
  })

  ipcMain.handle(IPC.submitOcrResults, async (_e, bookId: string, pages: OcrPageResult[]): Promise<void> => {
    if (canceled.has(bookId)) return
    const book = await store.getBook(bookId)
    if (!book) return
    try {
      const existing = await store.getChunks(bookId)
      // OCR 出来的文本块汇总后分块,编号接在已有 chunk 之后
      const ocrBlocks: TextBlock[] = []
      for (const p of pages) ocrBlocks.push(...p.blocks)
      ocrBlocks.sort((a, b) => a.pageNo - b.pageNo || a.bbox.y - b.bbox.y)
      const ocrChunks = buildChunks(bookId, ocrBlocks, 'ocr', existing.length)
      await store.saveChunks(bookId, [...existing, ...ocrChunks])
      book.stage = 'OCR 完成,建立索引'
      book.progress = 45
      await store.upsertBook(book)
      emitProgress(book)
      await finalizeIndexing(book)
    } catch (err) {
      failBook(book, err)
    }
  })

  ipcMain.handle(IPC.getApiConfig, () => getPublicConfig())
  ipcMain.handle(IPC.setApiConfig, async (_e, cfg) => {
    const result = await setConfig(cfg)
    void backfillIndexing()
    return result
  })
  ipcMain.handle(IPC.testProfile, async (_e, profile) => testProfile(profile))

  // ---- 研读周报 ----
  ipcMain.handle(IPC.getWeeklyStats, () => store.getWeeklyStats())
  ipcMain.handle(IPC.addReadingTime, (_e, seconds: number) => store.addReadingTime(seconds))
  ipcMain.handle(IPC.incrementChatCount, () => store.incrementChatCount())
  ipcMain.handle(IPC.incrementKnowledgeCount, () => store.incrementKnowledgeCount())

  // ---- 聊天会话 ----
  ipcMain.handle(IPC.listChatSessions, (_e, bookId: string) => store.listChatSessions(bookId))
  ipcMain.handle(IPC.startChatSession, async (_e, bookId: string, title?: string) => {
    const session = await store.startChatSession(bookId, title)
    activeSessions.set(bookId, session.id)
    return session
  })
  ipcMain.handle(IPC.setActiveSession, (_e, bookId: string, sessionId: string) => {
    activeSessions.set(bookId, sessionId)
  })
  ipcMain.handle(IPC.deleteChatSession, async (_e, bookId: string, sessionId: string) => {
    await store.deleteChatSession(bookId, sessionId)
    if (activeSessions.get(bookId) === sessionId) {
      activeSessions.delete(bookId)
    }
  })

  // ---- 小组件系统 ----
  ipcMain.handle(IPC.getWidgets, () => store.getWidgets())
  ipcMain.handle(IPC.saveWidgets, (_e, widgets: WidgetConfig[]) => store.saveWidgets(widgets))

  // ---- 书架布局 ----
  ipcMain.handle(IPC.getShelfLayout, () => store.getShelfLayout())
  ipcMain.handle(IPC.saveShelfLayout, (_e, layout: ShelfLayout[]) => store.saveShelfLayout(layout))
  ipcMain.handle(IPC.updateBookSubject, async (_e, bookId: string, subject: string) => {
    await store.updateBookSubject(bookId, subject)
    // 触发刷新
    const book = await store.getBook(bookId)
    if (book) emitProgress(book)
  })

  // ---- 自定义(可空)书架 ----
  ipcMain.handle(IPC.getCustomShelves, () => store.getCustomShelves())
  ipcMain.handle(IPC.saveCustomShelves, (_e, shelves: string[]) => store.saveCustomShelves(shelves))
}

/** 一键整理书架:逐本用 AI 优化书名 + 学科分类(仅处理已就绪的书)。返回更新后的列表。 */
async function organizeLibrary(): Promise<Book[]> {
  const cfg = await getPublicConfig()
  const hasKey = cfg.profiles.some((p) => p.hasKey)
  if (!hasKey) throw new Error('NO_API_KEY')
  const books = await store.listBooks()
  // 收集用户已有的学科分类,供 AI 优先选择
  const existingSubjects = Array.from(
    new Set(books.map((b) => b.subject?.trim()).filter((s): s is string => !!s && s !== '未分类'))
  )
  const targets = books.filter((b) => b.status === 'ready')
  for (const book of targets) {
    book.stage = 'AI 整理中…'
    emitProgress(book)
    await refineBookMeta(book, existingSubjects)
    book.stage = undefined
    await store.upsertBook(book)
    emitProgress(book)
  }
  return store.listBooks()
}
async function backfillIndexing(): Promise<void> {
  const cfg = await getPublicConfig()
  const hasKey = cfg.profiles.some((p) => p.hasKey)
  if (!hasKey) return
  const books = await store.listBooks()
  for (const book of books) {
    if (book.status !== 'ready') continue
    const chunks = await store.getChunks(book.id)
    if (chunks.length === 0) continue
    const outline = await store.getOutline(book.id)
    if (outline.length > 0) continue // 已有大纲则跳过
    try {
      await buildOutline(book.id)
      // 清掉"未配置 key"的提示
      if (book.error) {
        book.error = undefined
        await store.upsertBook(book)
        emitProgress(book)
      }
    } catch {
      /* 大纲生成失败不影响问答 */
    }
  }
}

app.whenReady().then(() => {
  registerIpc()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
