// Sidebar drag-to-resize (#182, #260). Pure width rules plus a small pointer
// controller so the drag lifecycle is testable without a DOM.

export const SIDEBAR_WIDTH_KEY = 'yitan-skillhub.sidebar-width.v1'
export const SIDEBAR_DEFAULT_WIDTH = 250
export const SIDEBAR_MIN_WIDTH = 220
export const SIDEBAR_MAX_WIDTH = 320
export const SIDEBAR_KEY_STEP = 8
/**
 * Width the workspace keeps beside the sidebar: the compact directory column
 * (`.app-main` clamp starts at 360px) plus a usable detail pane. At the 1000px
 * minimum window this caps the sidebar at 280px.
 */
export const SIDEBAR_CONTENT_RESERVE = 720

export type SidebarBounds = { min: number; max: number }

/** Bounds for the current window: 220–320, lowered so the content keeps its reserve. */
export function sidebarBounds(windowWidth?: number): SidebarBounds {
  if (windowWidth === undefined || !Number.isFinite(windowWidth)) return { min: SIDEBAR_MIN_WIDTH, max: SIDEBAR_MAX_WIDTH }
  const roomy = Math.floor(windowWidth - SIDEBAR_CONTENT_RESERVE)
  return { min: SIDEBAR_MIN_WIDTH, max: Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, roomy)) }
}

export function clampSidebarWidth(width: number, windowWidth?: number): number {
  const { min, max } = sidebarBounds(windowWidth)
  if (!Number.isFinite(width)) return Math.min(max, SIDEBAR_DEFAULT_WIDTH)
  return Math.min(max, Math.max(min, Math.round(width)))
}

/** Stored preference: an integer within 220–320, anything else is the default. */
export function parseSidebarWidth(value: unknown): number {
  const text = typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : ''
  if (!/^\d{3}$/.test(text)) return SIDEBAR_DEFAULT_WIDTH
  const width = Number(text)
  return width >= SIDEBAR_MIN_WIDTH && width <= SIDEBAR_MAX_WIDTH ? width : SIDEBAR_DEFAULT_WIDTH
}

/** Arrow keys move by 8px, Home/End jump to the bounds; other keys return null. */
export function sidebarWidthForKey(key: string, current: number, bounds: SidebarBounds): number | null {
  const clamp = (width: number): number => Math.min(bounds.max, Math.max(bounds.min, width))
  switch (key) {
    case 'ArrowLeft': return clamp(current - SIDEBAR_KEY_STEP)
    case 'ArrowRight': return clamp(current + SIDEBAR_KEY_STEP)
    case 'Home': return bounds.min
    case 'End': return bounds.max
    default: return null
  }
}

type CaptureTarget = {
  setPointerCapture: (pointerId: number) => void
  releasePointerCapture: (pointerId: number) => void
  hasPointerCapture: (pointerId: number) => boolean
}

export type SidebarPointerEvent = {
  pointerId: number
  clientX: number
  button: number
  isPrimary?: boolean
  currentTarget: CaptureTarget
  preventDefault: () => void
}

export type SidebarResizeOptions = {
  /** Width rendered when the drag starts. */
  getWidth: () => number
  /** Current bounds (depends on the window width). */
  getBounds: () => SidebarBounds
  /** Live preview while dragging; must not touch the store or persistence. */
  preview: (width: number) => void
  /** Final width once the drag ends for any reason. */
  commit: (width: number) => void
  /** Drag started / ended (cursor and text-selection lock). */
  onActiveChange?: (active: boolean) => void
}

export type SidebarResizeController = {
  pointerDown: (event: SidebarPointerEvent) => void
  pointerMove: (event: Pick<SidebarPointerEvent, 'pointerId' | 'clientX'>) => void
  /** pointerup, pointercancel and lostpointercapture all end the drag here. */
  pointerEnd: (event: Pick<SidebarPointerEvent, 'pointerId'>) => void
  /** Window blur or unmount: end any drag without a pointer event. */
  cancel: () => void
  isDragging: () => boolean
}

export function createSidebarResizeController(options: SidebarResizeOptions): SidebarResizeController {
  let drag: { pointerId: number; startX: number; startWidth: number; width: number; target: CaptureTarget } | null = null

  const finish = (): void => {
    if (!drag) return
    const { pointerId, target, width } = drag
    drag = null
    try {
      if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId)
    } catch { /* The element may already be detached. */ }
    options.onActiveChange?.(false)
    options.commit(width)
  }

  return {
    pointerDown(event) {
      if (event.button !== 0 || event.isPrimary === false || drag) return
      // Keeps the press from selecting text or reaching the native drag script.
      event.preventDefault()
      const startWidth = options.getWidth()
      drag = { pointerId: event.pointerId, startX: event.clientX, startWidth, width: startWidth, target: event.currentTarget }
      try { event.currentTarget.setPointerCapture(event.pointerId) } catch { /* Synthetic or detached target. */ }
      options.onActiveChange?.(true)
    },
    pointerMove(event) {
      if (!drag || event.pointerId !== drag.pointerId) return
      const { min, max } = options.getBounds()
      // Width follows the pointer offset from the press, so coming back from
      // past a bound is continuous instead of jumping.
      const width = Math.min(max, Math.max(min, Math.round(drag.startWidth + event.clientX - drag.startX)))
      if (width === drag.width) return
      drag.width = width
      options.preview(width)
    },
    pointerEnd(event) {
      if (drag && event.pointerId === drag.pointerId) finish()
    },
    cancel: finish,
    isDragging: () => drag !== null,
  }
}
