import { dismissAppUpdate, downloadAndInstallAppUpdate, restartAfterAppUpdate } from '../lib/app-updater.js'
import { useStore } from '../store/index.js'
import FocusTrapDialog from './FocusTrapDialog.js'
import { Icon } from './Icon.js'
import './AppUpdateDialog.css'

function progressLabel(downloaded = 0, total?: number): string {
  const megabytes = (downloaded / 1024 / 1024).toFixed(1)
  if (!total) return `已下载 ${megabytes} MB`
  return `已下载 ${megabytes} / ${(total / 1024 / 1024).toFixed(1)} MB`
}

export default function AppUpdateDialog() {
  const update = useStore((state) => state.appUpdate)
  const installError = update.phase === 'error' && Boolean(update.version)
  if (!['available', 'downloading', 'ready'].includes(update.phase) && !installError) return null
  const busy = update.phase === 'downloading'
  const ready = update.phase === 'ready'
  const percent = update.totalBytes && update.downloadedBytes !== undefined
    ? Math.min(100, Math.round(update.downloadedBytes / update.totalBytes * 100))
    : null

  return <FocusTrapDialog className="modal-layer above-sheet" label="SkillHub 应用更新" onEscape={dismissAppUpdate} escapeDisabled={busy}>
    <div className="modal-card compact app-update-dialog">
      <div className="modal-head"><div><span className="eyebrow">应用更新</span><h2>{ready ? '更新已准备好' : `发现新版本 v${update.version ?? ''}`}</h2></div>{!busy && <button type="button" className="ico-btn" onClick={dismissAppUpdate} aria-label="稍后更新"><Icon name="x" size={16} /></button>}</div>
      <p className="modal-copy app-update-notes">{update.notes}</p>
      {busy && <div className="app-update-progress" role="status"><div><span style={percent === null ? undefined : { width: `${percent}%` }} /></div><small>{progressLabel(update.downloadedBytes, update.totalBytes)}</small></div>}
      {installError && <div className="banner banner-error full" role="alert"><Icon name="warn" size={14} />{update.error}</div>}
      {ready && <div className="banner banner-success full"><Icon name="check" size={14} />签名校验通过。重启后使用新版本。</div>}
      <div className="modal-actions">
        {!busy && <button type="button" className="btn btn-ghost" onClick={dismissAppUpdate}>{ready ? '稍后重启' : '稍后更新'}</button>}
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void (ready ? restartAfterAppUpdate() : downloadAndInstallAppUpdate())}>{busy ? '正在下载并校验…' : ready ? '立即重启' : installError ? '重试下载' : '下载更新'}</button>
      </div>
    </div>
  </FocusTrapDialog>
}
