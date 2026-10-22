/**
 * Blank-area window dragging.
 *
 * Tauri's bare `data-tauri-drag-region` attribute starts a native window drag
 * only when the marked element itself is hit: a child (title text, chip,
 * button, input, tab, scrollbar of a nested scroller) keeps its own behaviour.
 * So containers whose *own* area is empty — page heads, title rows, spacers,
 * the detail header — can be marked without stealing text selection, list
 * marquee selection or control clicks. `deep` is never used for that reason.
 *
 * Double-click is handled by the same native script (`internal_toggle_maximize`
 * via `core:default`), including the macOS "cancel when the pointer moved"
 * rule; the page adds no second handler, so one double-click toggles once.
 */
export const BLANK_DRAG_ATTRIBUTE = 'data-tauri-drag-region' as const

export type BlankDragAttributes = { readonly 'data-tauri-drag-region': true }

export function blankDragAttributes(): BlankDragAttributes {
  return { [BLANK_DRAG_ATTRIBUTE]: true }
}
