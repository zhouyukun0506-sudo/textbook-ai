// IPC 通道名集中管理,避免 main / preload 字符串不一致

export const IPC = {
  listBooks: 'books:list',
  importFile: 'books:import',
  deleteBook: 'books:delete',
  cancelImport: 'books:cancel',
  rebuildIndex: 'books:rebuild',
  renameBook: 'books:rename',
  renameSubject: 'books:renameSubject',
  organizeLibrary: 'books:organize',
  getBookChunks: 'books:chunks',
  readPdfData: 'books:pdfData',
  readMarkdownData: 'books:markdownData',
  ask: 'chat:ask',
  askStream: 'chat:askStream',
  askPageImage: 'chat:askPageImage',
  chatStream: 'chat:streamChunk',
  listChats: 'chat:list',
  getOutline: 'outline:get',
  generateOutline: 'outline:generate',
  getOcrPlan: 'ocr:plan',
  ocrPageCloud: 'ocr:pageCloud',
  submitOcrResults: 'ocr:submit',
  getApiConfig: 'config:get',
  setApiConfig: 'config:set',
  testProfile: 'config:test',
  knowledgeGet: 'knowledge:get',
  knowledgeGenerate: 'knowledge:generate',
  knowledgeClear: 'knowledge:clear',
  // 研读周报
  getWeeklyStats: 'stats:getWeekly',
  addReadingTime: 'stats:addReadingTime',
  incrementChatCount: 'stats:incrementChatCount',
  incrementKnowledgeCount: 'stats:incrementKnowledgeCount',
  // 聊天会话
  listChatSessions: 'chat:sessions',
  startChatSession: 'chat:startSession',
  setActiveSession: 'chat:setActive',
  deleteChatSession: 'chat:deleteSession',
  // 小组件系统
  getWidgets: 'widgets:get',
  saveWidgets: 'widgets:save',
  // 书架布局
  getShelfLayout: 'layout:get',
  saveShelfLayout: 'layout:save',
  updateBookSubject: 'books:updateSubject',
  getCustomShelves: 'shelves:get',
  saveCustomShelves: 'shelves:save',
  // main -> renderer 事件
  bookProgress: 'books:progress'
} as const
