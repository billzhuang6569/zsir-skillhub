import { useStore } from '../store/index.js'
import { organizerPendingCount } from '../lib/organizer-sync.js'
import { Icon } from './Icon.js'
import './SkillTags.css'

function syncedAtText(value: string | null): string {
  if (!value) return '尚未同步'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '尚未同步' : `上次同步 ${date.toLocaleString('zh-CN', { hour12: false })}`
}

/**
 * 「标签与快捷访问」 sync state for the signed-in account (#326): last sync,
 * changes waiting for upload, the last error, and 立即同步.
 */
export default function OrganizerSyncStatus() {
  const currentUser = useStore((state) => state.currentUser)
  const status = useStore((state) => state.organizerSync)
  const organizer = useStore((state) => state.organizer)
  const loaded = useStore((state) => Boolean(state.currentUser && state.organizerAccount === state.currentUser.id))
  const runOrganizerSync = useStore((state) => state.runOrganizerSync)
  if (!currentUser) return null
  const pending = loaded ? organizerPendingCount(organizer) : 0
  const enabled = status.capability === 'supported'
  const detail = status.capability === 'unsupported'
    ? '当前服务端暂不支持同步，目录与快捷访问只保存在这台电脑'
    : status.capability === 'unknown'
      ? status.probeFailed ? '暂时无法连接服务器，稍后自动重试' : '正在连接服务器…'
    : status.running
      ? '正在同步…'
      : status.error
        ? `同步失败：${status.error}`
        : `${syncedAtText(organizer.sync.lastSyncedAt)}${pending > 0 ? ` · 待上传 ${pending} 项` : ''}`
  return <div className="settings-row organizer-sync-group">
      <div className="settings-row-info">
        <b>目录与快捷访问同步</b>
        <span role="status" className={status.error ? 'organizer-sync-error' : undefined}>{detail}{status.error && pending > 0 ? ` · 待上传 ${pending} 项` : ''}</span>
      </div>
      {enabled && <button type="button" className="btn btn-ghost btn-sm" disabled={status.running || !loaded} onClick={() => void runOrganizerSync()}><Icon name="refresh" size={13} />立即同步</button>}
  </div>
}
