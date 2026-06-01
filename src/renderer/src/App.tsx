import { useEffect, useState, useCallback, useRef } from 'react'
import type { Book, ApiConfig, WeeklyStats, WidgetConfig, ShelfOrder } from '@shared/types'
import Library from './components/Library'
import Reader from './components/Reader'
import Settings from './components/Settings'
import AmbientParticles from './components/AmbientParticles'
import ErrorBoundary from './components/ErrorBoundary'
import { runOcr } from './lib/ocrRunner'
import { usePomodoro } from './lib/usePomodoro'

export default function App(): JSX.Element {
  const [books, setBooks] = useState<Book[]>([])
  const [activeBookId, setActiveBookId] = useState<string | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [apiConfig, setApiConfig] = useState<ApiConfig | null>(null)
  const [organizing, setOrganizing] = useState(false)
  const [weeklyStats, setWeeklyStats] = useState<WeeklyStats[]>([])
  const [widgets, setWidgets] = useState<WidgetConfig[]>([])
  const [order, setOrder] = useState<string[]>([])
  // 用户手动建的空书架名单(即使没书也显示,作为拖书归类的落脚点)
  const [customShelves, setCustomShelves] = useState<string[]>([])
  // 番茄钟:App 级全局状态,主页小组件与阅读页共用同一个,切页面继续走(关 app 重置)
  const pomodoro = usePomodoro()
  // 正在 OCR 的书,避免重复触发
  const ocrRunning = useRef<Set<string>>(new Set())
  // 已请求取消的书:OCR 循环每页检查,命中则停下
  const ocrCanceled = useRef<Set<string>>(new Set())

  const refreshBooks = useCallback(async () => {
    setBooks(await window.api.listBooks())
  }, [])

  // 当某本书进入 ocr 状态时,在渲染进程执行 OCR(可用 canvas + Tesseract.js)
  const maybeRunOcr = useCallback(async (book: Book) => {
    if (book.status !== 'ocr' || ocrRunning.current.has(book.id)) return
    if (ocrCanceled.current.has(book.id)) return
    ocrRunning.current.add(book.id)
    try {
      const plan = await window.api.getOcrPlan(book.id)
      const results = await runOcr(
        book.id,
        plan.pageNos,
        plan.mode,
        (p) => {
          setBooks((prev) =>
            prev.map((b) =>
              b.id === book.id
                ? {
                    ...b,
                    stage: `OCR 识别 ${p.done}/${p.total} 页 · 第 ${p.pageNo} 页(${p.via === 'cloud' ? '云端' : '本地'})`,
                    progress: 15 + Math.round((p.done / p.total) * 30)
                  }
                : b
            )
          )
        },
        () => ocrCanceled.current.has(book.id)
      )
      await window.api.submitOcrResults(book.id, results)
    } catch (e) {
      if (e instanceof Error && e.message === '__CANCELED__') {
        // 用户取消:静默,记录已在主进程删除
      } else {
        console.error('OCR 失败', e)
        setBooks((prev) =>
          prev.map((b) =>
            b.id === book.id ? { ...b, status: 'error', error: `OCR 失败:${e instanceof Error ? e.message : String(e)}` } : b
          )
        )
      }
    } finally {
      ocrRunning.current.delete(book.id)
    }
  }, [])

  useEffect(() => {
    void refreshBooks()
    void window.api.getApiConfig().then(setApiConfig)
    void window.api.getWeeklyStats().then(setWeeklyStats)
    void window.api.getWidgets().then(setWidgets)
    void window.api.getShelfOrder().then(setOrder)
    void window.api.getCustomShelves().then(setCustomShelves)
    const off = window.api.onBookProgress((book) => {
      setBooks((prev) => {
        const idx = prev.findIndex((b) => b.id === book.id)
        if (idx < 0) return [book, ...prev]
        const next = [...prev]
        next[idx] = book
        return next
      })
      void maybeRunOcr(book)
    })
    return off
  }, [refreshBooks, maybeRunOcr])

  // 阅读时间追踪:打开书时开始计时,每 30 秒同步一次
  const readingStart = useRef<number>(0)
  const readingAccumulated = useRef<number>(0)
  useEffect(() => {
    if (!activeBookId) {
      // 离开阅读界面时保存累计时长
      if (readingAccumulated.current > 0) {
        void window.api.addReadingTime(readingAccumulated.current)
        readingAccumulated.current = 0
      }
      return
    }
    readingStart.current = Date.now()
    const interval = window.setInterval(() => {
      const now = Date.now()
      const delta = now - readingStart.current
      readingStart.current = now
      readingAccumulated.current += delta
      if (readingAccumulated.current >= 30_000) {
        const batch = readingAccumulated.current
        readingAccumulated.current = 0
        void window.api.addReadingTime(Math.round(batch / 1000)).then(setWeeklyStats)
      }
    }, 30_000)
    const handleVisibility = () => {
      if (document.hidden) {
        const delta = Date.now() - readingStart.current
        readingAccumulated.current += delta
      } else {
        readingStart.current = Date.now()
      }
    }
    document.addEventListener('visibilitychange', handleVisibility)
    return () => {
      window.clearInterval(interval)
      document.removeEventListener('visibilitychange', handleVisibility)
      const delta = Date.now() - readingStart.current
      readingAccumulated.current += delta
      if (readingAccumulated.current > 5000) {
        void window.api.addReadingTime(Math.round(readingAccumulated.current / 1000)).then(setWeeklyStats)
        readingAccumulated.current = 0
      }
    }
  }, [activeBookId])

  const activeBook = books.find((b) => b.id === activeBookId) ?? null

  const handleImport = async (): Promise<void> => {
    const book = await window.api.importFile()
    if (book) {
      await refreshBooks()
      setActiveBookId(book.id)
    }
  }

  const handleConfigSaved = async (cfg: ApiConfig): Promise<void> => {
    setApiConfig(cfg)
    setShowSettings(false)
    await refreshBooks()
  }

  // 取消正在处理的书:本地标记 OCR 终止 + 通知主进程中断并删除 + 立即从列表移除
  const handleCancel = async (id: string): Promise<void> => {
    ocrCanceled.current.add(id)
    setBooks((prev) => prev.filter((b) => b.id !== id))
    try {
      await window.api.cancelImport(id)
    } finally {
      await refreshBooks()
    }
  }

  const handleOrganize = async (): Promise<void> => {
    setOrganizing(true)
    try {
      const updated = await window.api.organizeLibrary()
      setBooks(updated)
    } catch (e) {
      console.error('整理书架失败', e)
    } finally {
      setOrganizing(false)
    }
  }

  return (
    <>
      <AmbientParticles />
      <ErrorBoundary>
        <div className="app">
        <header className="topbar">
        <div className="brand" onClick={() => setActiveBookId(null)}>
          <span className="logo">❦</span>
          <span className="brand-name">TextbookAI</span>
          <span className="tag">双语研读</span>
        </div>
        <div className="topbar-actions">
          {!(apiConfig?.profiles.some((p) => p.hasKey)) && (
            <span className="warn-pill" title="未配置 API,问答功能不可用" onClick={() => setShowSettings(true)}>
              未配置 API
            </span>
          )}
          <button className="ghost-btn" onClick={() => setShowSettings(true)}>
            设置
          </button>
        </div>
      </header>

      <main className="content">
        {activeBook ? (
          <div key={`reader-${activeBook.id}`} className="view-swap view-reader">
            <Reader book={activeBook} hasKey={apiConfig?.profiles.some((p) => p.hasKey) ?? false} onBack={() => setActiveBookId(null)} pomodoro={pomodoro} />
          </div>
        ) : (
          <div key="library" className="view-swap view-library">
            <Library
              books={books}
              hasKey={apiConfig?.profiles.some((p) => p.hasKey) ?? false}
              organizing={organizing}
              weeklyStats={weeklyStats}
              widgets={widgets}
              order={order}
              customShelves={customShelves}
              pomodoro={pomodoro}
              onWidgetsChange={setWidgets}
              onOrderChange={setOrder}
              onCustomShelvesChange={setCustomShelves}
              onOpen={(id) => setActiveBookId(id)}
              onImport={handleImport}
              onOrganize={handleOrganize}
              onCancel={handleCancel}
              onDelete={async (id) => {
                await window.api.deleteBook(id)
                await refreshBooks()
              }}
              onRename={async (id, title) => {
                const updated = await window.api.renameBook(id, title)
                if (updated) setBooks((prev) => prev.map((b) => (b.id === id ? updated : b)))
              }}
              onRebuild={async (id) => {
                await window.api.rebuildIndex(id)
                await refreshBooks()
                alert('重建索引已启动，该书将重新进入处理队列。')
              }}
              onRefreshBooks={refreshBooks}
              onRenameSubject={async (from, to) => {
                try {
                  const updated = await window.api.renameSubject(from, to)
                  setBooks(updated)
                } catch (e) {
                  console.error('重命名分类失败', e)
                }
              }}
            />
          </div>
        )}
      </main>

      {showSettings && (
        <Settings
          initial={apiConfig}
          onClose={() => setShowSettings(false)}
          onSaved={handleConfigSaved}
        />
      )}
    </div>
      </ErrorBoundary>
    </>
  )
}
