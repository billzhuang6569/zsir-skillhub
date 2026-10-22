import { blankDragAttributes, type BlankDragAttributes } from '../lib/window-drag.js'

/**
 * Props for a container whose child-free area is window blank: a direct press
 * starts the native drag and a direct double-click toggles maximize, both
 * handled by Tauri's drag-region script (same contract as `WindowControls`'
 * title bar). Children are untouched. Apply only to layout containers, never
 * to text, scrollers or the list/marquee canvas.
 */
export function blankDragRegion(): BlankDragAttributes {
  return blankDragAttributes()
}

/** The flexible spacer in a page title row, which is pure window blank. */
export function BlankDragSpacer({ className = 'sp' }: { className?: string }) {
  return <span className={className} aria-hidden="true" {...blankDragRegion()} />
}
