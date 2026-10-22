import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { listen } from '@tauri-apps/api/event'
import { migrationCancel, migrationList, migrationReport, migrationRun, migrationSetChoices, type MigrationStatus } from '../lib/tauri.js'
import { acceptsMigrationProgress, migrationCounts, migrationReason, migrationResultReason, migrationState, migrationSummary, unfinishedMigration, type MigrationProgress } from '../lib/migration-ui.js'
import { useStore } from '../store/index.js'
import { LIBRARY_ENTRIES_CHANGED_EVENT } from '../lib/library-sync.js'
import { MigrationPrecheck } from './MigrationDialog.js'
import FocusTrapDialog from './FocusTrapDialog.js'
import './MigrationDialog.css'

type Activity = {
  records: MigrationStatus[]; error: string | null; busy: boolean
  refresh: () => Promise<void>; run: (status: MigrationStatus) => Promise<void>
  cancel: (status: MigrationStatus) => Promise<void>; showReport: (status: MigrationStatus) => void
}
const MigrationContext = createContext<Activity | null>(null)
export function useMigrationActivity(): Activity {
  const value = useContext(MigrationContext)
  if (!value) throw new Error('MigrationProvider missing')
  return value
}
export function MigrationProvider({ children }: { children: ReactNode }) {
  const space = useStore(state => state.activeSpace)
  const pending = useStore(state => state.spacePending)
  const userId = useStore(state => state.currentUser?.id)
  const [records, setRecords] = useState<MigrationStatus[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const actionBusy = useRef(false)
  const [report, setReport] = useState<MigrationStatus | null>(null)
  const [precheck, setPrecheck] = useState<MigrationStatus | null>(null)
  const [dismissed, setDismissed] = useState(false)
  const reported = useRef(new Set<string>())
  const identity = JSON.stringify([space, userId, pending])
  const identityRef = useRef(identity)
  identityRef.current = identity
  const refresh = useCallback(async (): Promise<void> => {
    if (!space || !userId || pending || space.spaceId === 'local') return
    try {
      const list = await migrationList()
      if (identityRef.current === identity) { setRecords(list); setError(null) }
    } catch { if (identityRef.current === identity) setError('未能读取迁移记录，请重试') }
  }, [identity, space, userId, pending])
  useEffect(() => {
    setRecords([]); setReport(null); setPrecheck(null); setDismissed(false); setError(null)
    let disposed = false
    let unlisten: (() => void) | undefined
    const receive = (event: MigrationProgress): void => {
      const current = useStore.getState()
      if (disposed || !acceptsMigrationProgress(event, current.activeSpace, current.currentUser?.id, current.spacePending)) return
      void refresh()
      if (['completed', 'cancelled'].includes(event.state) && !reported.current.has(event.localMigrationId)) {
        reported.current.add(event.localMigrationId)
        // Imported entries and their downloads land after the list was loaded.
        window.dispatchEvent(new Event(LIBRARY_ENTRIES_CHANGED_EVENT))
        void migrationReport(event.localMigrationId).then(value => {
          if (!disposed && identityRef.current === identity) setReport(value)
        }).catch(() => { if (!disposed) setError('未能读取迁移报告，可在同步与迁移中重试') })
      }
    }
    void listen<MigrationProgress>('migration-progress', event => receive(event.payload)).then(stop => {
      if (disposed) stop(); else unlisten = stop
    }).catch(() => { if (!disposed) setError('进度通知暂不可用，可刷新迁移记录') })
    void refresh()
    const changed = (): void => { void refresh() }
    window.addEventListener('skillhub-migration-refresh', changed)
    // Also catches a native run that continued while the WebView reloaded.
    const timer = window.setInterval(changed, 2000)
    return () => { disposed = true; unlisten?.(); window.clearInterval(timer); window.removeEventListener('skillhub-migration-refresh', changed) }
  }, [identity, refresh])
  const action = async (work: () => Promise<void>): Promise<void> => {
    if (actionBusy.current) return
    actionBusy.current = true; setBusy(true); setError(null)
    try { await work(); await refresh() }
    catch { if (identityRef.current === identity) setError('未能完成操作，请重试；已成功的内容会保留') }
    finally { actionBusy.current = false; setBusy(false) }
  }
  const run = async (status: MigrationStatus): Promise<void> => {
    if (status.state === 'awaitingChoice') { setPrecheck(status); return }
    await action(async () => { await migrationRun(status.localMigrationId); setDismissed(false) })
  }
  const cancel = async (status: MigrationStatus): Promise<void> => action(async () => {
    await migrationCancel(status.localMigrationId)
    const result = await migrationReport(status.localMigrationId)
    if (identityRef.current === identity && result.state === 'cancelled') setReport(result)
  })
  const activity: Activity = { records, error, busy, refresh, run, cancel, showReport: status => {
    void action(async () => {
      const result = await migrationReport(status.localMigrationId)
      if (identityRef.current === identity) setReport(result)
    })
  } }
  const current = records.find(item => item.state === 'running') ?? records.find(unfinishedMigration)
  return <MigrationContext.Provider value={activity}>
    {children}
    {!pending && current && !dismissed && <aside className="migration-notice" aria-label="迁移通知">
      <MigrationStatusRow status={current} />
      <button className="btn btn-ghost btn-sm" onClick={() => setDismissed(true)}>收起提示</button>
    </aside>}
    {report && <FocusTrapDialog className="modal-layer" label="迁移报告" onEscape={() => setReport(null)}>
      <div className="modal-card migration-dialog">
        <div className="modal-head"><h2>迁移报告</h2></div>
        <p className="inline-status">{migrationState(report.state)} · {migrationSummary(report)}{report.lastError && ` · ${migrationReason(report.lastError)}`}</p>
        <p className="connection-caption">待处理增量 {migrationCounts(report).pendingDelta}：快照之后原账号中的修改未迁移</p>
        <div className="migration-scroll">
          {report.items.map(item => <div className="migration-report-item" key={item.id}>
            <b>{item.name}</b> · {migrationState(item.state)}
            {migrationResultReason(item) && <p className="connection-caption">{migrationResultReason(item)}</p>}
            {item.pendingDelta && <p className="connection-caption">{migrationReason('PENDING_DELTA')}</p>}
            {item.warnings.some(code => code === 'AVATAR_SKIPPED') && <p className="connection-caption">头像跳过：{migrationReason('AVATAR_SKIPPED')}（{item.warnings.filter(code => code === 'AVATAR_SKIPPED').length}）</p>}
            {item.avatars.filter(avatar => avatar.status === 'skipped').map(avatar => <p className="connection-caption" key={avatar.id}>头像跳过：{migrationReason(avatar.code ?? 'AVATAR_STYLE_UNAVAILABLE')}</p>)}
          </div>)}
          <div className="migration-report-item"><b>个人钥匙</b>
            {!report.keys.length ? <p className="connection-caption">未选择复制</p> : report.keys.map(key => <p className="connection-caption" key={key.name}>
              {key.name} · {!report.keysDone ? '尚未完成' : report.keyResults.find(result => result.name === key.name)?.status === 'copied' ? '已复制' : report.keyResults.find(result => result.name === key.name)?.status === 'skipped' ? '已跳过（目标同名）' : '已处理'}
              {key.conflict.action === 'rename' && ` · 目标名称：${key.conflict.name}`}
            </p>)}
          </div>
        </div>
        <div className="modal-actions"><button className="btn btn-primary" onClick={() => setReport(null)}>关闭</button></div>
      </div>
    </FocusTrapDialog>}
    {precheck && <MigrationPrecheck status={precheck} switching={false} onCancel={() => setPrecheck(null)} onConfirm={async (items, keys) => {
      await migrationSetChoices(precheck.localMigrationId, { items, keys })
      await migrationRun(precheck.localMigrationId)
      setPrecheck(null); setDismissed(false); await refresh()
    }} />}
  </MigrationContext.Provider>
}

export function MigrationStatusRow({ status }: { status: MigrationStatus }) {
  const { run, cancel, showReport, error, busy } = useMigrationActivity()
  const count = migrationCounts(status)
  const running = status.state === 'running'
  const next = status.items.find(item => item.state === 'submitting') ?? status.items.find(item => item.state === 'pending')
  return <div>
    <div className="settings-row-info"><b>{running ? '正在迁移 Skill' : unfinishedMigration(status) ? '有未完成的迁移' : migrationState(status.state)}</b>
      <span role="status">{running ? `${count.done}/${status.items.length} · ${next?.name ?? '正在整理数据'}` : migrationSummary(status)}</span>
      {!running && status.lastError && <span>{migrationReason(status.lastError)}</span>}
    </div>
    {running && <progress className="migration-progress" max={Math.max(status.items.length, 1)} value={count.done} aria-label="迁移进度" />}
    <div className="migration-actions">
      {!running && unfinishedMigration(status) && <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => void run(status)}>继续</button>}
      <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => showReport(status)}>查看报告</button>
      {(running || unfinishedMigration(status)) && <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void cancel(status)}>{running ? '取消' : '放弃'}</button>}
    </div>
    {error && <p className="inline-status" role="alert">{error}</p>}
  </div>
}

export default function MigrationSettings() {
  const space = useStore(state => state.activeSpace)
  const userId = useStore(state => state.currentUser?.id)
  const pending = useStore(state => state.spacePending)
  const { records, error, refresh } = useMigrationActivity()
  const [choosing, setChoosing] = useState(false)
  const [source, setSource] = useState('official')
  const [address, setAddress] = useState('')
  const latest = records[0]
  const unfinished = records.filter(item => unfinishedMigration(item) && item.localMigrationId !== latest?.localMigrationId)
  return <>
    <div className="settings-row"><div className="settings-row-info">
      <b>从其他服务器迁移 Skill</b><span>{space?.spaceId === 'local' ? '从本机迁移到服务器请先连接服务器' : '复制 Skill，保留原账号的数据。'}</span>
    </div>{space?.spaceId !== 'local' && <button className="btn btn-ghost btn-sm" disabled={!userId || pending} onClick={() => setChoosing(true)}>选择来源</button>}</div>
    {latest && <div className="settings-row"><MigrationStatusRow status={latest} /></div>}
    {unfinished.map(item => <div className="settings-row" key={item.localMigrationId}><MigrationStatusRow status={item} /></div>)}
    {!latest && error && <div className="settings-row"><span className="inline-status" role="alert">{error}</span><button className="btn btn-ghost btn-sm" onClick={() => void refresh()}>重试</button></div>}
    {choosing && <FocusTrapDialog className="modal-layer" label="选择迁移来源" onEscape={() => setChoosing(false)}>
      <div className="modal-card migration-dialog">
        <div className="modal-head"><h2>选择迁移来源</h2></div>
        <label><input type="radio" name="migration-source" checked={source === 'official'} onChange={() => setSource('official')} />一探官方</label>
        <label><input type="radio" name="migration-source" checked={source === 'selfhost'} onChange={() => setSource('selfhost')} />其他自部署服务器</label>
        {source === 'selfhost' && <input className="form-input" aria-label="来源服务器地址" placeholder="http://127.0.0.1:3001" value={address} onChange={event => setAddress(event.target.value)} />}
        <label><input type="radio" name="migration-source" checked={source === 'local'} onChange={() => setSource('local')} />这台电脑的本机 Skill</label>
        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={() => setChoosing(false)}>取消</button>
          <button className="btn btn-primary" disabled={source === 'selfhost' && !address.trim()} onClick={() => {
            setChoosing(false)
            window.dispatchEvent(new CustomEvent('skillhub-connect-server', { detail: { target: source === 'selfhost' ? address.trim() : source, report: null, migrationSource: true } }))
          }}>继续</button>
        </div>
      </div>
    </FocusTrapDialog>}
  </>
}
