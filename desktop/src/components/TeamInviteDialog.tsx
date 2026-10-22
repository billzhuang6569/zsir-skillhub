import type { ApiTeamInvite } from '../lib/api.js'
import { useMediaUrl } from '../lib/media.js'
import { Icon } from './Icon.js'
import FocusTrapDialog from './FocusTrapDialog.js'
import './TeamInviteDialog.css'

export function OtherServerInviteDialog({ server, busy, onCancel, onContinue }: {
  server: string; busy: boolean; onCancel: () => void; onContinue: () => void
}) {
  return <FocusTrapDialog className="modal-layer" label="加入其他服务器上的团队" onEscape={onCancel} escapeDisabled={busy}>
    <div className="modal-card compact">
      <div className="modal-head"><div><span className="eyebrow">团队邀请</span><h2>加入其他服务器上的团队</h2></div><button className="ico-btn" type="button" disabled={busy} onClick={onCancel} aria-label="关闭团队邀请"><Icon name="x" size={16} /></button></div>
      <p className="modal-copy">这个邀请来自 {server}。要加入，需要切换到这台服务器并登录；当前空间的数据会保留在这台电脑上。</p>
      <div className="modal-actions">
        <button className="btn btn-ghost" type="button" disabled={busy} onClick={onCancel}>暂不加入</button>
        <button className="btn btn-primary" type="button" disabled={busy} onClick={onContinue}>{busy ? '正在测试…' : '切换并继续'}</button>
      </div>
    </div>
  </FocusTrapDialog>
}

export default function TeamInviteDialog({
  invite,
  authenticated,
  busy,
  onCancel,
  onAccept,
}: {
  invite: ApiTeamInvite
  authenticated: boolean
  busy: boolean
  onCancel: () => void
  onAccept: () => void
}) {
  const initial = Array.from(invite.team.name.trim() || '团')[0] ?? '团'
  const imageUrl = useMediaUrl(invite.team.avatarUrl)
  return <FocusTrapDialog className="modal-layer team-invite-prompt-layer" label="团队邀请" onEscape={onCancel} escapeDisabled={busy}>
    <div className="modal-card compact team-invite-prompt">
      <div className="modal-head"><div><span className="eyebrow">团队邀请</span><h2>加入这个团队？</h2></div><button className="ico-btn" type="button" disabled={busy} onClick={onCancel} aria-label="关闭团队邀请"><Icon name="x" size={16} /></button></div>
      <div className="team-invite-prompt-team">
        <span className="team-invite-prompt-avatar" style={{ background: invite.team.color }}>
          {imageUrl ? <img src={imageUrl} alt="" /> : initial}
        </span>
        <div><b>{invite.team.name}</b><span>邀请已由服务端验证，接受后会直接加入团队。</span></div>
      </div>
      <div className="team-invite-prompt-note"><Icon name="shield" size={14} /><span>{authenticated ? '加入后即可查看团队共享的 Skills。' : '需要先登录当前账号，再完成加入。'}</span></div>
      <div className="modal-actions"><button className="btn btn-ghost" type="button" disabled={busy} onClick={onCancel}>暂不加入</button><button className="btn btn-primary" type="button" disabled={busy} onClick={onAccept}>{busy ? '正在加入…' : authenticated ? '确认加入' : '登录并加入'}</button></div>
    </div>
  </FocusTrapDialog>
}
