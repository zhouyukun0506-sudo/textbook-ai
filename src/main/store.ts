// 本地 JSON 存储:书库元数据、分块、对话记录
// 放在 app.getPath('userData') 下,卸载随之清除,数据本地优先
import { app } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import type { Book, Chunk, ChatTurn, ChatSession, OutlineNode, PageKind, KnowledgeNode, WeeklyStats, WidgetConfig, ShelfLayout } from '../shared/types'

function dataDir(): string {
  return join(app.getPath('userData'), 'data')
}
function booksFile(): string {
  return join(dataDir(), 'books.json')
}
function bookDir(bookId: string): string {
  return join(dataDir(), 'books', bookId)
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true })
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(file, 'utf-8')
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

async function writeJson(file: string, data: unknown): Promise<void> {
  await ensureDir(join(file, '..'))
  // 先写临时文件再重命名,避免写入中途崩溃损坏数据
  const tmp = `${file}.tmp`
  await fs.writeFile(tmp, JSON.stringify(data), 'utf-8')
  await fs.rename(tmp, file)
}

// ---- 书库 ----
export async function listBooks(): Promise<Book[]> {
  const books = await readJson<Book[]>(booksFile(), [])
  return books.sort((a, b) => b.createdAt - a.createdAt)
}

export async function getBook(bookId: string): Promise<Book | undefined> {
  const books = await listBooks()
  return books.find((b) => b.id === bookId)
}

export async function upsertBook(book: Book): Promise<void> {
  const books = await readJson<Book[]>(booksFile(), [])
  const idx = books.findIndex((b) => b.id === book.id)
  if (idx >= 0) books[idx] = book
  else books.push(book)
  await writeJson(booksFile(), books)
}

export async function deleteBook(bookId: string): Promise<void> {
  const books = await readJson<Book[]>(booksFile(), [])
  await writeJson(
    booksFile(),
    books.filter((b) => b.id !== bookId)
  )
  await fs.rm(bookDir(bookId), { recursive: true, force: true })
}

// ---- 分块 ----
export async function saveChunks(bookId: string, chunks: Chunk[]): Promise<void> {
  await writeJson(join(bookDir(bookId), 'chunks.json'), chunks)
}

export async function getChunks(bookId: string): Promise<Chunk[]> {
  return readJson<Chunk[]>(join(bookDir(bookId), 'chunks.json'), [])
}

// ---- 页面类型/尺寸(供 OCR 与坐标对齐使用) ----
export interface PageMeta {
  kinds: PageKind[]
  sizes: Array<{ width: number; height: number }>
}

export async function savePageMeta(bookId: string, meta: PageMeta): Promise<void> {
  await writeJson(join(bookDir(bookId), 'pages.json'), meta)
}

export async function getPageMeta(bookId: string): Promise<PageMeta> {
  return readJson<PageMeta>(join(bookDir(bookId), 'pages.json'), { kinds: [], sizes: [] })
}

// ---- 大纲 ----
export async function saveOutline(bookId: string, outline: OutlineNode[]): Promise<void> {
  await writeJson(join(bookDir(bookId), 'outline.json'), outline)
}

export async function deleteChunks(bookId: string): Promise<void> {
  try { await fs.unlink(join(bookDir(bookId), 'chunks.json')) } catch { /* ignore */ }
}

export async function deleteOutline(bookId: string): Promise<void> {
  try { await fs.unlink(join(bookDir(bookId), 'outline.json')) } catch { /* ignore */ }
}

export async function getOutline(bookId: string): Promise<OutlineNode[]> {
  return readJson<OutlineNode[]>(join(bookDir(bookId), 'outline.json'), [])
}

// ---- 原始 PDF 拷贝 ----
export async function savePdfCopy(bookId: string, srcPath: string): Promise<string> {
  await ensureDir(bookDir(bookId))
  const dest = join(bookDir(bookId), 'source.pdf')
  await fs.copyFile(srcPath, dest)
  return dest
}

export async function readPdfData(bookId: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(join(bookDir(bookId), 'source.pdf'))
  } catch {
    return null
  }
}

// ---- Markdown 拷贝 ----
export async function saveMarkdownCopy(bookId: string, srcPath: string, mdText?: string): Promise<string> {
  await ensureDir(bookDir(bookId))
  const dest = join(bookDir(bookId), 'source.md')
  if (mdText !== undefined) {
    await fs.writeFile(dest, mdText, 'utf-8')
  } else {
    await fs.copyFile(srcPath, dest)
  }
  return dest
}

export async function readMarkdownData(bookId: string): Promise<string | null> {
  try {
    return await fs.readFile(join(bookDir(bookId), 'source.md'), 'utf-8')
  } catch {
    return null
  }
}

// ---- 对话 ----
export async function appendChat(turn: ChatTurn): Promise<void> {
  const file = join(bookDir(turn.bookId), 'chats.json')
  const chats = await readJson<ChatTurn[]>(file, [])
  chats.push(turn)
  await writeJson(file, chats)
}

export async function listChats(bookId: string, sessionId?: string): Promise<ChatTurn[]> {
  const all = await readJson<ChatTurn[]>(join(bookDir(bookId), 'chats.json'), [])
  if (!sessionId) return all
  return all.filter((t) => t.sessionId === sessionId)
}

// ---- 知识点拆解 ----
export async function saveKnowledgeNodes(bookId: string, nodes: KnowledgeNode[]): Promise<void> {
  await writeJson(join(bookDir(bookId), 'knowledge.json'), nodes)
}

export async function getKnowledgeNodes(bookId: string): Promise<KnowledgeNode[]> {
  return readJson<KnowledgeNode[]>(join(bookDir(bookId), 'knowledge.json'), [])
}

export async function deleteKnowledgeNodes(bookId: string): Promise<void> {
  try {
    await fs.unlink(join(bookDir(bookId), 'knowledge.json'))
  } catch {
    // 文件不存在则忽略
  }
}

// ---- 研读周报统计 ----
function statsFile(): string {
  return join(dataDir(), 'stats.json')
}

function getWeekStart(ts: number): number {
  const d = new Date(ts)
  const day = d.getDay() || 7 // 周日转为 7
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() - day + 1) // 回到本周一
  return d.getTime()
}

export async function getWeeklyStats(): Promise<WeeklyStats[]> {
  return readJson<WeeklyStats[]>(statsFile(), [])
}

export async function saveWeeklyStats(stats: WeeklyStats[]): Promise<void> {
  await writeJson(statsFile(), stats)
}

export async function addReadingTime(seconds: number): Promise<WeeklyStats[]> {
  const stats = await getWeeklyStats()
  const weekStart = getWeekStart(Date.now())
  let week = stats.find((s) => s.weekStart === weekStart)
  if (!week) {
    week = { weekStart, totalSeconds: 0, dailySeconds: {}, chatCount: 0, knowledgeCount: 0 }
    stats.push(week)
  }
  week.totalSeconds += Math.max(0, seconds)
  if (!week.dailySeconds) week.dailySeconds = {}
  const dateStr = new Date().toISOString().slice(0, 10)
  week.dailySeconds[dateStr] = (week.dailySeconds[dateStr] || 0) + Math.max(0, seconds)
  // 只保留最近 12 周的数据(给热力图留足历史)
  const cutoff = weekStart - 12 * 7 * 24 * 60 * 60 * 1000
  const trimmed = stats.filter((s) => s.weekStart >= cutoff)
  await saveWeeklyStats(trimmed)
  return trimmed
}

export async function incrementChatCount(): Promise<void> {
  const stats = await getWeeklyStats()
  const weekStart = getWeekStart(Date.now())
  let week = stats.find((s) => s.weekStart === weekStart)
  if (!week) {
    week = { weekStart, totalSeconds: 0, chatCount: 0, knowledgeCount: 0 }
    stats.push(week)
  }
  week.chatCount++
  await saveWeeklyStats(stats)
}

export async function incrementKnowledgeCount(): Promise<void> {
  const stats = await getWeeklyStats()
  const weekStart = getWeekStart(Date.now())
  let week = stats.find((s) => s.weekStart === weekStart)
  if (!week) {
    week = { weekStart, totalSeconds: 0, chatCount: 0, knowledgeCount: 0 }
    stats.push(week)
  }
  week.knowledgeCount++
  await saveWeeklyStats(stats)
}

// ---- 聊天会话 ----
function sessionsFile(): string {
  return join(dataDir(), 'sessions.json')
}

export async function listChatSessions(bookId: string): Promise<ChatSession[]> {
  const map = await readJson<Record<string, ChatSession[]>>(sessionsFile(), {})
  const list = map[bookId] || []
  return list.sort((a, b) => b.createdAt - a.createdAt)
}

export async function saveChatSessions(bookId: string, sessions: ChatSession[]): Promise<void> {
  const map = await readJson<Record<string, ChatSession[]>>(sessionsFile(), {})
  map[bookId] = sessions
  await writeJson(sessionsFile(), map)
}

export async function startChatSession(bookId: string, title?: string): Promise<ChatSession> {
  const sessions = await listChatSessions(bookId)
  const session: ChatSession = {
    id: `s-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    bookId,
    title: title?.trim() || '新对话',
    createdAt: Date.now()
  }
  sessions.unshift(session)
  await saveChatSessions(bookId, sessions)
  return session
}

export async function deleteChatSession(bookId: string, sessionId: string): Promise<void> {
  const sessions = await listChatSessions(bookId)
  await saveChatSessions(bookId, sessions.filter((s) => s.id !== sessionId))
  // 同时删除该会话下的聊天记录
  const chats = await readJson<ChatTurn[]>(join(bookDir(bookId), 'chats.json'), [])
  await writeJson(join(bookDir(bookId), 'chats.json'), chats.filter((c) => c.sessionId !== sessionId))
}

// ---- 小组件配置 ----
function widgetsFile(): string {
  return join(dataDir(), 'widgets.json')
}

export async function getWidgets(): Promise<WidgetConfig[]> {
  return readJson<WidgetConfig[]>(widgetsFile(), [
    { id: 'w-weekly', type: 'weekly', width: 360, height: 210, x: 20, y: 20 },
    { id: 'w-pomodoro', type: 'pomodoro', width: 260, height: 210, x: 400, y: 20 },
    { id: 'w-streak', type: 'streak', width: 240, height: 210, x: 680, y: 20 }
  ])
}

export async function saveWidgets(widgets: WidgetConfig[]): Promise<void> {
  await writeJson(widgetsFile(), widgets)
}

// ---- 书架布局 ----
function layoutFile(): string {
  return join(dataDir(), 'layout.json')
}

export async function getShelfLayout(): Promise<ShelfLayout[]> {
  return readJson<ShelfLayout[]>(layoutFile(), [])
}

export async function saveShelfLayout(layout: ShelfLayout[]): Promise<void> {
  await writeJson(layoutFile(), layout)
}

// ---- 自定义(可空)书架名单 ----
// 书架本来从书的 subject 派生,没有书的分类不会显示。这里单独存一份用户手动建的
// 空书架名,让它即使没书也展示出来,作为「拖错书时把书拖回来重新归类」的落脚点。
function customShelvesFile(): string {
  return join(dataDir(), 'customShelves.json')
}

export async function getCustomShelves(): Promise<string[]> {
  return readJson<string[]>(customShelvesFile(), [])
}

export async function saveCustomShelves(shelves: string[]): Promise<void> {
  // 去重 + 去空白,保持稳定顺序
  const seen = new Set<string>()
  const cleaned: string[] = []
  for (const s of shelves) {
    const t = s.trim()
    if (!t || seen.has(t)) continue
    seen.add(t)
    cleaned.push(t)
  }
  await writeJson(customShelvesFile(), cleaned)
}

/** 更新单本书的学科分类 */
export async function updateBookSubject(bookId: string, subject: string): Promise<void> {
  const books = await readJson<Book[]>(booksFile(), [])
  const idx = books.findIndex((b) => b.id === bookId)
  if (idx >= 0) {
    books[idx] = { ...books[idx], subject, customSubject: true }
    await writeJson(booksFile(), books)
  }
}
