import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc'
import type { ExposedApi, Book, ChatStreamChunk, WeeklyStats, WidgetConfig, ShelfOrder } from '../shared/types'

const api: ExposedApi = {
  listBooks: () => ipcRenderer.invoke(IPC.listBooks),
  importFile: () => ipcRenderer.invoke(IPC.importFile),
  deleteBook: (bookId) => ipcRenderer.invoke(IPC.deleteBook, bookId),
  cancelImport: (bookId) => ipcRenderer.invoke(IPC.cancelImport, bookId),
  rebuildIndex: (bookId) => ipcRenderer.invoke(IPC.rebuildIndex, bookId),
  renameBook: (bookId, title) => ipcRenderer.invoke(IPC.renameBook, bookId, title),
  renameSubject: (from, to) => ipcRenderer.invoke(IPC.renameSubject, from, to),
  organizeLibrary: () => ipcRenderer.invoke(IPC.organizeLibrary),
  getBookChunks: (bookId) => ipcRenderer.invoke(IPC.getBookChunks, bookId),
  readPdfData: async (bookId) => {
    const buf: ArrayBuffer | null = await ipcRenderer.invoke(IPC.readPdfData, bookId)
    return buf ? new Uint8Array(buf) : null
  },
  readMarkdownData: (bookId) => ipcRenderer.invoke(IPC.readMarkdownData, bookId),
  ask: (bookId, question, mode) => ipcRenderer.invoke(IPC.ask, bookId, question, mode),
  askStream: (bookId, question, mode) => ipcRenderer.invoke(IPC.askStream, bookId, question, mode),
  askPageImage: (bookId, pageNo, pngDataUrl, prompt) =>
    ipcRenderer.invoke(IPC.askPageImage, bookId, pageNo, pngDataUrl, prompt),
  listChats: (bookId) => ipcRenderer.invoke(IPC.listChats, bookId),

  getOutline: (bookId) => ipcRenderer.invoke(IPC.getOutline, bookId),
  generateOutline: (bookId) => ipcRenderer.invoke(IPC.generateOutline, bookId),

  getOcrPlan: (bookId) => ipcRenderer.invoke(IPC.getOcrPlan, bookId),
  ocrPageCloud: (bookId, pageNo, pngDataUrl) =>
    ipcRenderer.invoke(IPC.ocrPageCloud, bookId, pageNo, pngDataUrl),
  submitOcrResults: (bookId, pages) => ipcRenderer.invoke(IPC.submitOcrResults, bookId, pages),

  getApiConfig: () => ipcRenderer.invoke(IPC.getApiConfig),
  setApiConfig: (cfg) => ipcRenderer.invoke(IPC.setApiConfig, cfg),
  testProfile: (profile) => ipcRenderer.invoke(IPC.testProfile, profile),
  getKnowledgeNodes: (bookId: string) => ipcRenderer.invoke(IPC.knowledgeGet, bookId),
  generateKnowledge: (bookId: string) => ipcRenderer.invoke(IPC.knowledgeGenerate, bookId),
  clearKnowledge: (bookId: string) => ipcRenderer.invoke(IPC.knowledgeClear, bookId),
  onBookProgress: (cb) => {
    const listener = (_e: unknown, book: Book): void => cb(book)
    ipcRenderer.on(IPC.bookProgress, listener)
    return () => ipcRenderer.removeListener(IPC.bookProgress, listener)
  },
  onChatStream: (cb) => {
    const listener = (_e: unknown, chunk: ChatStreamChunk): void => cb(chunk)
    ipcRenderer.on(IPC.chatStream, listener)
    return () => ipcRenderer.removeListener(IPC.chatStream, listener)
  },

  getWeeklyStats: () => ipcRenderer.invoke(IPC.getWeeklyStats),
  addReadingTime: (seconds: number) => ipcRenderer.invoke(IPC.addReadingTime, seconds),
  incrementChatCount: () => ipcRenderer.invoke(IPC.incrementChatCount),
  incrementKnowledgeCount: () => ipcRenderer.invoke(IPC.incrementKnowledgeCount),

  listChatSessions: (bookId: string) => ipcRenderer.invoke(IPC.listChatSessions, bookId),
  startChatSession: (bookId: string, title?: string) => ipcRenderer.invoke(IPC.startChatSession, bookId, title),
  setActiveSession: (bookId: string, sessionId: string) => ipcRenderer.invoke(IPC.setActiveSession, bookId, sessionId),
  deleteChatSession: (bookId: string, sessionId: string) => ipcRenderer.invoke(IPC.deleteChatSession, bookId, sessionId),

  getWidgets: () => ipcRenderer.invoke(IPC.getWidgets),
  saveWidgets: (widgets: WidgetConfig[]) => ipcRenderer.invoke(IPC.saveWidgets, widgets),
  getShelfOrder: () => ipcRenderer.invoke(IPC.getShelfOrder),
  saveShelfOrder: (order: ShelfOrder) => ipcRenderer.invoke(IPC.saveShelfOrder, order),
  updateBookSubject: (bookId: string, subject: string) => ipcRenderer.invoke(IPC.updateBookSubject, bookId, subject),
  getCustomShelves: () => ipcRenderer.invoke(IPC.getCustomShelves),
  saveCustomShelves: (shelves: string[]) => ipcRenderer.invoke(IPC.saveCustomShelves, shelves)
}

contextBridge.exposeInMainWorld('api', api)
