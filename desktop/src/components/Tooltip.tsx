import { cloneElement, useEffect, useId, useRef, useState, type ReactElement, type ReactNode } from 'react'
import './Tooltip.css'

export type TooltipPlacement = 'bottom' | 'top'
export type TooltipAlign = 'start' | 'center' | 'end'

type TooltipProps = {
  /** Text or rich content. A string may contain `\n`; it is rendered with line breaks. */
  content: ReactNode
  /** Exactly one focusable trigger (button, link, …). It receives `aria-describedby`. */
  children: ReactElement<{ 'aria-describedby'?: string }>
  placement?: TooltipPlacement
  align?: TooltipAlign
  /** Hover delay before showing; focus shows at once. */
  delayMs?: number
  /** Keep the bubble open while the pointer is over it, so buttons inside stay usable. */
  interactive?: boolean
  /** Hide the bubble entirely (e.g. no content yet) without unmounting the trigger. */
  disabled?: boolean
  className?: string
}

export const TOOLTIP_SHOW_DELAY_MS = 180

/**
 * Hover / focus tooltip (#289). The bubble is a sibling of the trigger inside one
 * anchor, so hovering the bubble keeps it open; Escape closes it. Uses
 * `role="tooltip"` and wires `aria-describedby` on the trigger.
 */
export function Tooltip({
  content,
  children,
  placement = 'bottom',
  align = 'center',
  delayMs = TOOLTIP_SHOW_DELAY_MS,
  interactive = true,
  disabled = false,
  className,
}: TooltipProps) {
  const id = useId()
  const [open, setOpen] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clear = () => {
    if (timer.current !== null) {
      clearTimeout(timer.current)
      timer.current = null
    }
  }
  const show = (immediate: boolean) => {
    if (disabled) return
    clear()
    if (immediate || delayMs <= 0) setOpen(true)
    else timer.current = setTimeout(() => setOpen(true), delayMs)
  }
  const hide = () => {
    clear()
    setOpen(false)
  }

  useEffect(() => clear, [])
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') hide()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  const trigger = cloneElement(children, { 'aria-describedby': disabled ? undefined : id })
  const classes = ['ui-tip-anchor', className].filter(Boolean).join(' ')

  return (
    <span
      className={classes}
      data-placement={placement}
      data-align={align}
      onMouseEnter={() => show(false)}
      onMouseLeave={hide}
      onFocusCapture={() => show(true)}
      onBlurCapture={(event) => {
        // Leaving the anchor entirely closes it; moving focus inside keeps it.
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) hide()
      }}
    >
      {trigger}
      {!disabled && (
        <span
          id={id}
          role="tooltip"
          className={`ui-tip${open ? ' ui-tip-open' : ''}${interactive ? ' ui-tip-interactive' : ''}`}
          aria-hidden={!open}
        >
          {typeof content === 'string' ? <span className="ui-tip-text">{content}</span> : content}
        </span>
      )}
    </span>
  )
}
