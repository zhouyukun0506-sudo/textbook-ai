import { useMemo, useState, useCallback, useRef, useEffect } from 'react'
import type { CSSProperties } from 'react'
import type { Book, WeeklyStats, WidgetConfig, WidgetType, ShelfLayout } from '@shared/types'
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
  left: number // 书脊左边(视口坐标)
  right: number // 书脊右边(视口坐标)
  top: number // 书脊顶边(视口坐标)
  bottom: number // 书脊底边(视口坐标)
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
  layout: ShelfLayout[]
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
  onLayoutChange: (layout: ShelfLayout[]) => void
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

// ---- 画布几何:小组件和书架是同一块画布上的平级元素,共用这套碰撞/排位工具 ----
const SHELF_W = 400
const SHELF_H = 220
const CANVAS_GAP = 20

interface Rect {
  x: number
  y: number
  w: number
  h: number
}

function rectsOverlapXY(a: Rect, b: Rect): boolean {
  return !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y)
}

/** 给定一个矩形尺寸,从左到右、从上到下扫描,避让所有 occupied 障碍物,返回第一个不重叠的落点。
 *  碰到容器右边界就换行——这才是"靠边缘换行排版",而不是被某一区块的高度顶下去。 */
function findFreeSlot(w: number, h: number, occupied: Rect[], containerW: number): { x: number; y: number } {
  const stepX = 20
  const stepY = 20
  const maxX = Math.max(CANVAS_GAP, containerW - w - CANVAS_GAP)
  for (let y = CANVAS_GAP; ; y += stepY) {
    for (let x = CANVAS_GAP; x <= maxX; x += stepX) {
      const rect = { x, y, w, h }
      if (!occupied.some((o) => rectsOverlapXY(rect, o))) return { x, y }
    }
    // 行内放不下时,行高至少推进一个步长,避免死循环;上限由 y 自增天然兜底
    if (y > 100000) return { x: CANVAS_GAP, y: CANVAS_GAP }
  }
}


// 书脊布面色(做旧、低饱和,像老图书馆里晒褪了的布面/皮面精装),按书 id 稳定取色。
// 单色即可,明暗弧光由 CSS 叠加,避免生硬的双色渐变。
const SPINE_COLORS = [
  '#8a4f43', // 砖红褪色
  '#3f5566', // 灰蓝
  '#5c6647', // 橄榄
  '#6b5274', // 灰紫
  '#a07b46', // 赭黄
  '#46625c', // 松绿
  '#7d4f5c', // 酱玫
  '#3c4a63', // 黛蓝
  '#8a6239', // 焦糖
  '#566b4e', // 苔绿
  '#9a8350', // 亚麻金
  '#704a44' // 红褐
]

/** 用 id 生成稳定的伪随机数,让每本书的书脊颜色/高矮/宽窄固定且互不相同 */
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
  layout,
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
  onLayoutChange,
  onCustomShelvesChange,
  onRefreshBooks
}: Props): JSX.Element {
  // 处理中/出错的书单独拎出来(进度要清晰可见);其余 ready 的书上架
  const { processing, shelves } = useMemo(() => {
    const processing: Book[] = []
    const map = new Map<string, Book[]>()
    // 先建出用户手动添加的空书架(即使没书也要显示,作为拖书归类的落脚点)
    for (const name of customShelves) {
      const t = name.trim()
      if (t && !map.has(t)) map.set(t, [])
    }
    for (const b of books) {
      if (b.status !== 'ready') {
        processing.push(b)
        continue
      }
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

  // 悬停信息卡:全局只有一张,固定定位。书脊上报自己的位置,这里据此摆放。
  // 卡片本身可交互(含改名/删除按钮),故离开书脊时延时关闭,留出把鼠标移进卡片的时间。
  const [hover, setHover] = useState<HoverInfo | null>(null)
  const closeTimer = useRef<number | null>(null)
  const cancelClose = useCallback(() => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current)
      closeTimer.current = null
    }
  }, [])
  const handleHover = useCallback(
    (info: HoverInfo) => {
      cancelClose()
      setHover(info)
    },
    [cancelClose]
  )
  const handleLeave = useCallback(() => {
    cancelClose()
    closeTimer.current = window.setTimeout(() => setHover(null), 180)
  }, [cancelClose])

  // 重命名:既能改书名(book)也能改学科大类(subject),复用同一个弹窗
  const [renaming, setRenaming] = useState<RenameTarget | null>(null)
  // 顶部「添加」工具栏:默认收起,不占地方,点开才显示那排 + 按钮
  const [barOpen, setBarOpen] = useState(false)
  const handleRenameStart = useCallback((b: Book) => {
    setHover(null)
    setRenaming({ kind: 'book', id: b.id, value: b.title })
  }, [])
  const handleRenameSubject = useCallback((subject: string) => {
    setRenaming({ kind: 'subject', value: subject })
  }, [])

  // ---- 添加空白书架 ----
  // 书架本来从书的 subject 派生,没有书的分类不显示。这里让用户像加小组件一样手动建空书架,
  // 拖错书时可以把书拖回来重新归类。名字用「新书架 / 新书架 2 / …」自动避重。
  const customShelvesRef = useRef<string[]>(customShelves)
  useEffect(() => {
    customShelvesRef.current = customShelves
  }, [customShelves])

  const addShelf = useCallback(() => {
    // 已存在的全部书架名(含有书的派生书架 + 已建空书架),用于生成不重名的新名字
    const taken = new Set<string>()
    for (const [name] of shelves) taken.add(name)
    for (const name of customShelvesRef.current) taken.add(name.trim())
    let name = '新书架'
    let n = 2
    while (taken.has(name)) {
      name = `新书架 ${n}`
      n++
    }
    const next = [...customShelvesRef.current, name]
    customShelvesRef.current = next
    onCustomShelvesChange(next)
    void window.api.saveCustomShelves(next)
  }, [shelves, onCustomShelvesChange])

  // 删除空书架(仅对没有书的书架开放,避免误删导致书无处归类)
  const removeShelf = useCallback(
    (subject: string) => {
      const next = customShelvesRef.current.filter((s) => s.trim() !== subject)
      customShelvesRef.current = next
      onCustomShelvesChange(next)
      void window.api.saveCustomShelves(next)
    },
    [onCustomShelvesChange]
  )

  // 重命名书架时,同步更新空书架名单(把旧名替换成新名),保证空书架改名后不丢失
  const renameCustomShelf = useCallback(
    (from: string, to: string) => {
      const list = customShelvesRef.current
      if (!list.includes(from)) return
      const next = list.map((s) => (s === from ? to : s))
      customShelvesRef.current = next
      onCustomShelvesChange(next)
      void window.api.saveCustomShelves(next)
    },
    [onCustomShelvesChange]
  )

  // 书架布局以 subject 名为键,改名后要把坐标一起迁移,否则改名后书架会回到默认位置
  const layoutRef = useRef<ShelfLayout[]>(layout)
  useEffect(() => {
    layoutRef.current = layout
  }, [layout])
  const migrateLayoutKey = useCallback(
    (from: string, to: string) => {
      const list = layoutRef.current
      if (!list.some((l) => l.subject === from)) return
      const next = list.map((l) => (l.subject === from ? { ...l, subject: to } : l))
      layoutRef.current = next
      onLayoutChange(next)
      void window.api.saveShelfLayout(next)
    },
    [onLayoutChange]
  )

  // ---- 拖拽书架 ----
  const desktopRef = useRef<HTMLDivElement>(null)
  const draggingRef = useRef<{
    subject: string
    startX: number
    startY: number
    el: HTMLElement
    handle: HTMLElement
    startLeft: number
    startTop: number
  } | null>(null)
  const desktopWidth = useMemo(() => {
    const shelfRight = layout.length ? Math.max(...layout.map((l) => l.x + SHELF_W)) : 0
    const widgetRight = widgets.length
      ? Math.max(...widgets.map((w) => (w.x ?? 0) + (w.width ?? 320)))
      : 0
    const maxRight = Math.max(shelfRight, widgetRight) + CANVAS_GAP * 2
    if (maxRight <= CANVAS_GAP * 2) return '100%'
    return Math.max(maxRight, 800)
  }, [layout, widgets])

  /** 无网格自由碰撞:先尝试原始位置,重叠则以精细螺旋搜索找最近不重叠点。
   *  obstacles 是画布上所有其它元素(书架 + 小组件)的矩形,实现两者平级避让。 */
  function resolveCollision(x: number, y: number, obstacles: Rect[], w = SHELF_W, h = SHELF_H): { x: number; y: number } {
    // 快速路径:没碰撞直接返回
    const meExact = { x, y, w, h }
    if (!obstacles.some((o) => rectsOverlapXY(meExact, o))) {
      return { x: Math.round(x), y: Math.round(y) }
    }

    // 精细螺旋搜索:从释放点向外一圈圈找最近的不重叠位置
    const step = 15
    const maxSearch = Math.max(w, h) * 3

    for (let radius = step; radius <= maxSearch; radius += step) {
      const points = Math.max(12, Math.floor((2 * Math.PI * radius) / step))
      for (let i = 0; i < points; i++) {
        const angle = (i / points) * Math.PI * 2
        const cx = x + Math.cos(angle) * radius
        const cy = y + Math.sin(angle) * radius
        if (cx < 0 || cy < 0) continue
        const test = { x: cx, y: cy, w, h }
        if (!obstacles.some((o) => rectsOverlapXY(test, o))) {
          return { x: Math.round(cx), y: Math.round(cy) }
        }
      }
    }

    // 兜底:gentle 推斥,小步长慢慢挤开
    let cx = x
    let cy = y
    for (let i = 0; i < 80; i++) {
      const test = { x: cx, y: cy, w, h }
      const colliders = obstacles.filter((o) => rectsOverlapXY(test, o))
      if (colliders.length === 0) break
      let dx = 0
      let dy = 0
      for (const c of colliders) {
        dx += cx - c.x
        dy += cy - c.y
      }
      const dist = Math.sqrt(dx * dx + dy * dy) || 1
      cx += (dx / dist) * step
      cy += (dy / dist) * step
    }

    return { x: Math.round(Math.max(0, cx)), y: Math.round(Math.max(0, cy)) }
  }

  const handleShelfDragStart = useCallback(
    (e: React.PointerEvent, subject: string) => {
      // 点在按钮上(✎ 改名 / × 删空书架)不启动拖拽,否则 setPointerCapture 会吞掉按钮的 click
      if ((e.target as HTMLElement).closest('button')) return
      const handle = e.currentTarget as HTMLElement
      const el = handle.closest('.shelf-unit') as HTMLElement | null
      const desktop = desktopRef.current
      if (!el || !desktop) return
      e.preventDefault()
      e.stopPropagation()
      handle.setPointerCapture(e.pointerId)
      // 记录拖拽起点
      const desktopRect = desktop.getBoundingClientRect()
      const elRect = el.getBoundingClientRect()
      const startLeft = elRect.left - desktopRect.left
      const startTop = elRect.top - desktopRect.top
      draggingRef.current = {
        subject,
        startX: e.clientX,
        startY: e.clientY,
        el,
        handle,
        startLeft,
        startTop,
      }
      dragPosRef.current = { subject, x: startLeft, y: startTop }
    },
    [layout]
  )

  useEffect(() => {
    const onMove = (ev: PointerEvent) => {
      const drag = draggingRef.current
      if (!drag) return
      const dx = ev.clientX - drag.startX
      const dy = ev.clientY - drag.startY
      // 实时更新拖拽坐标，用 z-index 直接改变渲染位置
      const nx = drag.startLeft + dx
      const ny = drag.startTop + dy
      drag.el.style.zIndex = '1000'
      drag.el.style.left = `${nx}px`
      drag.el.style.top = `${ny}px`
      dragPosRef.current = { subject: drag.subject, x: nx, y: ny }
    }
    const onUp = (ev: PointerEvent) => {
      const drag = draggingRef.current
      if (!drag) return
      drag.handle.releasePointerCapture(ev.pointerId)

      // 直接算 desktop 内部坐标：原始位置 + 拖拽偏移
      const dx = ev.clientX - drag.startX
      const dy = ev.clientY - drag.startY
      const rawX = drag.startLeft + dx
      const rawY = drag.startTop + dy

      const resolved = resolveCollision(rawX, rawY, [
        // 障碍物 = 其它书架 + 所有小组件(两者平级避让)
        ...layout.filter((l) => l.subject !== drag.subject).map((l) => ({ x: l.x, y: l.y, w: SHELF_W, h: SHELF_H })),
        ...widgetsRef.current.map((w) => ({ x: w.x ?? 0, y: w.y ?? 0, w: w.width ?? 320, h: w.height ?? 200 }))
      ])
      const placed = { subject: drag.subject, x: resolved.x, y: resolved.y }
      // upsert:已有则更新,没有(比如刚拖的是个还没进 layout 的新书架)则追加,避免松手后弹回默认位
      const next = layout.some((l) => l.subject === drag.subject)
        ? layout.map((l) => (l.subject === drag.subject ? placed : l))
        : [...layout, placed]
      onLayoutChange(next)
      void window.api.saveShelfLayout(next)

      // 清除拖拽态
      drag.el.style.zIndex = ''
      dragPosRef.current = null
      draggingRef.current = null
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [layout, onLayoutChange])

  const handleBookDrop = useCallback(
    async (e: React.DragEvent, subject: string) => {
      e.preventDefault()
      const bookId = e.dataTransfer.getData('text/plain')
      if (!bookId) return
      await window.api.updateBookSubject(bookId, subject)
      await onRefreshBooks()
    },
    [onRefreshBooks]
  )

  // 小组件状态快照(供拖拽/缩放回调读取最新值,避免闭包过期)
  const widgetsRef = useRef<WidgetConfig[]>(widgets)
  useEffect(() => { widgetsRef.current = widgets }, [widgets])

  const removeWidget = useCallback(
    (id: string) => {
      const next = widgetsRef.current.filter((w) => w.id !== id)
      widgetsRef.current = next
      onWidgetsChange(next)
      void window.api.saveWidgets(next)
    },
    [onWidgetsChange]
  )

  const addWidget = useCallback(
    (type: WidgetType) => {
      // 每类组件给一个合适的初始尺寸,避免番茄钟/总览这种内容比例不同的被塞进通用 320×200
      const DEFAULT_SIZE: Record<WidgetType, { width: number; height: number }> = {
        weekly: { width: 360, height: 210 },
        heatmap: { width: 340, height: 200 },
        streak: { width: 240, height: 200 },
        'import-progress': { width: 320, height: 220 },
        pomodoro: { width: 260, height: 230 },
        'library-overview': { width: 320, height: 230 }
      }
      const sz = DEFAULT_SIZE[type] ?? { width: 320, height: 200 }
      // 新组件落在画布上第一个空位:避让所有已有小组件 + 书架(扫描换行,不是固定偏移)
      const containerW = Math.max(800, (typeof window !== 'undefined' ? window.innerWidth : 1200) - 120)
      const obstacles: Rect[] = [
        ...widgetsRef.current.map((w) => ({ x: w.x ?? 0, y: w.y ?? 0, w: w.width ?? 320, h: w.height ?? 200 })),
        ...layoutRef.current.map((l) => ({ x: l.x, y: l.y, w: SHELF_W, h: SHELF_H }))
      ]
      const spot = findFreeSlot(sz.width, sz.height, obstacles, containerW)
      const next = [
        ...widgetsRef.current,
        { id: `w-${Date.now()}`, type, width: sz.width, height: sz.height, x: spot.x, y: spot.y }
      ]
      widgetsRef.current = next
      onWidgetsChange(next)
      void window.api.saveWidgets(next)
    },
    [onWidgetsChange]
  )

  // ---- 拖拽小组件(复用书架那套 pointer 拖拽:抓 header 实时移动,松手写回坐标) ----
  // 小组件和书架共用同一块画布(desktopRef),坐标系一致,才能平级避让。
  const widgetDragRef = useRef<{
    id: string
    startX: number
    startY: number
    el: HTMLElement
    handle: HTMLElement
    startLeft: number
    startTop: number
  } | null>(null)

  const handleWidgetDragStart = useCallback((e: React.PointerEvent, id: string) => {
    // resize 手柄在右下角,从那里按下不当作拖拽(让浏览器原生 resize 生效)
    const handle = e.currentTarget as HTMLElement
    const el = handle.closest('.widget-col') as HTMLElement | null
    const desk = desktopRef.current
    if (!el || !desk) return
    e.preventDefault()
    e.stopPropagation()
    handle.setPointerCapture(e.pointerId)
    const deskRect = desk.getBoundingClientRect()
    const elRect = el.getBoundingClientRect()
    widgetDragRef.current = {
      id,
      startX: e.clientX,
      startY: e.clientY,
      el,
      handle,
      startLeft: elRect.left - deskRect.left,
      startTop: elRect.top - deskRect.top
    }
  }, [])

  useEffect(() => {
    const onMove = (ev: PointerEvent) => {
      const drag = widgetDragRef.current
      if (!drag) return
      const nx = Math.max(0, drag.startLeft + (ev.clientX - drag.startX))
      const ny = Math.max(0, drag.startTop + (ev.clientY - drag.startY))
      drag.el.style.zIndex = '1000'
      drag.el.style.left = `${nx}px`
      drag.el.style.top = `${ny}px`
    }
    const onUp = (ev: PointerEvent) => {
      const drag = widgetDragRef.current
      if (!drag) return
      try { drag.handle.releasePointerCapture(ev.pointerId) } catch { /* ignore */ }
      const rawX = Math.max(0, drag.startLeft + (ev.clientX - drag.startX))
      const rawY = Math.max(0, drag.startTop + (ev.clientY - drag.startY))
      const me = widgetsRef.current.find((w) => w.id === drag.id)
      const myW = me?.width ?? 320
      const myH = me?.height ?? 200
      // 障碍物 = 其它小组件 + 所有书架(两者平级避让)
      const resolved = resolveCollision(rawX, rawY, [
        ...widgetsRef.current.filter((w) => w.id !== drag.id).map((w) => ({ x: w.x ?? 0, y: w.y ?? 0, w: w.width ?? 320, h: w.height ?? 200 })),
        ...layoutRef.current.map((l) => ({ x: l.x, y: l.y, w: SHELF_W, h: SHELF_H }))
      ], myW, myH)
      const next = widgetsRef.current.map((w) => (w.id === drag.id ? { ...w, x: resolved.x, y: resolved.y } : w))
      widgetsRef.current = next
      onWidgetsChange(next)
      void window.api.saveWidgets(next)
      drag.el.style.zIndex = ''
      widgetDragRef.current = null
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [onWidgetsChange])

  // ---- 缩放小组件:右下角自定义手柄(取代旧 CSS resize + ResizeObserver,
  //      旧方案有 content-box 漂移/observer 泄漏/防抖丢失三个 bug,会导致切页面后尺寸回弹) ----
  const WIDGET_MIN_W = 200
  const WIDGET_MIN_H = 140
  const WIDGET_MAX_W = 760
  const WIDGET_MAX_H = 560
  const widgetResizeRef = useRef<{
    id: string
    startX: number
    startY: number
    el: HTMLElement
    handle: HTMLElement
    startW: number
    startH: number
  } | null>(null)

  const handleWidgetResizeStart = useCallback((e: React.PointerEvent, id: string) => {
    const handle = e.currentTarget as HTMLElement
    const el = handle.closest('.widget-col') as HTMLElement | null
    if (!el) return
    e.preventDefault()
    e.stopPropagation()
    handle.setPointerCapture(e.pointerId)
    const rect = el.getBoundingClientRect()
    widgetResizeRef.current = {
      id,
      startX: e.clientX,
      startY: e.clientY,
      el,
      handle,
      startW: rect.width,
      startH: rect.height
    }
  }, [])

  useEffect(() => {
    const clampW = (w: number): number => Math.max(WIDGET_MIN_W, Math.min(WIDGET_MAX_W, w))
    const clampH = (h: number): number => Math.max(WIDGET_MIN_H, Math.min(WIDGET_MAX_H, h))
    const onMove = (ev: PointerEvent): void => {
      const rz = widgetResizeRef.current
      if (!rz) return
      const w = clampW(rz.startW + (ev.clientX - rz.startX))
      const h = clampH(rz.startH + (ev.clientY - rz.startY))
      rz.el.style.width = `${w}px`
      rz.el.style.height = `${h}px`
    }
    const onUp = (ev: PointerEvent): void => {
      const rz = widgetResizeRef.current
      if (!rz) return
      try { rz.handle.releasePointerCapture(ev.pointerId) } catch { /* ignore */ }
      const w = Math.round(clampW(rz.startW + (ev.clientX - rz.startX)))
      const h = Math.round(clampH(rz.startH + (ev.clientY - rz.startY)))
      const next = widgetsRef.current.map((x) => (x.id === rz.id ? { ...x, width: w, height: h } : x))
      widgetsRef.current = next
      onWidgetsChange(next)
      void window.api.saveWidgets(next) // 立即落盘,切页面不会回弹
      widgetResizeRef.current = null
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [onWidgetsChange])
  // 小组件位置:有坐标用坐标,旧数据没坐标的临时给个默认(store 现在默认会带坐标)
  const widgetPositions = useMemo(() => {
    const map = new Map<string, { x: number; y: number }>()
    let flowX = CANVAS_GAP
    for (const w of widgets) {
      if (typeof w.x === 'number' && typeof w.y === 'number') {
        map.set(w.id, { x: w.x, y: w.y })
      } else {
        map.set(w.id, { x: flowX, y: CANVAS_GAP })
        flowX += (w.width ?? 320) + 16
      }
    }
    return map
  }, [widgets])

  const renderWidget = useCallback(
    (w: WidgetConfig) => {
      switch (w.type) {
        case 'weekly':
          return <WeeklyReport stats={weeklyStats} />
        case 'heatmap':
          return <HeatmapWidget stats={weeklyStats} />
        case 'streak':
          return <StreakWidget stats={weeklyStats} />
        case 'import-progress':
          return <ImportProgressWidget processing={processing} />
        case 'pomodoro':
          return <PomodoroWidget pomodoro={pomodoro} />
        case 'library-overview':
          return <LibraryOverviewWidget books={books} />
        default:
          return null
      }
    },
    [weeklyStats, processing, pomodoro, books]
  )

  // 稳定布局:已有坐标的书架保持原位;新书架在整块画布上找第一个空位,
  // 避让所有已存在的书架 + 小组件(两者平级,靠扫描换行排版,不再被某一区块的高度顶下去)。
  const effectiveLayout = useMemo(() => {
    const containerW = Math.max(800, (typeof window !== 'undefined' ? window.innerWidth : 1200) - 120)
    const present = new Set(shelves.map(([s]) => s))
    // 保留已有(仍存在的)书架坐标,顺序不变
    const acc: ShelfLayout[] = layout.filter((l) => present.has(l.subject))
    const have = new Set(acc.map((l) => l.subject))
    // 小组件是画布上的固定障碍物
    const widgetRects: Rect[] = widgets.map((w) => {
      const pos = widgetPositions.get(w.id) ?? { x: 0, y: 0 }
      return { x: pos.x, y: pos.y, w: w.width ?? 320, h: w.height ?? 200 }
    })
    for (const [subject] of shelves) {
      if (have.has(subject)) continue
      const obstacles: Rect[] = [
        ...acc.map((l) => ({ x: l.x, y: l.y, w: SHELF_W, h: SHELF_H })),
        ...widgetRects
      ]
      const pos = findFreeSlot(SHELF_W, SHELF_H, obstacles, containerW)
      acc.push({ subject, x: pos.x, y: pos.y })
    }
    return acc
  }, [layout, shelves, widgets, widgetPositions])

  // 把稳定布局持久化:仅当与当前 layout 不同(新增/删除书架)时写回,避免无限循环
  useEffect(() => {
    const same =
      effectiveLayout.length === layout.length &&
      effectiveLayout.every(
        (l, i) => layout[i] && layout[i].subject === l.subject && layout[i].x === l.x && layout[i].y === l.y
      )
    if (same) return
    onLayoutChange(effectiveLayout)
    void window.api.saveShelfLayout(effectiveLayout)
  }, [effectiveLayout, layout, onLayoutChange])

  // 拖拽中的位置快照（CSS transform 渲染用，不写入 layout）
  const dragPosRef = useRef<{ subject: string; x: number; y: number } | null>(null)

  // 整块画布的高度:取所有元素(小组件 + 书架)的最低底边 + 余量。
  // 关键改动:书架的可达 Y 不再被小组件区高度顶住,两者在同一坐标系里平级。
  const canvasHeight = useMemo(() => {
    let maxBottom = 0
    for (const w of widgets) {
      const pos = widgetPositions.get(w.id) ?? { x: 0, y: 0 }
      maxBottom = Math.max(maxBottom, pos.y + (w.height ?? 200))
    }
    for (const l of effectiveLayout) {
      maxBottom = Math.max(maxBottom, l.y + SHELF_H)
    }
    return Math.max(600, maxBottom + 40)
  }, [widgets, widgetPositions, effectiveLayout])

  return (
    <div className="library">
      <div className="library-header">
        <div>
          <h1>我的书架</h1>
          <p className="subtitle">导入英文原版,以母语研读,与原文相对而坐。</p>
        </div>
        <div className="library-actions">
          {books.length > 0 && (
            <button
              className="ghost-btn"
              disabled={!canOrganize || organizing}
              title={!hasKey ? '需先在设置中配置 API' : '让 AI 按学科整理并优化书名'}
              onClick={onOrganize}
            >
              {organizing ? '整理中…' : '✦ AI 整理书架'}
            </button>
          )}
          <button className="primary-btn" onClick={onImport}>
            ＋ 导入文件
          </button>
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
            <button
              className="widget-bar-toggle"
              onClick={() => setBarOpen((v) => !v)}
              title={barOpen ? '收起' : '添加面板或书架'}
            >
              <span className="widget-bar-caret">{barOpen ? '▾' : '▸'}</span>
              添加
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
                <button className="widget-config-btn" onClick={addShelf} title="新建一个空书架,可把书拖进来重新归类">
                  + 空书架
                </button>
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
          {/* 单一画布:小组件和书架都是这里的绝对定位子元素,平级摆放、平级避让 */}
          <div
            className="bookcase-desktop"
            ref={desktopRef}
            style={{
              minWidth: typeof desktopWidth === 'number' ? `${desktopWidth}px` : desktopWidth,
              height: canvasHeight
            }}
          >
            {widgets.map((w) => {
              const pos = widgetPositions.get(w.id) ?? { x: CANVAS_GAP, y: CANVAS_GAP }
              return (
                <div
                  key={w.id}
                  className="widget-col"
                  style={{ width: w.width, height: w.height, left: pos.x, top: pos.y }}
                >
                  <div
                    className="widget-header"
                    onPointerDown={(e) => handleWidgetDragStart(e, w.id)}
                    title="拖动摆放"
                  >
                    <span className="widget-grip" aria-hidden="true">⠿</span>
                    <button
                      className="widget-close-btn"
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={() => removeWidget(w.id)}
                      title="移除"
                    >
                      ×
                    </button>
                  </div>
                  {renderWidget(w)}
                  <span
                    className="widget-resize-handle"
                    onPointerDown={(e) => handleWidgetResizeStart(e, w.id)}
                    title="拖动缩放"
                    aria-hidden="true"
                  />
                </div>
              )
            })}
            {shelves.map(([subject, items]) => {
              const pos = layout.find((l) => l.subject === subject) ?? effectiveLayout.find((l) => l.subject === subject)
              const x = pos?.x ?? CANVAS_GAP
              const y = pos?.y ?? CANVAS_GAP
              return (
                <Shelf
                  key={subject}
                  subject={subject}
                  items={items}
                  style={{ left: x, top: y }}
                  onPointerDown={(e) => handleShelfDragStart(e, subject)}
                  onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move' }}
                  onDrop={(e) => { void handleBookDrop(e, subject) }}
                  onOpen={onOpen}
                  onRenameSubject={handleRenameSubject}
                  onRemove={items.length === 0 ? removeShelf : undefined}
                  onHover={handleHover}
                  onLeave={handleLeave}
                />
              )
            })}
          </div>
        </>
      )}

      {hover && (
        <HoverCard
          info={hover}
          onMouseEnter={cancelClose}
          onMouseLeave={handleLeave}
          onRename={(b) => {
            cancelClose()
            setHover(null)
            handleRenameStart(b)
          }}
          onDelete={(id) => {
            cancelClose()
            setHover(null)
            onDelete(id)
          }}
          onRebuild={(id) => {
            cancelClose()
            setHover(null)
            onRebuild(id)
          }}
          onOpen={(id) => {
            cancelClose()
            setHover(null)
            onOpen(id)
          }}
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
            if (target.kind === 'book') {
              await onRename(target.id, next)
            } else {
              // 空书架(无书)由前端的 customShelves 名单管理;有书的分类走后端 renameSubject。
              // 两者都更新一次,保证空书架改名后仍在,且 layout 里的坐标键也跟着迁移。
              renameCustomShelf(target.value, next)
              migrateLayoutKey(target.value, next)
              await onRenameSubject(target.value, next)
            }
          }}
        />
      )}
    </div>
  )
}

/** 重命名弹窗:书名 / 学科大类共用,Electron 无 window.prompt 故自建。 */
function RenameDialog({
  target,
  onCancel,
  onConfirm
}: {
  target: RenameTarget
  onCancel: () => void
  onConfirm: (value: string) => void
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
        <input
          className="rename-input"
          value={value}
          autoFocus
          spellCheck={false}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && dirty) onConfirm(trimmed)
            if (e.key === 'Escape') onCancel()
          }}
        />
        <div className="rename-actions">
          <button className="ghost-btn" onClick={onCancel}>
            取消
          </button>
          <button className="primary-btn" disabled={!dirty} onClick={() => onConfirm(trimmed)}>
            保存
          </button>
        </div>
      </div>
    </div>
  )
}

/** 全局唯一的悬停信息卡:固定定位在被悬停书脊旁,卡片本身可交互(含打开/改名/删除)。 */
function HoverCard({
  info,
  onMouseEnter,
  onMouseLeave,
  onOpen,
  onRename,
  onDelete,
  onRebuild
}: {
  info: HoverInfo
  onMouseEnter: () => void
  onMouseLeave: () => void
  onOpen: (id: string) => void
  onRename: (b: Book) => void
  onDelete: (id: string) => void
  onRebuild: (id: string) => void
}): JSX.Element {
  const { book: b, subject } = info
  const CARD_W = 240
  const GAP = 12
  // 卡片贴在书脊【侧边】弹出,绝不盖住上方的分类标题(✎ 始终可点)。
  // 默认放右侧;右侧空间不够则翻到左侧。竖直方向以书脊中线为锚,夹在视口内。
  const vw = window.innerWidth
  const vh = window.innerHeight
  const placeLeft = info.right + GAP + CARD_W > vw - 8
  const cardLeft = placeLeft ? info.left - GAP - CARD_W : info.right + GAP
  const midY = (info.top + info.bottom) / 2
  // 估算卡高用于竖直夹取(标题最多两行 + meta + 按钮 ≈ 150)
  const EST_H = 150
  const cardTop = Math.max(12, Math.min(vh - EST_H - 12, midY - EST_H / 2))
  const style: CSSProperties = {
    left: Math.max(8, cardLeft),
    top: cardTop
  }
  return (
    <div
      className={`spine-card ${placeLeft ? 'on-left' : 'on-right'}`}
      style={style}
      role="tooltip"
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <div className="spine-card-title">{b.title}</div>
      <div className="spine-card-meta">
        <span className="spine-card-subject">{subject}</span>
        {b.pageCount > 0 && <span>· {b.pageCount} 页</span>}
        {b.hasScanned && <span>· 含扫描页</span>}
        {b.customTitle && <span>· 自定义名</span>}
      </div>
      <div className="spine-card-actions">
        <button className="spine-card-btn primary" onClick={() => onOpen(b.id)}>
          打开
        </button>
        <button className="spine-card-btn" onClick={() => onRename(b)}>
          ✎ 改名
        </button>
        {b.status === 'ready' && (
          <button
            className="spine-card-btn"
            onClick={() => {
              if (confirm(`重建「${b.title}」的索引?这会删除旧索引并重新解析。`)) onRebuild(b.id)
            }}
          >
            ↻ 重建索引
          </button>
        )}
        <button
          className="spine-card-btn danger"
          onClick={() => {
            if (confirm(`确定删除「${b.title}」?该书的解析与对话记录会一并删除。`)) onDelete(b.id)
          }}
        >
          删除
        </button>
      </div>
    </div>
  )
}

/** 一格书架:学科标题 + 立着的书(单排,放不下横向滚动)+ 底部隔板 + 文艺装饰 */
function Shelf({
  subject,
  items,
  style,
  onPointerDown,
  onDragOver,
  onDrop,
  onOpen,
  onRenameSubject,
  onRemove,
  onHover,
  onLeave
}: {
  subject: string
  items: Book[]
  style?: React.CSSProperties
  onPointerDown?: (e: React.PointerEvent) => void
  onDragOver?: (e: React.DragEvent) => void
  onDrop?: (e: React.DragEvent) => void
  onOpen: (id: string) => void
  onRenameSubject: (subject: string) => void
  /** 仅空书架可删;有书的书架不传,避免误删导致书无处归类 */
  onRemove?: (subject: string) => void
  onHover: (info: HoverInfo) => void
  onLeave: () => void
}): JSX.Element {
  // 随机点缀:约一半书架在书堆末尾摆一个手绘花瓶(立在书架上),按学科名稳定选择
  const sh = hashId(subject)
  const isEmpty = items.length === 0
  const showVase = !isEmpty && sh % 5 >= 2 // ~60% 的书架有花瓶,留白更自然(空书架不摆,让提示更清楚)
  const vase = VASES[(sh >> 3) % VASES.length]
  const [dragOver, setDragOver] = useState(false)
  return (
    <section
      className={`shelf-unit${isEmpty ? ' is-empty' : ''}${dragOver ? ' drag-over' : ''}`}
      style={style}
      onDragOver={(e) => {
        onDragOver?.(e)
        setDragOver(true)
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        setDragOver(false)
        onDrop?.(e)
      }}
    >
      <div className="shelf-tag" onPointerDown={onPointerDown} title="拖动移动书架">
        <span className="shelf-tag-name">{subject}</span>
        <span className="shelf-tag-count">{items.length} 本</span>
        <button
          className="shelf-tag-rename"
          title="重命名分类"
          onClick={(e) => { e.stopPropagation(); onRenameSubject(subject) }}
        >
          ✎
        </button>
        {onRemove && (
          <button
            className="shelf-tag-remove"
            title="删除这个空书架"
            onClick={(e) => { e.stopPropagation(); onRemove(subject) }}
          >
            ×
          </button>
        )}
      </div>
      <div className="shelf-row">
        <div className="shelf-books">
          {items.map((b) => (
            <BookSpine
              key={b.id}
              book={b}
              subject={subject}
              onOpen={onOpen}
              onHover={onHover}
              onLeave={onLeave}
            />
          ))}
          {/* 空书架给出明确提示:把书拖进来即可归类到这里 */}
          {isEmpty && <span className="shelf-empty-hint">把书拖到这里</span>}
          {/* 手绘花瓶:排在书堆末尾、立在隔板上的摆件(占位撑开行宽,不与书重叠) */}
          {showVase && (
            <img className="shelf-vase" src={vase} alt="" aria-hidden="true" />
          )}
        </div>
        <div className="shelf-plank" />
      </div>
    </section>
  )
}

/** 一本立着的书:单色布面书脊,高矮/宽窄/配色按 id 稳定变化,竖排书名 */
function BookSpine({
  book: b,
  subject,
  onOpen,
  onHover,
  onLeave
}: {
  book: Book
  subject: string
  onOpen: (id: string) => void
  onHover: (info: HoverInfo) => void
  onLeave: () => void
}): JSX.Element {
  const h = hashId(b.id)
  const color = SPINE_COLORS[h % SPINE_COLORS.length]
  const len = b.title.length
  // 书名越长,书脊越高、越宽;基础高矮范围缩小,视觉上更和谐
  const base = 158 + (h % 4) * 7 // 158~179px 基础高矮错落(范围更集中)
  const height = Math.min(216, base + (len > 24 ? (len - 24) * 1.5 : 0)) // 长名加高,封顶 216
  const width = (len > 34 ? 54 : len > 22 ? 48 : 42) + ((h >> 3) % 3) * 4 // 长名更宽,容纳更多列
  const variant = h % 3 // 0 烫金双线框 / 1 凹陷书名框 / 2 简洁单线
  const finish = (h >> 5) % 2 === 0 ? 'cloth' : 'leather' // 布面 / 皮面,纹理不同
  const ornaments = ['❖', '✦', '❧', '⁕', '◆', '✥'] // 书脊下方的烫金小花饰
  const ornament = ornaments[h % ornaments.length]
  // 书名长度自适应字号:长书名用更小的字,尽量在书脊里多显示
  const titleSize = len > 56 ? 9.5 : len > 42 ? 10.5 : len > 30 ? 11.5 : len > 20 ? 12.5 : 13.5

  const report = (el: HTMLElement): void => {
    const r = el.getBoundingClientRect()
    onHover({ book: b, subject, left: r.left, right: r.right, top: r.top, bottom: r.bottom })
  }

  return (
    <div
      className={`book-spine v${variant} ${finish}`}
      style={{
        height: `${height}px`,
        width: `${width}px`,
        ['--spine' as string]: color
      }}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', b.id)
        e.dataTransfer.effectAllowed = 'move'
      }}
      onClick={() => onOpen(b.id)}
      onMouseEnter={(e) => report(e.currentTarget)}
      onMouseLeave={onLeave}
    >
      {/* 纹理与做旧叠层 */}
      <span className="spine-grain" />
      <span className="spine-wear" />
      <span className="spine-sheen" />
      {/* 顶/底封口 + 绒头带(保留顶部金色绒头带) */}
      <span className="spine-cap top" />
      <span className="spine-headband" />
      {/* 烫金书名框 + 竖排书名 */}
      <span className="spine-rule top" />
      <span className="spine-title" style={{ fontSize: `${titleSize}px` }}>
        {b.title}
      </span>
      <span className="spine-rule bottom" />
      {/* 中部花饰 */}
      <span className="spine-ornament">{ornament}</span>
      {/* 底部出版社徽标 */}
      <span className="spine-pub" />
      <span className="spine-cap bottom" />
      {b.hasScanned && <span className="spine-dot" title="含扫描页" />}
    </div>
  )
}

/** 处理中的书:一行一条大进度条 + 阶段文字 + 百分比,状态一目了然 */
function ProcessingRow({
  book: b,
  onCancel,
  onDelete
}: {
  book: Book
  onCancel: (id: string) => void
  onDelete: (id: string) => void
}): JSX.Element {
  const isError = b.status === 'error'
  const pct = Math.min(100, Math.max(0, b.progress ?? 0))
  return (
    <div className={`proc-row ${isError ? 'error' : ''}`}>
      <span className="proc-icon">{isError ? '⚠' : '📖'}</span>
      <div className="proc-main">
        <div className="proc-line">
          <span className="proc-title" title={b.title}>
            {b.title}
          </span>
          <span className={`proc-badge ${isError ? 'err' : ''}`}>{STATUS_LABEL[b.status]}</span>
          {!isError && <span className="proc-pct">{pct}%</span>}
        </div>
        {isError ? (
          <div className="proc-err-text small">{b.error || '处理失败'}</div>
        ) : (
          <>
            <div className="proc-track">
              <div className="proc-fill" style={{ width: `${pct}%` }} />
            </div>
            {b.stage && <div className="proc-stage muted small">{b.stage}</div>}
          </>
        )}
      </div>
      {isError ? (
        <button
          className="proc-action"
          title="移除"
          onClick={() => {
            if (confirm(`移除「${b.title}」?`)) onDelete(b.id)
          }}
        >
          移除
        </button>
      ) : (
        <button
          className="proc-action"
          title="取消导入"
          onClick={() => {
            if (confirm(`取消导入「${b.title}」?已处理的进度将丢弃。`)) onCancel(b.id)
          }}
        >
          取消
        </button>
      )}
    </div>
  )
}


