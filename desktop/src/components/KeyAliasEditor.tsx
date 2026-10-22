import { useRef, useState } from 'react'
import FocusTrapDialog from './FocusTrapDialog.js'
import { Icon } from './Icon.js'
import { toast } from './Toast.js'
import { setVaultKeyAliases } from '../lib/tauri.js'
import { userMessage } from '../lib/user-message.js'
import { removeAlias, validateAliasName } from '../lib/keys.js'
import { useStore } from '../store/index.js'

/**
 * 「关联变量名」 (#294): the other variable names that use this key's value.
 * Names are edited locally and written in one `set_vault_key_aliases` call;
 * clashes (a name that is another key's main name or alias) come back from
 * the native side and are shown inline.
 */
export default function KeyAliasEditor({ keyName, aliases, onClose, onSaved }: {
  keyName: string
  aliases: readonly string[]
  onClose: () => void
  onSaved: () => void
}) {
  const accountUserId = useStore((state) => state.currentUser?.id ?? null)
  const [names, setNames] = useState<string[]>(() => [...aliases])
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const inFlight = useRef(false)
  const changed = names.length !== aliases.length || names.some((name, index) => name !== aliases[index])

  const add = (): void => {
    const name = draft.trim().toUpperCase()
    const problem = validateAliasName(name, keyName, names)
    if (problem) { setError(problem); return }
    setNames((current) => [...current, name])
    setDraft('')
    setError(null)
  }

  const save = async (): Promise<void> => {
    if (inFlight.current) return
    inFlight.current = true
    setSaving(true)
    setError(null)
    try {
      await setVaultKeyAliases(keyName, names, accountUserId)
      toast(names.length > 0 ? `${keyName} 的变量名已更新` : `${keyName} 不再关联其他变量名`)
      onSaved()
      onClose()
    } catch (reason: unknown) {
      setError(userMessage(reason))
    } finally {
      inFlight.current = false
      setSaving(false)
    }
  }

  return <FocusTrapDialog className="modal-layer above-sheet" label={`关联变量名：${keyName}`} onEscape={onClose} escapeDisabled={saving}>
    <div className="modal-card compact key-alias-editor">
      <div className="modal-head">
        <div><span className="eyebrow">关联变量名</span><h2><code className="key-card-name">{keyName}</code></h2></div>
        <button type="button" className="ico-btn" onClick={onClose} disabled={saving} aria-label="关闭"><Icon name="x" size={16} /></button>
      </div>
      <p className="modal-copy">Skill 声明这里的任何一个变量名，都会用到这把钥匙的值，值不需要再填一遍。</p>
      <ul className="key-alias-editor-list" aria-label="已关联的变量名">
        {names.length === 0 && <li className="key-card-empty">还没有关联其他变量名</li>}
        {names.map((name) => <li key={name}>
          <code className="key-alias-tag">{name}</code>
          <button type="button" className="ico-btn" disabled={saving} aria-label={`移除 ${name}`} onClick={() => { setNames((current) => removeAlias(current, name)); setError(null) }}><Icon name="x" size={13} /></button>
        </li>)}
      </ul>
      <div className="key-alias-editor-add">
        <label className="sr-only" htmlFor="key-alias-input">新的变量名</label>
        <input
          id="key-alias-input"
          className="key-alias-input"
          value={draft}
          disabled={saving}
          autoComplete="off"
          spellCheck={false}
          placeholder="例如 FAL_API_KEY"
          aria-invalid={Boolean(error) || undefined}
          aria-describedby={error ? 'key-alias-error' : undefined}
          onChange={(event) => { setDraft(event.target.value.toUpperCase()); setError(null) }}
          onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); add() } }}
        />
        <button type="button" className="btn btn-ghost btn-sm" disabled={saving || !draft.trim()} onClick={add}><Icon name="plus" size={13} />添加</button>
      </div>
      {error && <div className="banner banner-error" role="alert" id="key-alias-error"><Icon name="warn" size={14} />{error}</div>}
      <div className="modal-actions">
        <button type="button" className="btn btn-ghost" disabled={saving} onClick={onClose}>取消</button>
        <button type="button" className="btn btn-primary" disabled={saving || !changed} onClick={() => void save()}>{saving ? '保存中…' : '保存'}</button>
      </div>
    </div>
  </FocusTrapDialog>
}
