import { useEffect, useState } from 'react'
import { useStore, type LocalSkill } from '../store/index.js'
import { deleteScopeFor } from '../lib/library-sync.js'
import FocusTrapDialog from './FocusTrapDialog.js'
import './SkillControls.css'
import { Icon } from './Icon.js'

export type DeleteScope = 'device' | 'account'

/**
 * The single delete entry for a managed Skill (menu, Profile tab, card).
 * A Skill in the signed-in account's library is deleted from the account
 * (every device, account recycle bin); there is no "this computer only" for
 * it, since every device keeps the whole library. Any other Skill moves to
 * this computer's recycle bin.
 */
export default function DeleteSkillDialog({ skill, busy, error, onCancel, onConfirm }: {
  skill: LocalSkill
  busy: boolean
  error: string | null
  onCancel: () => void
  onConfirm: (scope: DeleteScope) => void
}) {
  const currentUserId = useStore((state) => state.currentUser?.id)
  const syncEnabled = useStore((state) => state.librarySyncEnabled)
  const [online, setOnline] = useState(() => navigator.onLine)
  useEffect(() => {
    const update = (): void => setOnline(navigator.onLine)
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    return () => {
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
    }
  }, [])
  const decision = deleteScopeFor({ signedInUserId: currentUserId, syncEnabled, online, skill })
  const unavailable = decision.kind === 'account' && !decision.available ? decision.reason : null
  const title = `删除「${skill.displayName}」`
  return <FocusTrapDialog className="modal-layer above-sheet" label={title} onEscape={onCancel} escapeDisabled={busy}>
    <div className="modal-card skill-dialog compact">
      <div className="modal-head"><div><span className="eyebrow">删除 Skill</span><h2>{title}</h2></div><button className="ico-btn" onClick={onCancel} disabled={busy} aria-label="关闭删除对话框"><Icon name="x" size={16} /></button></div>
      {decision.kind === 'account'
        ? <div className="selection-box delete-scope-summary"><b>从我的账号删除</b><span>所有登录这个账号的设备都会把它移入回收站，可在账号回收站恢复。已经发布到商店或团队的版本不受影响。</span>{unavailable && <small className="delete-scope-reason">{unavailable}</small>}</div>
        : <div className="selection-box delete-scope-summary"><b>移入本机回收站</b><span>{decision.note}</span></div>}
      {error && <div className="banner banner-error" role="alert"><Icon name="warn" size={14} />{error}</div>}
      <div className="modal-actions"><button className="btn btn-ghost" onClick={onCancel} disabled={busy}>取消</button><button className="btn btn-danger" onClick={() => onConfirm(decision.kind)} disabled={busy || unavailable !== null}>{busy ? '正在删除…' : decision.kind === 'account' ? '从账号删除' : '移入本机回收站'}</button></div>
    </div>
  </FocusTrapDialog>
}
