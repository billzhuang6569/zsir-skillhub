import { useEffect, useState } from 'react'
import { Icon } from './Icon.js'
import './Toast.css'

export type ToastItem = {
  id: string
  message: string
  kind?: 'default' | 'warn' | 'error'
  undo?: () => Promise<void>
  /** Set for the exit animation; the item is removed when it ends. */
  leaving?: boolean
}

/** Same length as --motion-base in design-tokens.json: the `.pop-out` exit. */
export const TOAST_EXIT_MS = 200

// Global toast queue — simple singleton for MVP
let _setToasts: ((fn: (prev: ToastItem[]) => ToastItem[]) => void) | null = null

export function toast(message: string, kind: ToastItem['kind'] = 'default', undo?: () => Promise<void>) {
  const id = Math.random().toString(36).slice(2)
  _setToasts?.((prev) => [...prev, { id, message, kind, undo }])
  setTimeout(() => {
    _setToasts?.((prev) => prev.map((t) => (t.id === id ? { ...t, leaving: true } : t)))
    setTimeout(() => _setToasts?.((prev) => prev.filter((t) => t.id !== id)), TOAST_EXIT_MS)
  }, undo ? 10000 : 5000)
}

export default function ToastContainer() {
  const [toasts, setToasts] = useState<ToastItem[]>([])
  useEffect(() => { _setToasts = setToasts; return () => { _setToasts = null } }, [])

  return (
    <div className="toast-container">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind ?? 'default'} ${t.leaving ? 'pop-out' : 'pop-in'}`} role={t.kind === 'error' ? 'alert' : 'status'}>
          <span className="toast-icon" aria-hidden="true"><Icon name={t.kind === 'warn' || t.kind === 'error' ? 'warn' : 'check'} size={14} /></span>
          <span className="toast-message">{t.message}</span>
          {t.undo && <button type="button" className="toast-action" onClick={() => {
            const action = t.undo
            setToasts((items) => items.filter((item) => item.id !== t.id))
            void action?.().catch(() => toast('未能撤销，请重新检查安装状态', 'error'))
          }}>撤销</button>}
        </div>
      ))}
    </div>
  )
}
