import { useEffect, useMemo, useState } from 'react'
import { useStore } from '../store/index.js'
import FocusTrapDialog from './FocusTrapDialog.js'
import { Icon } from './Icon.js'
import { toast } from './Toast.js'
import {
  dismissKeyConsentRequest,
  grantKeyAccess,
  listKeyConsentRequests,
  setKeyAutoAllow,
} from '../lib/tauri.js'
import {
  applyConsentChoice,
  consentDialogTitle,
  consentKeysText,
  consentRequestId,
  nextConsentRequest,
  type ConsentChoice,
} from '../lib/keys.js'
import { KEY_CONSENT_OPEN_EVENT } from '../lib/skill-keys.js'
import type { KeyConsentRequest } from '../lib/tauri.js'

/** How often the APP looks for runs refused with `NEEDS_CONSENT`. */
const CONSENT_POLL_MS = 4_000

/**
 * First-use consent (#253): a Marketplace or team Skill asked `skillhub run`
 * for an account key it was never allowed to use. The CLI only leaves a
 * value-free request; the user answers here, then the Agent retries.
 */
export default function KeyConsentDialog() {
  const space = useStore(state => state.activeSpace)
  const authStatus = useStore((state) => state.authStatus)
  const accountUserId = useStore((state) => state.currentUser?.id ?? null)
  const requests = useStore((state) => state.keyConsentRequests)
  const setRequests = useStore((state) => state.setKeyConsentRequests)
  // #306: a labelled variant arrives as `FAL_KEY__V1`; the vault rows give it a human label.
  const vaultKeys = useStore((state) => state.keyVault.keys)
  const [answered, setAnswered] = useState<Set<string>>(() => new Set())
  const [dontAskAgain, setDontAskAgain] = useState(false)
  const [busy, setBusy] = useState(false)
  // Opened on purpose from a 「等待授权」 row: shown even if answered earlier this session.
  const [requested, setRequested] = useState<KeyConsentRequest | null>(null)

  useEffect(() => {
    const open = (event: Event): void => {
      const detail = (event as CustomEvent<KeyConsentRequest | undefined>).detail
      if (!detail?.skillId || detail.keys.length === 0) return
      const pending = useStore.getState().keyConsentRequests.find((item) => item.skillId === detail.skillId)
      setRequested(pending ? { ...pending, keys: [...new Set([...pending.keys, ...detail.keys])] } : detail)
    }
    window.addEventListener(KEY_CONSENT_OPEN_EVENT, open)
    return () => window.removeEventListener(KEY_CONSENT_OPEN_EVENT, open)
  }, [])
  useEffect(() => { setRequested(null) }, [accountUserId])

  useEffect(() => {
    if (authStatus === 'restoring') return
    let active = true
    const refresh = (): void => {
      void listKeyConsentRequests(accountUserId).then((items) => {
        if (active && useStore.getState().activeSpace === space && (useStore.getState().currentUser?.id ?? null) === accountUserId) setRequests(items)
      }).catch(() => { /* Mid-switch or unreadable vault: try again on the next tick. */ })
    }
    refresh()
    const timer = window.setInterval(refresh, CONSENT_POLL_MS)
    window.addEventListener('focus', refresh)
    return () => {
      active = false
      window.clearInterval(timer)
      window.removeEventListener('focus', refresh)
    }
  }, [accountUserId, authStatus, space, setRequests])

  const queued = useMemo(() => nextConsentRequest(requests, answered), [answered, requests])
  const request = requested ?? queued
  if (!request) return null

  const answer = async (choice: ConsentChoice): Promise<void> => {
    if (!space || useStore.getState().spacePending || useStore.getState().activeSpace !== space) return
    setBusy(true)
    try {
      await applyConsentChoice(request, choice, dontAskAgain, accountUserId, {
        grantKeyAccess: (skillId, key, once, account, variant) => grantKeyAccess(skillId, key, once, account, variant, space),
        dismissKeyConsentRequest: (skillId, account) => dismissKeyConsentRequest(skillId, account, space),
        setKeyAutoAllow: (enabled) => setKeyAutoAllow(enabled, null, accountUserId, null, space),
      }, vaultKeys)
      if (useStore.getState().activeSpace !== space) return
      setAnswered((previous) => new Set(previous).add(consentRequestId(request)))
      setRequested(null)
      setRequests(useStore.getState().keyConsentRequests.filter((item) => item.skillId !== request.skillId))
      setDontAskAgain(false)
      if (choice !== 'deny') toast(`已${choice === 'once' ? '允许这一次' : '允许'}，请让 Agent 重试`)
    } catch (error: unknown) {
      toast(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      setBusy(false)
    }
  }

  const title = consentDialogTitle(request, vaultKeys)
  return <FocusTrapDialog className="modal-layer above-sheet" label={title} onEscape={() => void answer('deny')} escapeDisabled={busy}>
    <div className="modal-card compact">
      <div className="modal-head"><div><span className="eyebrow">钥匙授权</span><h2>{title}</h2></div><button className="ico-btn" onClick={() => void answer('deny')} disabled={busy} aria-label="拒绝并关闭钥匙授权"><Icon name="x" size={16} /></button></div>
      <p className="modal-copy">「{request.skillName}」来自商店或团队。允许后，它运行时可以使用你钥匙库中的 {consentKeysText(request, vaultKeys)}；值不会显示给 Agent，也不会上传。</p>
      <label className="secret-input-label"><span><input type="checkbox" checked={dontAskAgain} disabled={busy} onChange={(event) => setDontAskAgain(event.target.checked)} /> 以后不再询问，有能用的就用</span></label>
      <div className="modal-actions">
        <button className="btn btn-ghost" onClick={() => void answer('deny')} disabled={busy}>拒绝</button>
        <button className="btn btn-ghost" onClick={() => void answer('once')} disabled={busy}>仅这次</button>
        <button className="btn btn-primary" onClick={() => void answer('allow')} disabled={busy}>{busy ? '处理中…' : '允许'}</button>
      </div>
    </div>
  </FocusTrapDialog>
}
