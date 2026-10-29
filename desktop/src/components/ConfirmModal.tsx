import { Icon } from './Icon.js'
import FocusTrapDialog from './FocusTrapDialog.js'
import type { ReactNode } from 'react'

type ConfirmModalProps = {
  eyebrow?: string
  title: string
  description: string
  confirmLabel: string
  destructive?: boolean
  busy?: boolean
  confirmDisabled?: boolean
  covered?: boolean // Keep the review trigger mounted for focus return without its backdrop.
  children?: ReactNode
  onCancel: () => void
  onConfirm: () => void
}

export default function ConfirmModal({
  eyebrow = '确认操作', title, description, confirmLabel, destructive = false,
  busy = false, confirmDisabled = false, covered = false, children, onCancel, onConfirm,
}: ConfirmModalProps) {
  return <FocusTrapDialog className="modal-layer above-sheet" label={title} onEscape={onCancel} escapeDisabled={busy}
    ariaHidden={covered}
    style={covered ? { opacity: 0, pointerEvents: 'none' } : undefined}>
    <div className="modal-card compact">
      <div className="modal-head"><div><span className="eyebrow">{eyebrow}</span><h2>{title}</h2></div><button className="ico-btn" onClick={onCancel} disabled={busy} aria-label="关闭确认对话框"><Icon name="x" size={16} /></button></div>
      <p className="modal-copy">{description}</p>
      {children}
      <div className="modal-actions"><button className="btn btn-ghost" onClick={onCancel} disabled={busy}>取消</button><button className={`btn ${destructive ? 'btn-danger' : 'btn-primary'}`} onClick={onConfirm} disabled={busy || confirmDisabled}>{busy ? '处理中…' : confirmLabel}</button></div>
    </div>
  </FocusTrapDialog>
}
