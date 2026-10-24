import { useLayoutEffect, useRef, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'area[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'iframe',
  'object',
  'embed',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

type FocusTrapDialogProps = {
  children: ReactNode
  className: string
  label: string
  onEscape: () => void
  escapeDisabled?: boolean
  closeOnBackdrop?: boolean
  style?: CSSProperties
}

function isVisible(element: HTMLElement): boolean {
  if (element.hidden || element.getAttribute('aria-hidden') === 'true') return false
  const style = window.getComputedStyle(element)
  return style.display !== 'none' && style.visibility !== 'hidden'
}

function focusableElements(dialog: HTMLElement): HTMLElement[] {
  return Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(isVisible)
}

/**
 * Non-modal popovers opened from inside a dialog but portaled to <body>
 * (e.g. the tag popover, #323) own their focus, Tab and Escape while open.
 */
function inNestedPopover(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('[data-nested-popover]') !== null
}

function isTopmostDialog(dialog: HTMLElement): boolean {
  const dialogs = Array.from(
    document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]'),
  ).filter(isVisible)
  return dialogs[dialogs.length - 1] === dialog
}

export default function FocusTrapDialog({
  children,
  className,
  label,
  onEscape,
  escapeDisabled = false,
  closeOnBackdrop = false,
  style,
}: FocusTrapDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const onEscapeRef = useRef(onEscape)
  const escapeDisabledRef = useRef(escapeDisabled)
  onEscapeRef.current = onEscape
  escapeDisabledRef.current = escapeDisabled

  useLayoutEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    const restoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const focusFirst = (): void => {
      const target = dialog.querySelector<HTMLElement>('[autofocus]')
        ?? focusableElements(dialog)[0]
        ?? dialog
      target.focus({ preventScroll: true })
    }
    const initialFocusFrame = window.requestAnimationFrame(() => {
      if (isTopmostDialog(dialog) && !dialog.contains(document.activeElement)) focusFirst()
    })

    const onKeyDown = (event: KeyboardEvent): void => {
      if (!isTopmostDialog(dialog) || inNestedPopover(event.target)) return
      // Escape that cancels an IME composition (Pinyin, kana; WKWebView reports keyCode 229) belongs to the IME.
      if (event.key === 'Escape' && !event.isComposing && event.keyCode !== 229) {
        event.preventDefault()
        event.stopImmediatePropagation()
        if (!escapeDisabledRef.current) onEscapeRef.current()
        return
      }
      if (event.key !== 'Tab') return
      const focusable = focusableElements(dialog)
      if (focusable.length === 0) {
        event.preventDefault()
        dialog.focus({ preventScroll: true })
        return
      }
      const first = focusable[0] as HTMLElement
      const last = focusable[focusable.length - 1] as HTMLElement
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
        event.preventDefault()
        last.focus({ preventScroll: true })
      } else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
        event.preventDefault()
        first.focus({ preventScroll: true })
      }
    }
    const onFocusIn = (event: FocusEvent): void => {
      if (isTopmostDialog(dialog) && !dialog.contains(event.target as Node) && !inNestedPopover(event.target)) focusFirst()
    }

    document.addEventListener('keydown', onKeyDown, true)
    document.addEventListener('focusin', onFocusIn, true)
    return () => {
      window.cancelAnimationFrame(initialFocusFrame)
      document.removeEventListener('keydown', onKeyDown, true)
      document.removeEventListener('focusin', onFocusIn, true)
      window.requestAnimationFrame(() => {
        const topmost = Array.from(
          document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]'),
        ).filter(isVisible).pop()
        if (restoreFocus?.isConnected && (!topmost || topmost.contains(restoreFocus))) {
          restoreFocus.focus({ preventScroll: true })
        } else if (topmost) {
          const fallbackFocus = focusableElements(topmost)[0] ?? topmost
          fallbackFocus.focus({ preventScroll: true })
        }
      })
    }
  }, [])

  const dialog = <div
    ref={dialogRef}
    className={className}
    role="dialog"
    aria-modal="true"
    aria-label={label}
    tabIndex={-1}
    style={style}
    onClick={(event) => {
      if (closeOnBackdrop && event.target === event.currentTarget && !escapeDisabledRef.current) {
        onEscapeRef.current()
      }
    }}
  >{children}</div>

  // Dialogs can be opened from inside workspace panes that create their own
  // stacking contexts. Mounting at the document root keeps the backdrop and
  // card above the complete app instead of underneath sibling panes.
  return createPortal(dialog, document.body)
}
