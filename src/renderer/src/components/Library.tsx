import { useMemo, useState, useCallback, useRef, useEffect } from 'react'
import type { CSSProperties } from 'react'
import type { Book, WeeklyStats, WidgetConfig, WidgetType } from '@shared/types'
import type { PomodoroControls } from '../lib/usePomodoro'
import WeeklyReport from './WeeklyReport'
import HeatmapWidget from './HeatmapWidget'
import StreakWidget from './StreakWidget'
import ImportProgressWidget from './ImportProgressWidget'
import PomodoroWidget from './PomodoroWidget'
import LibraryOverviewWidget from './LibraryOverviewWidget'
import vase1 from '../assets/vase-1.png'
import vase2 from '../assets/vase-2.png'
import vase3 from '../assets/vase-3.png'
import vase4 from '../assets/vase-4.png'

/** 架尾装饰花瓶素材(手绘,透明底) */
const VASES = [vase1, vase2, vase3, vase4]

/** 悬停信息卡的数据:由被悬停的书脊算出位置,卡片在最外层固定定位渲染,避免被滚动容器裁剪或压住别的书 */
interface HoverInfo {
  book: Book
  subject: string
  left: number
  right: number
  top: number
  bottom: number
}

/** 重命名弹窗的目标:书名或学科大类 */
type RenameTarget =
  | { kind: 'book'; id: string; value: string }
  | { kind: 'subject'; value: string }

interface Props {
  books: Book[]
  hasKey: boolean
  organizing: boolean
  weeklyStats: WeeklyStats[]
  widgets: WidgetConfig[]
  order: string[]
  customShelves: string[]
  pomodoro: PomodoroControls
  onOpen: (id: string) => void
  onImport: () => void
  onDelete: (id: string) => void
  onCancel: (id: string) => void
  onOrganize: () => void
  onRename: (id: string, title: string) => void
  onRenameSubject: (from: string, to: string) => void
  onRebuild: (id: string) => void
  onWidgetsChange: (widgets: WidgetConfig[]) => void
  onOrderChange: (order: string[]) => void
  onCustomShelvesChange: (shelves: string[]) => void
  onRefreshBooks: () => Promise<void>
}

const STATUS_LABEL: Record<Book['status'], string> = {
  importing: '导入中',
  parsing: '解析中',
  ocr: '识别中',
  indexing: '建立索引',
  ready: '可用',
  error: '出错'
}

const UNCLASSIFIED = '未分类'

// ---- 几何工具(仅小组件自由布局用) ----
interface Rect { x: number; y: number; w: number; h: number }

function rectsOverlapXY(a: Rect, b: Rect): boolean {
  return !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y)
}

/** 在 widget-desktop 区域内为新增小组件找第一个空位 */
function findFreeSlot(w: number, h: number, occupied: Rect[], containerW: number): { x: number; y: number } {
  const GAP = 16
  const maxX = Math.max(GAP, containerW - w - GAP)
  for (let y = GAP; ; y += GAP) {
    for (let x = GAP; x <= maxX; x += GAP) {
      const rect = { x, y, w, h }
      if (!occupied.some((o) => rectsOverlapXY(rect, o))) return { x, y }
    }
    if (y > 5000) return { x: GAP, y: GAP }
  }
}

// 书脊布面色(做旧、低饱和,像老图书馆里晒褪了的布面/皮面精装),按书 id 稳定取色。
const SPINE_COLORS = [
  '#8a4f43', '#3f5566', '#5c6647', '#6b5274', '#a07b46',
  '#46625c', '#7d4f5c', '#3c4a63', '#8a6239', '#566b4e',
  '#9a8350', '#704a44'
]

function hashId(id: string): number {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0
  return Math.abs(h)
}

export default function Library({
  books,
  hasKey,
  organizing,
  weeklyStats,
  widgets,
  order,
  customShelves,
  pomodoro,
  onOpen,
  onImport,
  onDelete,
  onCancel,
  onOrganize,
  onRename,
  onRenameSubject,
  onRebuild,
  onWidgetsChange,
  onOrderChange,
  onCustomShelvesChange,
  onRefreshBooks
}: Props): JSX.Element {
  // 处理中/出错的书单独拎出来;其余 ready 的书上架
  const { processing, shelves } = useMemo(() => {
    const processing: Book[] = []
    const map = new Map<string, Book[]>()
    for (const name of customShelves) {
      const t = name.trim()
      if (t && !map.has(t)) map.set(t, [])
    }
    for (const b of books) {
      if (b.status !== 'ready') { processing.push(b); continue }
      const subj = b.subject?.trim() || UNCLASSIFIED
      if (!map.has(subj)) map.set(subj, [])
      map.get(subj)!.push(b)
    }
    const shelves = [...map.entries()].sort((a, b) => {
      if (a[0] === UNCLASSIFIED) return 1
      if (b[0] === UNCLASSIFIED) return -1
      return b[1].length - a[1].length
    })
    return { processing, shelves }
  }, [books, customShelves])

  const canOrganize = hasKey && books.some((b) => b.status === 'ready')

  // 按 order 数组排序书架;order 中未包含的排在末尾
  const sortedShelves = useMemo(() => {
    const orderMap = new Map(order.map((s, i) => [s, i]))
    return [...shelves].sort((a, b) => {
      const ia = orderMap.get(a[0])
      const ib = orderMap.get(b[0])
      if (ia !== undefined && ib !== undefined) return ia - ib
      if (ia !== undefined) return -1
      if (ib !== undefined) return 1
      return b[1].length - a[1].length
    })
  }, [shelves, order])

  // 悬停信息卡
  const [hover, setHover] = useState<HoverInfo | null>(null)
  const closeTimer = useRef<number | null>(null)
  const cancelClose = useCallback(() => {
    if (closeTimer.current !== null) { window.clearTimeout(closeTimer.current); closeTimer.current = null }
  }, [])
  const handleHover = useCallback((info: HoverInfo) => { cancelClose(); setHover(info) }, [cancelClose])
  const handleLeave = useCallback(() => { cancelClose(); closeTimer.current = window.setTimeout(() => setHover(null), 180) }, [cancelClose])

  // 重命名
  const [renaming, setRenaming] = useState<RenameTarget | null>(null)
  const [barOpen, setBarOpen] = useState(false)
  const handleRenameStart = useCallback((b: Book) => { setHover(null); setRenaming({ kind: 'book', id: b.id, value: b.title }) }, [])
  const handleRenameSubject = useCallback((subject: string) => { setRenaming({ kind: 'subject', value: subject }) }, [])

  // ---- 添加/删除空书架 ----
  const customShelvesRef = useRef<string[]>(customShelves)
  useEffect(() => { customShelvesRef.current = customShelves }, [customShelves])

  const addShelf = useCallback(() => {
    const taken = new Set<string>()
    for (const [name] of shelves) taken.add(name)
    for (const name of customShelvesRef.current) taken.add(name.trim())
    let name = '新书架'
    let n = 2
    while (taken.has(name)) { name = `新书架 ${n}`; n++ }
    const next = [...customShelvesRef.current, name]
    customShelvesRef.current = next
    onCustomShelvesChange(next)
    void window.api.saveCustomShelves(next)
  }, [shelves, onCustomShelvesChange])

  const removeShelf = useCallback((subject: string) => {
    const next = customShelvesRef.current.filter((s) => s.trim() !== subject)
    customShelvesRef.current = next
    onCustomShelvesChange(next)
    void window.api.saveCustomShelves(next)
  }, [onCustomShelvesChange])

  const renameCustomShelf = useCallback((from: string, to: string) => {
    const list = customShelvesRef.current
    if (!list.includes(from)) return
    const next = list.map((s) => (s === from ? to : s))
    customShelvesRef.current = next
    onCustomShelvesChange(next)
    void window.api.saveCustomShelves(next)
  }, [onCustomShelvesChange])

  // ---- 拖拽书架重新排序 ----
  const [dragOverSubject, setDragOverSubject] = useState<string | null>(null)

  const handleShelfDragStart = useCallback((subject: string) => (e: React.DragEvent) => {
    e.dataTransfer.setData('text/shelf-subject', subject)
    e.dataTransfer.effectAllowed = 'move'
  }, [])

  const handleShelfDragOver = useCallback((subject: string) => (e: React.DragEvent) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    const src = e.dataTransfer.getData('text/shelf-subject')
    if (src && src !== subject) setDragOverSubject(subject)
  }, [])

  const handleShelfDrop = useCallback((targetSubject: string) => (e: React.DragEvent) => {
    e.preventDefault()
    setDragOverSubject(null)
    const sourceSubject = e.dataTransfer.getData('text/shelf-subject')
    if (!sourceSubject || sourceSubject === targetSubject) return
    const currentOrder = order.length ? order : shelves.map(([s]) => s)
    const newOrder = [...currentOrder]
    const fromIdx = newOrder.indexOf(sourceSubject)
    const toIdx = newOrder.indexOf(targetSubject)
    if (fromIdx === -1 || toIdx === -1) return
    newOrder.splice(fromIdx, 1)
    newOrder.splice(toIdx, 0, sourceSubject)
    onOrderChange(newOrder)
    void window.api.saveShelfOrder(newOrder)
  }, [order, shelves, onOrderChange])

  // ---- 拖书换分类 ----
  const handleBookDrop = useCallback(async (e: React.DragEvent, subject: string) => {
    e.preventDefault()
    const bookId = e.dataTransfer.getData('text/plain')
    if (!bookId) return
    await window.api.updateBookSubject(bookId, subject)
    await onRefreshBooks()
  }, [onRefreshBooks])

  // ---- 小组件系统(上方自由布局区) ----
  const widgetsRef = useRef<WidgetConfig[]>(widgets)
  useEffect(() => { widgetsRef.current = widgets }, [widgets])

  const widgetPositions = useMemo(() => {
    const map = new Map<string, { x: number; y: number }>()
    let flowX = 16
    for (const w of widgets) {
      if (typeof w.x === 'number' && typeof w.y === 'number') {
        map.set(w.id, { x: w.x, y: w.y })
      } else {
        map.set(w.id, { x: flowX, y: 16 })
        flowX += (w.width ?? 320) + 16
      }
    }
    return map
  }, [widgets])

  const removeWidget = useCallback((id: string) => {
    const next = widgetsRef.current.filter((w) => w.id !== id)
    widgetsRef.current = next
    onWidgetsChange(next)
    void window.api.saveWidgets(next)
  }, [onWidgetsChange])

  const addWidget = useCallback((type: WidgetType) => {
    const DEFAULT_SIZE: Record<WidgetType, { width: number; height: number }> = {
      weekly: { width: 360, height: 210 },
      heatmap: { width: 340, height: 200 },
      streak: { width: 240, height: 200 },
      'import-progress': { width: 320, height: 220 },
      pomodoro: { width: 260, height: 230 },
      'library-overview': { width: 320, height: 230 }
    }
    const sz = DEFAULT_SIZE[type] ?? { width: 320, height: 200 }
    const containerW = Math.max(800, (typeof window !== 'undefined' ? window.innerWidth : 1200) - 120)
    const occupied: Rect[] = widgetsRef.current.map((w) => {
      const pos = widgetPositions.get(w.id) ?? { x: 0, y: 0 }
      return { x: pos.x, y: pos.y, w: w.width ?? 320, h: w.height ?? 200 }
    })
    const spot = findFreeSlot(sz.width, sz.height, occupied, containerW)
    const next = [...widgetsRef.current, { id: `w-${Date.now()}`, type, width: sz.width, height: sz.height, x: spot.x, y: spot.y }]
    widgetsRef.current = next
    onWidgetsChange(next)
    void window.api.saveWidgets(next)
  }, [onWidgetsChange, widgetPositions])

  // 小组件拖拽
  const widgetDragRef = useRef<{
    id: string; startX: number; startY: number; el: HTMLElement; handle: HTMLElement; startLeft: number; startTop: number
  } | null>(null)

  const handleWidgetDragStart = useCallback((e: React.PointerEvent, id: string) => {
    const handle = e.currentTarget as HTMLElement
    const el = handle.closest('.widget-col') as HTMLElement | null
    const desk = document.querySelector('.widget-desktop') as HTMLElement | null
    if (!el || !desk) return
    e.preventDefault(); e.stopPropagation()
    handle.setPointerCapture(e.pointerId)
    const deskRect = desk.getBoundingClientRect()
    const elRect = el.getBoundingClientRect()
    widgetDragRef.current = {
      id, startX: e.clientX, startY: e.clientY, el, handle,
      startLeft: elRect.left - deskRect.left, startTop: elRect.top - deskRect.top
    }
  }, [])

  useEffect(() => {
    const onMove = (ev: PointerEvent) => {
      const drag = widgetDragRef.current
      if (!drag) return
      const nx = Math.max(0, drag.startLeft + (ev.clientX - drag.startX))
      const ny = Math.max(0, drag.startTop + (ev.clientY - drag.startY))
      drag.el.style.zIndex = '1000'
      drag.el.style.left = `${nx}px`; drag.el.style.top = `${ny}px`
    }
    const onUp = (ev: PointerEvent) => {
      const drag = widgetDragRef.current
      if (!drag) return
      try { drag.handle.releasePointerCapture(ev.pointerId) } catch { }
      const rawX = Math.max(0, drag.startLeft + (ev.clientX - drag.startX))
      const rawY = Math.max(0, drag.startTop + (ev.clientY - drag.startY))
      const next = widgetsRef.current.map((w) => (w.id === drag.id ? { ...w, x: Math.round(rawX), y: Math.round(rawY) } : w))
      widgetsRef.current = next
      onWidgetsChange(next)
      void window.api.saveWidgets(next)
      drag.el.style.zIndex = ''
      widgetDragRef.current = null
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => { window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp) }
  }, [onWidgetsChange])

  // 小组件缩放
  const WIDGET_MIN_W = 200, WIDGET_MIN_H = 140, WIDGET_MAX_W = 760, WIDGET_MAX_H = 560
  const widgetResizeRef = useRef<{
    id: string; startX: number; startY: number; el: HTMLElement; handle: HTMLElement; startW: number; startH: number
  } | null>(null)

  const handleWidgetResizeStart = useCallback((e: React.PointerEvent, id: string) => {
    const handle = e.currentTarget as HTMLElement
    const el = handle.closest('.widget-col') as HTMLElement | null
    if (!el) return
    e.preventDefault(); e.stopPropagation()
    handle.setPointerCapture(e.pointerId)
    const rect = el.getBoundingClientRect()
    widgetResizeRef.current = { id, startX: e.clientX, startY: e.clientY, el, handle, startW: rect.width, startH: rect.height }
  }, [])

  useEffect(() => {
    const clampW = (w: number) => Math.max(WIDGET_MIN_W, Math.min(WIDGET_MAX_W, w))
    const clampH = (h: number) => Math.max(WIDGET_MIN_H, Math.min(WIDGET_MAX_H, h))
    const onMove = (ev: PointerEvent) => {
      const rz = widgetResizeRef.current
      if (!rz) return
      const w = clampW(rz.startW + (ev.clientX - rz.startX))
      const h = clampH(rz.startH + (ev.clientY - rz.startY))
      rz.el.style.width = `${w}px`; rz.el.style.height = `${h}px`
    }
    const onUp = (ev: PointerEvent) => {
      const rz = widgetResizeRef.current
      if (!rz) return
      try { rz.handle.releasePointerCapture(ev.pointerId) } catch { }
      const w = Math.round(clampW(rz.startW + (ev.clientX - rz.startX)))
      const h = Math.round(clampH(rz.startH + (ev.clientY - rz.startY)))
      const next = widgetsRef.current.map((x) => (x.id === rz.id ? { ...x, width: w, height: h } : x))
      widgetsRef.current = next
      onWidgetsChange(next)
      void window.api.saveWidgets(next)
      widgetResizeRef.current = null
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => { window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp) }
  }, [onWidgetsChange])

  const renderWidget = useCallback((w: WidgetConfig) => {
    switch (w.type) {
      case 'weekly': return <WeeklyReport stats={weeklyStats} />
      case 'heatmap': return <HeatmapWidget stats={weeklyStats} />
      case 'streak': return <StreakWidget stats={weeklyStats} />
      case 'import-progress': return <ImportProgressWidget processing={processing} />
      case 'pomodoro': return <PomodoroWidget pomodoro={pomodoro} />
      case 'library-overview': return <LibraryOverviewWidget books={books} />
      default: return null
    }
  }, [weeklyStats, processing, pomodoro, books])

  return (
    <div className="library">
      <div className="library-header">
        <div>
          <h1>我的书架</h1>
          <p className="subtitle">导入英文原版,以母语研读,与原文相对而坐。</p>
        </div>
        <div className="library-actions">
          {books.length > 0 && (
            <button className="ghost-btn" disabled={!canOrganize || organizing} onClick={onOrganize}>
              {organizing ? '整理中…' : '✦ AI 整理书架'}
            </button>
          )}
          <button className="primary-btn" onClick={onImport}>＋ 导入文件</button>
        </div>
      </div>

      {books.length === 0 ? (
        <div className="empty">
          <div className="empty-icon">❦</div>
          <p>书架还空着。点击右上角「导入文件」开始。</p>
          <p className="muted small">支持 PDF、Word、PPT、Excel、Markdown 等格式。</p>
        </div>
      ) : (
        <>
          <div className={`widget-bar ${barOpen ? 'open' : 'collapsed'}`}>
            <button className="widget-bar-toggle" onClick={() => setBarOpen((v) => !v)}>
              <span className="widget-bar-caret">{barOpen ? '▾' : '▸'}</span>添加
            </button>
            {barOpen && (
              <>
                <button className="widget-config-btn" onClick={() => addWidget('weekly')}>+ 周报</button>
                <button className="widget-config-btn" onClick={() => addWidget('pomodoro')}>+ 番茄钟</button>
                <button className="widget-config-btn" onClick={() => addWidget('library-overview')}>+ 书库总览</button>
                <button className="widget-config-btn" onClick={() => addWidget('heatmap')}>+ 热力图</button>
                <button className="widget-config-btn" onClick={() => addWidget('streak')}>+ 连续阅读</button>
                <button className="widget-config-btn" onClick={() => addWidget('import-progress')}>+ 导入进度</button>
                <span className="widget-bar-sep" aria-hidden="true" />
                <button className="widget-config-btn" onClick={addShelf} title="新建一个空书架,可把书拖进来重新归类">+ 空书架</button>
              </>
            )}
          </div>

          {processing.length > 0 && (
            <div className="processing-panel">
              <div className="processing-head muted small">正在处理 {processing.length} 本</div>
              {processing.map((b) => (
                <ProcessingRow key={b.id} book={b} onCancel={onCancel} onDelete={onDelete} />
              ))}
            </div>
          )}

          {/* 小组件自由布局区 */}
          <div className="widget-desktop">
            {widgets.map((w) => {
              const pos = widgetPositions.get(w.id) ?? { x: 16, y: 16 }
              return (
                <div key={w.id} className="widget-col" style={{ width: w.width, height: w.height, left: pos.x, top: pos.y }}>
                  <div className="widget-header" onPointerDown={(e) => handleWidgetDragStart(e, w.id)} title="拖动摆放">
                    <span className="widget-grip" aria-hidden="true">⠿</span>
                    <button className="widget-close-btn" onPointerDown={(e) => e.stopPropagation()} onClick={() => removeWidget(w.id)}>×</button>
                  </div>
                  {renderWidget(w)}
                  <span className="widget-resize-handle" onPointerDown={(e) => handleWidgetResizeStart(e, w.id)} aria-hidden="true" />
                </div>
              )
            })}
          </div>

          {/* 书架网格区 */}
          <div className="shelf-grid">
            {sortedShelves.map(([subject, items]) => (
              <Shelf
                key={subject}
                subject={subject}
                items={items}
                isDragOver={dragOverSubject === subject}
                onDragStart={handleShelfDragStart(subject)}
                onDragOver={handleShelfDragOver(subject)}
                onDrop={handleShelfDrop(subject)}
                onDragLeave={() => setDragOverSubject(null)}
                onBookDrop={(e) => { void handleBookDrop(e, subject) }}
                onOpen={onOpen}
                onRenameSubject={handleRenameSubject}
                onRemove={items.length === 0 ? removeShelf : undefined}
                onHover={handleHover}
                onLeave={handleLeave}
              />
            ))}
          </div>
        </>
      )}

      {hover && (
        <HoverCard
          info={hover}
          onMouseEnter={cancelClose}
          onMouseLeave={handleLeave}
          onRename={(b) => { cancelClose(); setHover(null); handleRenameStart(b) }}
          onDelete={(id) => { cancelClose(); setHover(null); onDelete(id) }}
          onRebuild={(id) => { cancelClose(); setHover(null); onRebuild(id) }}
          onOpen={(id) => { cancelClose(); setHover(null); onOpen(id) }}
        />
      )}
      {renaming && (
        <RenameDialog
          key={`${renaming.kind}-${renaming.kind === 'book' ? renaming.id : renaming.value}`}
          target={renaming}
          onCancel={() => setRenaming(null)}
          onConfirm={async (next) => {
            const target = renaming
            setRenaming(null)
            if (target.kind === 'book') { await onRename(target.id, next) }
            else {
              renameCustomShelf(target.value, next)
              await onRenameSubject(target.value, next)
            }
          }}
        />
      )}
    </div>
  )
}

/** 重命名弹窗 */
function RenameDialog({ target, onCancel, onConfirm }: {
  target: RenameTarget; onCancel: () => void; onConfirm: (value: string) => void
}): JSX.Element {
  const [value, setValue] = useState(target.value)
  const trimmed = value.trim()
  const dirty = trimmed.length > 0 && trimmed !== target.value
  const isBook = target.kind === 'book'
  return (
    <div className="rename-overlay" onClick={onCancel}>
      <div className="rename-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="rename-title">{isBook ? '自定义书名' : '重命名分类'}</div>
        <p className="rename-hint muted small">
          {isBook
            ? '改名后,「AI 整理书架」将保留你设定的名称,不再自动覆盖。'
            : '将重命名整个分类,该类下所有书一并归入新名称;「AI 整理书架」不再重新归类。'}
        </p>
        <input className="rename-input" value={value} autoFocus spellCheck={false}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && dirty) onConfirm(trimmed); if (e.key === 'Escape') onCancel() }}
        />
        <div className="rename-actions">
          <button className="ghost-btn" onClick={onCancel}>取消</button>
          <button className="primary-btn" disabled={!dirty} onClick={() => onConfirm(trimmed)}>保存</button>
        </div>
      </div>
    </div>
  )
}

/** 全局唯一的悬停信息卡 */
function HoverCard({ info, onMouseEnter, onMouseLeave, onOpen, onRename, onDelete, onRebuild }: {
  info: HoverInfo; onMouseEnter: () => void; onMouseLeave: () => void
  onOpen: (id: string) => void; onRename: (b: Book) => void; onDelete: (id: string) => void; onRebuild: (id: string) => void
}): JSX.Element {
  const { book: b, subject } = info
  const CARD_W = 240
  const GAP = 12
  const vw = window.innerWidth
  const vh = window.innerHeight
  const placeLeft = info.right + GAP + CARD_W > vw - 8
  const cardLeft = placeLeft ? info.left - GAP - CARD_W : info.right + GAP
  const midY = (info.top + info.bottom) / 2
  const EST_H = 150
  const style: CSSProperties = { left: Math.max(8, cardLeft), top: Math.max(12, Math.min(vh - EST_H - 12, midY - EST_H / 2)) }
  return (
    <div className={`spine-card ${placeLeft ? 'on-left' : 'on-right'}`} style={style} role="tooltip"
      onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave}>
      <div className="spine-card-title">{b.title}</div>
      <div className="spine-card-meta">
        <span className="spine-card-subject">{subject}</span>
        {b.pageCount > 0 && <span>· {b.pageCount} 页</span>}
        {b.hasScanned && <span>· 含扫描页</span>}
        {b.customTitle && <span>· 自定义名</span>}
      </div>
      <div className="spine-card-actions">
        <button className="spine-card-btn primary" onClick={() => onOpen(b.id)}>打开</button>
        <button className="spine-card-btn" onClick={() => onRename(b)}>✎ 改名</button>
        {b.status === 'ready' && (
          <button className="spine-card-btn" onClick={() => { if (confirm(`重建「${b.title}」的索引?`)) onRebuild(b.id) }}>↻ 重建索引</button>
        )}
        <button className="spine-card-btn danger" onClick={() => { if (confirm(`确定删除「${b.title}」?`)) onDelete(b.id) }}>删除</button>
      </div>
    </div>
  )
}

/** 一格书架 */
function Shelf({
  subject, items, isDragOver, onDragStart, onDragOver, onDrop, onDragLeave, onBookDrop, onOpen, onRenameSubject, onRemove, onHover, onLeave
}: {
  subject: string
  items: Book[]
  isDragOver: boolean
  onDragStart: (e: React.DragEvent) => void
  onDragOver: (e: React.DragEvent) => void
  onDrop: (e: React.DragEvent) => void
  onDragLeave: () => void
  onBookDrop: (e: React.DragEvent) => void
  onOpen: (id: string) => void
  onRenameSubject: (subject: string) => void
  onRemove?: (subject: string) => void
  onHover: (info: HoverInfo) => void
  onLeave: () => void
}): JSX.Element {
  const sh = hashId(subject)
  const isEmpty = items.length === 0
  const showVase = !isEmpty && sh % 5 >= 2
  const vase = VASES[(sh >> 3) % VASES.length]
  const [bookDragOver, setBookDragOver] = useState(false)
  return (
    <section
      className={`shelf-unit${isEmpty ? ' is-empty' : ''}${isDragOver ? ' drag-over-reorder' : ''}${bookDragOver ? ' drag-over' : ''}`}
      draggable
      onDragStart={onDragStart}
      onDragOver={(e) => { onDragOver(e); setBookDragOver(true) }}
      onDragLeave={() => { onDragLeave(); setBookDragOver(false) }}
      onDrop={(e) => { setBookDragOver(false); onDrop(e); onBookDrop(e) }}
    >
      <div className="shelf-tag" title="拖动可调整书架顺序">
        <span className="shelf-tag-name">{subject}</span>
        <span className="shelf-tag-count">{items.length} 本</span>
        <button className="shelf-tag-rename" title="重命名分类"
          onClick={(e) => { e.stopPropagation(); onRenameSubject(subject) }}>✎</button>
        {onRemove && (
          <button className="shelf-tag-remove" title="删除这个空书架"
            onClick={(e) => { e.stopPropagation(); onRemove(subject) }}>×</button>
        )}
      </div>
      <div className="shelf-row">
        <div className="shelf-books">
          {items.map((b) => (
            <BookSpine key={b.id} book={b} subject={subject} onOpen={onOpen} onHover={onHover} onLeave={onLeave} />
          ))}
          {isEmpty && <span className="shelf-empty-hint">把书拖到这里</span>}
          {showVase && <img className="shelf-vase" src={vase} alt="" aria-hidden="true" />}
        </div>
        <div className="shelf-plank" />
      </div>
    </section>
  )
}

/** 一本立着的书 */
function BookSpine({ book: b, subject, onOpen, onHover, onLeave }: {
  book: Book; subject: string; onOpen: (id: string) => void; onHover: (info: HoverInfo) => void; onLeave: () => void
}): JSX.Element {
  const h = hashId(b.id)
  const color = SPINE_COLORS[h % SPINE_COLORS.length]
  const len = b.title.length
  const base = 158 + (h % 4) * 7
  const height = Math.min(216, base + (len > 24 ? (len - 24) * 1.5 : 0))
  const width = (len > 34 ? 54 : len > 22 ? 48 : 42) + ((h >> 3) % 3) * 4
  const variant = h % 3
  const finish = (h >> 5) % 2 === 0 ? 'cloth' : 'leather'
  const ornaments = ['❖', '✦', '❧', '⁕', '◆', '✥']
  const ornament = ornaments[h % ornaments.length]
  const titleSize = len > 56 ? 9.5 : len > 42 ? 10.5 : len > 30 ? 11.5 : len > 20 ? 12.5 : 13.5

  const report = (el: HTMLElement) => {
    const r = el.getBoundingClientRect()
    onHover({ book: b, subject, left: r.left, right: r.right, top: r.top, bottom: r.bottom })
  }

  return (
    <div
      className={`book-spine v${variant} ${finish}`}
      style={{ height: `${height}px`, width: `${width}px`, ['--spine' as string]: color }}
      draggable
      onDragStart={(e) => { e.dataTransfer.setData('text/plain', b.id); e.dataTransfer.effectAllowed = 'move' }}
      onClick={() => onOpen(b.id)}
      onMouseEnter={(e) => report(e.currentTarget)}
      onMouseLeave={onLeave}
    >
      <span className="spine-grain" />
      <span className="spine-wear" />
      <span className="spine-sheen" />
      <span className="spine-cap top" />
      <span className="spine-headband" />
      <span className="spine-rule top" />
      <span className="spine-title" style={{ fontSize: `${titleSize}px` }}>{b.title}</span>
      <span className="spine-rule bottom" />
      <span className="spine-ornament">{ornament}</span>
      <span className="spine-pub" />
      <span className="spine-cap bottom" />
      {b.hasScanned && <span className="spine-dot" title="含扫描页" />}
    </div>
  )
}

/** 处理中的书 */
function ProcessingRow({ book: b, onCancel, onDelete }: {
  book: Book; onCancel: (id: string) => void; onDelete: (id: string) => void
}): JSX.Element {
  const isError = b.status === 'error'
  const pct = Math.min(100, Math.max(0, b.progress ?? 0))
  return (
    <div className={`proc-row ${isError ? 'error' : ''}`}>
      <span className="proc-icon">{isError ? '⚠' : '📖'}</span>
      <div className="proc-main">
        <div className="proc-line">
          <span className="proc-title" title={b.title}>{b.title}</span>
          <span className={`proc-badge ${isError ? 'err' : ''}`}>{STATUS_LABEL[b.status]}</span>
          {!isError && <span className="proc-pct">{pct}%</span>}
        </div>
        {isError ? (
          <div className="proc-err-text small">{b.error || '处理失败'}</div>
        ) : (
          <>
            <div className="proc-track"><div className="proc-fill" style={{ width: `${pct}%` }} /></div>
            {b.stage && <div className="proc-stage muted small">{b.stage}</div>}
          </>
        )}
      </div>
      {isError ? (
        <button className="proc-action" onClick={() => { if (confirm(`移除「${b.title}」?`)) onDelete(b.id) }}>移除</button>
      ) : (
        <button className="proc-action" onClick={() => { if (confirm(`取消导入「${b.title}」?`)) onCancel(b.id) }}>取消</button>
      )}
    </div>
  )
}
