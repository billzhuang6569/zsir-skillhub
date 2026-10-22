import { useEffect, useState } from 'react'
import { openUrl } from '@tauri-apps/plugin-opener'
import { apiCreateTeamInvite, type ApiTeamInvite } from '../lib/api.js'
import { isLoopbackInviteServer, teamInviteMessage, teamInviteWebLink } from '../lib/team-invite.js'
import { currentMediaSpace } from '../lib/tauri.js'
import { useStore } from '../store/index.js'
import { spaceProfile } from '../lib/space-capabilities.js'
import { SELF_HOST_DOCS } from '../lib/spaces.js'
import { teamErrorMessage } from '../lib/ui-helpers.js'
import FocusTrapDialog from './FocusTrapDialog.js'
import { Icon } from './Icon.js'
import { toast } from './Toast.js'
import './TeamInviteCreatorDialog.css'

type CopyKind = 'message' | 'link' | 'id'

export default function TeamInviteCreatorDialog({
  teamId,
  teamName,
  onClose,
}: {
  teamId: string
  teamName: string
  onClose: () => void
}) {
  const [invite, setInvite] = useState<ApiTeamInvite | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const space = useStore(state => state.activeSpace)
  const [serverBase, setServerBase] = useState('')
  useEffect(() => {
    let cancelled = false
    void currentMediaSpace().then(context => { if (!cancelled) setServerBase(context.serverBase) }).catch(() => {})
    return () => { cancelled = true }
  }, [space])

  const createInvite = async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      setInvite(await apiCreateTeamInvite(teamId))
    } catch (reason: unknown) {
      setInvite(null)
      setError(teamErrorMessage(reason))
    } finally {
      setLoading(false)
    }
  }

  const copy = async (kind: CopyKind): Promise<void> => {
    const value = kind === 'id'
      ? teamId
      : kind === 'link' && invite
        ? invite.landingPageUrl ?? teamInviteWebLink(invite.token, serverBase || undefined)
        : invite
          ? teamInviteMessage({ teamName, teamId, token: invite.token, landingPageUrl: invite.landingPageUrl ?? teamInviteWebLink(invite.token, serverBase || undefined) })
          : null
    if (!value) return
    try {
      await navigator.clipboard.writeText(value)
      toast(kind === 'id' ? '团队码已复制' : kind === 'link' ? '邀请链接已复制' : '邀请文字已复制')
    } catch (reason: unknown) {
      toast(`复制失败：${teamErrorMessage(reason)}`, 'error')
    }
  }

  return <FocusTrapDialog
    className="modal-layer above-sheet"
    label="邀请团队成员"
    onEscape={onClose}
    escapeDisabled={loading}
    closeOnBackdrop
  >
    <div className="modal-card compact team-invite-creator-dialog">
      <div className="modal-head">
        <div><span className="eyebrow">团队邀请</span><h2>邀请加入「{teamName}」</h2></div>
        <button className="ico-btn" type="button" disabled={loading} onClick={onClose} aria-label="关闭邀请窗口"><Icon name="x" size={16} /></button>
      </div>

      <section className="team-invite-code" aria-label="团队码">
        <div><span>团队码</span><b className="mono">{teamId}</b></div>
        <button className="btn btn-ghost btn-sm" type="button" onClick={() => void copy('id')}><Icon name="copy" size={13} />复制</button>
      </section>

      {isLoopbackInviteServer(spaceProfile(space), serverBase) && <p className="modal-copy" role="status">
        这个实例部署在你的电脑上，其他人无法访问。要邀请成员，请把实例部署到服务器。
        <button className="link-button" type="button" onClick={() => void openUrl(SELF_HOST_DOCS).catch(() => toast('无法打开部署文档', 'error'))}>查看部署文档 ↗</button>
      </p>}

      {!invite ? <div className="team-invite-create-action">
        <p>也可以创建带授权信息的邀请链接，队友打开后可直接加入。</p>
        <button className="btn btn-primary" type="button" disabled={loading} onClick={() => void createInvite()}>{loading ? <><span className="spin-icon" />正在创建…</> : <><Icon name="link" size={14} />创建邀请链接</>}</button>
      </div> : <>
        <div className="team-invite-options">
          <button type="button" onClick={() => void copy('link')}><span className="team-invite-option-icon"><Icon name="link" size={15} /></span><span><b>复制邀请链接</b><small>队友打开链接后即可进入加入流程</small></span><Icon name="copy" size={13} /></button>
          <button type="button" onClick={() => void copy('message')}><span className="team-invite-option-icon"><Icon name="doc" size={15} /></span><span><b>复制完整邀请</b><small>包含团队名称、团队码和邀请链接</small></span><Icon name="copy" size={13} /></button>
        </div>
        <div className="team-invite-expiry"><Icon name="clock" size={12} />邀请链接有效至 {new Date(invite.expiresAt).toLocaleString('zh-CN')}</div>
      </>}

      {error && <div className="banner banner-error"><Icon name="warn" size={14} /><div>{error}<button className="link-button" disabled={loading} onClick={() => void createInvite()}>重试</button></div></div>}
      <div className="modal-actions"><button className="btn btn-ghost" type="button" disabled={loading} onClick={onClose}>完成</button></div>
    </div>
  </FocusTrapDialog>
}
