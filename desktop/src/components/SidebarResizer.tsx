import { useEffect, useMemo, useRef, type KeyboardEvent, type RefObject } from 'react'
import { createSidebarResizeController, sidebarWidthForKey, type SidebarBounds } from '../lib/sidebar-width.js'

type SidebarResizerProps = {
  /** The sidebar whose `--sidebar-width` is previewed while dragging. */
  targetRef: RefObject<HTMLElement | null>
  width: number
  bounds: SidebarBounds
  onCommit: (width: number) => void
}

/**
 * Vertical separator on the sidebar's right edge (#182). It is never a window
 * drag region: it carries no `data-tauri-drag-region` and its CSS opts out of
 * `-webkit-app-region`, so pressing it resizes the sidebar instead of moving the
 * window. Dragging previews through the CSS variable only and commits (store +
 * persistence) once on release.
 */
export default function SidebarResizer({ targetRef, width, bounds, onCommit }: SidebarResizerProps) {
  const separatorRef = useRef<HTMLDivElement>(null)
  const latest = useRef({ width, bounds, onCommit })
  latest.current = { width, bounds, onCommit }

  const controller = useMemo(() => createSidebarResizeController({
    getWidth: () => latest.current.width,
    getBounds: () => latest.current.bounds,
    preview: (next) => {
      targetRef.current?.style.setProperty('--sidebar-width', `${next}px`)
      separatorRef.current?.setAttribute('aria-valuenow', String(next))
    },
    commit: (next) => latest.current.onCommit(next),
    onActiveChange: (active) => document.documentElement.classList.toggle('sidebar-resizing', active),
  }), [targetRef])

  useEffect(() => {
    const release = (): void => controller.cancel()
    window.addEventListener('blur', release)
    return () => {
      window.removeEventListener('blur', release)
      release()
    }
  }, [controller])

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const next = sidebarWidthForKey(event.key, width, bounds)
    if (next === null) return
    event.preventDefault()
    if (next !== width) onCommit(next)
  }

  return (
    <div
      ref={separatorRef}
      className="sidebar-resizer"
      role="separator"
      tabIndex={0}
      aria-label="调整侧栏宽度"
      aria-orientation="vertical"
      aria-valuenow={width}
      aria-valuemin={bounds.min}
      aria-valuemax={bounds.max}
      onPointerDown={(event) => controller.pointerDown(event)}
      onPointerMove={(event) => controller.pointerMove(event)}
      onPointerUp={(event) => controller.pointerEnd(event)}
      onPointerCancel={(event) => controller.pointerEnd(event)}
      onLostPointerCapture={(event) => controller.pointerEnd(event)}
      onKeyDown={onKeyDown}
    />
  )
}
