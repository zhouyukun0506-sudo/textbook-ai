// 跨进程共享的类型定义(数据模型 + IPC 契约)

/** 文本块在页面中的坐标框,单位为 PDF 用户空间坐标(左上原点) */
export interface BBox {
  x: number
  y: number
  w: number
  h: number
}

/** 解析出的页面文本块 */
export interface TextBlock {
  pageNo: number
  text: string
  bbox: BBox
}

/** 语义分块:检索与引用的基本单位 */
export interface Chunk {
  id: string
  bookId: string
  text: string
  pageNo: number
  /** 该块覆盖的坐标范围,用于原文高亮回跳 */
  bbox: BBox
  /** 所属章节标题(若能识别) */
  section?: string
  /** 内容来源:文本层 or OCR 识别 */
  source?: 'text' | 'ocr'
  /** @deprecated 旧版语义检索的向量;现已改为本地 BM25 词法检索,不再使用 */
  embedding?: number[]
}

export type BookStatus = 'importing' | 'parsing' | 'ocr' | 'indexing' | 'ready' | 'error'

/** 页面类型:文本型(有文本层)或扫描型(需 OCR) */
export type PageKind = 'text' | 'scanned'

export interface Book {
  id: string
  title: string
  filePath: string
  pageCount: number
  status: BookStatus
  /** 源语言,第一版默认 en */
  srcLang: string
  createdAt: number
  /** 文件类型:pdf 或 markdown;旧数据无此字段默认为 pdf */
  fileType?: 'pdf' | 'markdown'
  /** 学科分类(AI 整理后填入,如「物理」「计算机科学」);未分类为空 */
  subject?: string
  /** 用户手动改过学科名:为 true 时「AI 整理」不再覆盖该书的分类 */
  customSubject?: boolean
  /** 导入时的原始文件名(清理/AI 重命名前),便于追溯 */
  originalTitle?: string
  /** 用户手动改过书名:为 true 时「AI 整理」不再覆盖标题 */
  customTitle?: boolean
  /** 解析/索引进度 0-100 */
  progress?: number
  /** 当前阶段的人类可读描述,如「OCR 识别 第 5/120 页」 */
  stage?: string
  /** 是否含扫描页 */
  hasScanned?: boolean
  error?: string
}

/** 大纲节点:AI 从内容提取的结构,用于侧栏导航。
 *  三级:1=章,2=节,3=知识点(知识点带一句话要点 summary)。 */
export interface OutlineNode {
  id: string
  title: string
  level: 1 | 2 | 3
  pageNo: number
  /** 知识点的一句话要点(level 3 常有;章节可选) */
  summary?: string
  /** 关联的 chunk,点击大纲可定位 */
  chunkId?: string
}

/** 聊天会话 */
export interface ChatSession {
  id: string
  bookId: string
  title: string
  createdAt: number
}

/** 一条问答记录 */
export interface ChatTurn {
  id: string
  bookId: string
  sessionId?: string
  mode: 'ask' | 'learn'
  question: string
  /** 用户附加的页面截图(用于视觉问答展示) */
  image?: { pageNo: number; dataUrl: string }
  /** 思考链(模型推理过程),可选 */
  thinking?: string
  answer: string
  citations: Citation[]
  createdAt: number
}

/** 流式问答事件 */
export type ChatStreamChunk =
  | { type: 'stage'; stage: 'retrieving' | 'thinking' | 'answering' }
  | { type: 'thinking'; content: string }
  | { type: 'answer'; content: string }
  | { type: 'citations'; citations: Citation[] }
  | { type: 'done'; turn: ChatTurn }
  | { type: 'error'; message: string }

/** 回答中的引用,指向具体 chunk,用于回跳原文 */
export interface Citation {
  chunkId: string
  pageNo: number
  bbox: BBox
  snippet: string
}

/** OCR 策略:local 仅本地 Tesseract;cloud 全用云端视觉模型;hybrid 本地为主、低置信度页用云端兜底 */
export interface KnowledgeNode {
  id: string
  bookId: string
  title: string
  content: string
  pageNo: number
  chunkId?: string
  difficulty?: 'basic' | 'intermediate' | 'advanced'
  category?: string
}

export interface WeeklyStats {
  weekStart: number
  totalSeconds: number
  /** 每日阅读时长:日期字符串(YYYY-MM-DD) → 秒数 */
  dailySeconds?: Record<string, number>
  chatCount: number
  knowledgeCount: number
}

export type WidgetType = 'weekly' | 'heatmap' | 'streak' | 'import-progress' | 'pomodoro' | 'library-overview'

export interface WidgetConfig {
  id: string
  type: WidgetType
  width: number
  height: number
  /** 自由摆放坐标(相对小组件画布左上角);旧数据无此字段时按流式默认位置排布 */
  x?: number
  y?: number
}

export interface ShelfLayout {
  subject: string
  x: number
  y: number
}

export type OcrMode = 'local' | 'cloud' | 'hybrid'
export type Provider = 'openai' | 'anthropic'

/** 单个 API 配置档案 */
export interface ApiProfile {
  id: string
  name: string
  provider: Provider
  baseUrl: string
  chatModel: string
  visionModel: string
  ocrMode: OcrMode
  /** hasKey 仅用于 UI 显示是否已配置,真实 key 不出主进程 */
  hasKey: boolean
}

/** 设置界面提交用的 profile 输入(可带明文 apiKey) */
export interface ApiProfileInput {
  id?: string
  name: string
  provider: Provider
  baseUrl: string
  chatModel: string
  visionModel: string
  ocrMode: OcrMode
  apiKey?: string
}

/** LLM 配置(多档案) */
export interface ApiConfig {
  profiles: ApiProfile[]
  activeProfileId: string | null
  /** 知识拆解专用模型(留空则使用对话模型) */
  knowledgeModel: string
  /** 知识拆解并行批次数(1-10),默认 3 */
  knowledgeConcurrency: number
}

/** 渲染进程在做 OCR 前向主进程询问的执行计划 */
export interface OcrPlan {
  /** 需要 OCR 的页码(1-based) */
  pageNos: number[]
  mode: OcrMode
}

/** 渲染进程完成一页 OCR 后回传的结果 */
export interface OcrPageResult {
  pageNo: number
  blocks: TextBlock[]
  /** 平均置信度 0-100(本地 Tesseract 给出),用于 hybrid 决策记录 */
  confidence?: number
}

/** 渲染进程可调用的主进程 API(由 preload 暴露在 window.api) */
export interface ExposedApi {
  // 书库
  listBooks: () => Promise<Book[]>
  importFile: () => Promise<Book | null>
  deleteBook: (bookId: string) => Promise<void>
  /** 取消正在导入/解析/OCR/索引的书:中断流水线并删除该书 */
  cancelImport: (bookId: string) => Promise<void>
  /** 重建索引:删除旧索引后重新解析、分块、生成大纲 */
  rebuildIndex: (bookId: string) => Promise<void>
  /** 自定义书名:写入新标题并标记 customTitle,AI 整理时不再覆盖。返回更新后的书 */
  renameBook: (bookId: string, title: string) => Promise<Book | null>
  /** 重命名学科大类:把该类下所有书的 subject 改名并标记 customSubject,AI 整理不再重新归类。返回更新后的书列表 */
  renameSubject: (from: string, to: string) => Promise<Book[]>
  /** AI 一键整理书架:优化书名 + 学科分类,返回更新后的书列表 */
  organizeLibrary: () => Promise<Book[]>
  getBookChunks: (bookId: string) => Promise<Chunk[]>
  /** 读取 PDF 原始字节用于渲染器内 pdf.js 显示 */
  readPdfData: (bookId: string) => Promise<Uint8Array | null>
  /** 读取 Markdown 原始文本(用于渲染器内显示) */
  readMarkdownData: (bookId: string) => Promise<string | null>
  // 问答
  ask: (bookId: string, question: string, mode: 'ask' | 'learn') => Promise<ChatTurn>
  /** 流式问答:立即返回 turnId,内容通过 onChatStream 推送 */
  askStream: (bookId: string, question: string, mode: 'ask' | 'learn') => Promise<string>
  /** 把当前 PDF 页面截图发给视觉模型分析 */
  askPageImage: (bookId: string, pageNo: number, pngDataUrl: string, prompt?: string) => Promise<ChatTurn>
  listChats: (bookId: string) => Promise<ChatTurn[]>
  onChatStream: (cb: (chunk: ChatStreamChunk) => void) => () => void

  // 大纲
  getOutline: (bookId: string) => Promise<OutlineNode[]>
  generateOutline: (bookId: string) => Promise<OutlineNode[]>

  // OCR 协作(本地 OCR 在渲染进程执行,主进程编排与云端兜底;仅 PDF 有效)
  getOcrPlan: (bookId: string) => Promise<OcrPlan>
  /** 云端视觉模型识别单页(渲染进程传 PNG dataURL),返回文本块 */
  ocrPageCloud: (bookId: string, pageNo: number, pngDataUrl: string) => Promise<TextBlock[]>
  /** 回传本地 OCR 结果,主进程据此完成分块与索引 */
  submitOcrResults: (bookId: string, pages: OcrPageResult[]) => Promise<void>

  // 知识点拆解
  getKnowledgeNodes: (bookId: string) => Promise<KnowledgeNode[]>
  generateKnowledge: (bookId: string) => Promise<KnowledgeNode[]>
  clearKnowledge: (bookId: string) => Promise<void>

  // 配置
  getApiConfig: () => Promise<ApiConfig>
  setApiConfig: (cfg: {
    profiles: ApiProfileInput[]
    activeProfileId?: string
    knowledgeModel?: string
    knowledgeConcurrency?: number
  }) => Promise<ApiConfig>
  testProfile: (profile: ApiProfileInput) => Promise<{ ok: boolean; error?: string }>

  // 事件:解析/索引进度
  onBookProgress: (cb: (book: Book) => void) => () => void

  // 研读周报
  getWeeklyStats: () => Promise<WeeklyStats[]>
  addReadingTime: (seconds: number) => Promise<WeeklyStats[]>
  incrementChatCount: () => Promise<void>
  incrementKnowledgeCount: () => Promise<void>

  // 聊天会话
  listChatSessions: (bookId: string) => Promise<ChatSession[]>
  startChatSession: (bookId: string, title?: string) => Promise<ChatSession>
  setActiveSession: (bookId: string, sessionId: string) => Promise<void>
  deleteChatSession: (bookId: string, sessionId: string) => Promise<void>

  // 小组件系统
  getWidgets: () => Promise<WidgetConfig[]>
  saveWidgets: (widgets: WidgetConfig[]) => Promise<void>

  // 书架布局
  getShelfLayout: () => Promise<ShelfLayout[]>
  saveShelfLayout: (layout: ShelfLayout[]) => Promise<void>
  updateBookSubject: (bookId: string, subject: string) => Promise<void>
  /** 自定义(可空)书架名单:即使没有书也显示,作为拖书归类的目标 */
  getCustomShelves: () => Promise<string[]>
  saveCustomShelves: (shelves: string[]) => Promise<void>
}
