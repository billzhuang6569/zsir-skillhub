import { useRef, useState } from 'react'
import FocusTrapDialog from './FocusTrapDialog.js'
import { Icon } from './Icon.js'
import { userMessage } from '../lib/user-message.js'
import { KEYS_PAGE_COPY, VARIANT_LABEL_MAX, validateVariantLabel, variantDisplayName } from '../lib/keys.js'

export type KeyVariantDialogMode = 'add' | 'rename' | 'convert'

/**
 * Labelled variants of one key name (#306):
 * - `add`: 「添加另一把（带标签）」, label + value;
 * - `rename`: 「重命名标签」, label only;
 * - `convert`: 「转成一把带标签的钥匙」 for one Skill's own value, label only.
 *
 * The label is checked here (non-empty, ≤ 24 characters, unique for the
 * name); the native side has the final say and its Chinese message shows
 * inline. The value lives only in the password input until submitted.
 */
export default function KeyVariantDialog({ mode, keyName, existingLabels, initialLabel = null, skillName, onSubmit, onClose }: {
  mode: KeyVariantDialogMode
  keyName: string
  /** Labels already used by this name (the current one included when renaming). */
  existingLabels: readonly (string | null | undefined)[]
  initialLabel?: string | null
  /** `convert`: the Skill whose own value becomes the variant. */
  skillName?: string
  /** Resolves when written; a thrown error is shown inline and the dialog stays open. */
  onSubmit: (label: string, value: string) => Promise<void>
  onClose: () => void
}) {
  const [label, setLabel] = useState(initialLabel ?? '')
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const inFlight = useRef(false)
  const withValue = mode === 'add'
  const title = mode === 'add' ? KEYS_PAGE_COPY.variantAddTitle : mode === 'rename' ? KEYS_PAGE_COPY.variantRenameTitle : KEYS_PAGE_COPY.variantConvertTitle
  const hint = mode === 'add' ? KEYS_PAGE_COPY.variantAddHint : mode === 'convert' ? KEYS_PAGE_COPY.variantConvertHint : null
  const trimmed = label.trim()
  const unchanged = mode === 'rename' && trimmed === (initialLabel ?? '')

  const submit = async (): Promise<void> => {
    if (inFlight.current) return
    const problem = validateVariantLabel(label, existingLabels, mode === 'rename' ? initialLabel : null)
    if (problem) { setError(problem); return }
    if (withValue && !value) { setError('请粘贴钥匙的值'); return }
    inFlight.current = true
    setSaving(true)
    setError(null)
    try {
      await onSubmit(trimmed, value)
      setValue('')
      onClose()
    } catch (reason: unknown) {
      setError(userMessage(reason))
    } finally {
      inFlight.current = false
      setSaving(false)
    }
  }

  return <FocusTrapDialog className="modal-layer above-sheet" label={`${title}：${keyName}`} onEscape={onClose} escapeDisabled={saving}>
    <form className="modal-card compact key-variant-dialog" onSubmit={(event) => { event.preventDefault(); void submit() }}>
      <div className="modal-head">
        <div><span className="eyebrow">{title}</span><h2><code className="key-card-name">{variantDisplayName(keyName, trimmed || null)}</code></h2></div>
        <button type="button" className="ico-btn" onClick={onClose} disabled={saving} aria-label="关闭"><Icon name="x" size={16} /></button>
      </div>
      {hint && <p className="modal-copy">{mode === 'convert' && skillName ? `「${skillName}」：${hint}` : hint}</p>}
      <div className="key-variant-form">
        <label className="secret-input-label">
          <span>{KEYS_PAGE_COPY.variantLabelField}</span>
          <input
            className="key-alias-input"
            value={label}
            autoFocus
            autoComplete="off"
            spellCheck={false}
            maxLength={VARIANT_LABEL_MAX * 2}
            disabled={saving}
            placeholder={KEYS_PAGE_COPY.variantLabelPlaceholder}
            aria-invalid={Boolean(error) || undefined}
            aria-describedby={error ? 'key-variant-error' : undefined}
            onChange={(event) => { setLabel(event.target.value); setError(null) }}
          />
        </label>
        {withValue && <label className="secret-input-label">
          <span>{KEYS_PAGE_COPY.variantValueField}</span>
          <input type="password" autoComplete="off" spellCheck={false} value={value} disabled={saving}
            placeholder="粘贴钥匙后保存"
            onChange={(event) => { setValue(event.target.value); setError(null) }} />
        </label>}
      </div>
      {error && <div className="banner banner-error" role="alert" id="key-variant-error"><Icon name="warn" size={14} />{error}</div>}
      <div className="modal-actions">
        <button type="button" className="btn btn-ghost" disabled={saving} onClick={onClose}>取消</button>
        <button type="submit" className="btn btn-primary" disabled={saving || !trimmed || unchanged || (withValue && !value)}>{saving ? '保存中…' : '保存'}</button>
      </div>
    </form>
  </FocusTrapDialog>
}
