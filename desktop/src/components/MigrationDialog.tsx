import { useEffect, useRef, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { authState, migrationCancel, migrationKeyNames, migrationSetChoices, migrationSnapshotBegin,
  type MigrationItemChoice, type MigrationKeyChoice, type MigrationKeyName, type MigrationStatus, type SpaceHandle } from '../lib/tauri.js'
import type { SpaceCommitChoice } from '../lib/spaces.js'
import { copyName, defaultMigrationChoices, migrationCategory, migrationChoiceError, migrationCounts,
  migrationGroup, migrationKeyError, migrationKeys, migrationReason, migrationState, migrationCommitChoice, migrationSnapshotError, migrationAvatarSkipped, type MigrationProgress } from '../lib/migration-ui.js'
import FocusTrapDialog from './FocusTrapDialog.js'
import './MigrationDialog.css'

export function MigrationPrecheck({ status, switching, onConfirm, onCancel, externalError }: {
  status: MigrationStatus; switching: boolean
  externalError?: string
  onConfirm: (items: MigrationItemChoice[], keys: MigrationKeyChoice[]) => Promise<void>
  onCancel: () => void
}) {
  const [choices, setChoices] = useState(() => defaultMigrationChoices(status))
  const [copyKeys, setCopyKeys] = useState(false)
  const [names, setNames] = useState<MigrationKeyName[] | null>(null)
  const [keys, setKeys] = useState<MigrationKeyChoice[]>([])
  const [error, setError] = useState<string | null>(null)
  const [keyError, setKeyError] = useState(false)
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)
  const count = migrationCounts(status)
  useEffect(() => {
    if (!copyKeys) return
    let active = true
    setKeyError(false)
    void migrationKeyNames(status.localMigrationId).then(value => { if (active) setNames(value) })
      .catch(() => { if (active) setKeyError(true) })
    return () => { active = false }
  }, [copyKeys, status.localMigrationId])
  const selectedKeys = migrationKeys(copyKeys, keys)
  const invalid = choices.map(choice => migrationChoiceError(choice, status.items.find(item => item.id === choice.id)!)).find(Boolean)
    ?? migrationKeyError(selectedKeys)
  const setChoice = (choice: MigrationItemChoice): void => setChoices(current => current.map(item => item.id === choice.id ? choice : item))
  const setKey = (key: MigrationKeyChoice): void => setKeys(current => current.map(item => item.name === key.name ? key : item))
  const submit = async (): Promise<void> => {
    if (savingRef.current || invalid) return
    savingRef.current = true
    setSaving(true); setError(null)
    try { await onConfirm(choices, selectedKeys) }
    catch { setError('未能保存迁移选择，请重试') }
    finally { savingRef.current = false; setSaving(false) }
  }
  return <FocusTrapDialog className="modal-layer migration-dialog-layer" label="确认迁移内容" onEscape={onCancel} escapeDisabled={saving}>
    <div className="modal-card migration-dialog">
      <div className="modal-head"><div><span className="eyebrow">账号与数据</span><h2>确认迁移内容</h2></div></div>
      <p className="inline-status" role="status">可迁 {count.ready} · 跳过 {count.skipped} · 冲突 {count.conflicts} · 超额 {count.overQuota} · 待处理增量 {count.pendingDelta}</p>
      <p className="connection-caption">目标配额：未删除的 Skill 最多 {String(status.limits.skills ?? '不限')} 个（含回收站在内总记录最多 {String(status.limits.skillRecords ?? '不限')} 条） · 账号内容包总存储上限 {typeof status.limits.packageStorageBytes === 'number' ? `${Math.round(status.limits.packageStorageBytes / 1024 / 1024)} MiB` : '不限'} · 头像数量{status.limits.avatarCount == null ? '不限' : `最多 ${String(status.limits.avatarCount)} 个`}</p>
      <div className="migration-scroll">
        {['自己的 Skill', '商店安装', '团队共享'].map(group => {
          const items = status.items.filter(item => migrationGroup(item) === group)
          if (!items.length) return null
          return <section key={group} aria-label={group}><p className="settings-label">{group}</p><div className="settings-group">
            {items.map(item => {
              const choice = choices.find(choice => choice.id === item.id)
              const conflict = item.precheck?.status === 'conflict' || item.state === 'awaitingChoice'
              return <div className="migration-item" key={item.id}>
                <div className="settings-row"><div className="settings-row-info"><b>{item.name}</b>
                  <span>{migrationCategory(item)} · 头像 {item.avatarCount}</span>
                  <span>{migrationState(item.state)}{(item.reason || item.precheck?.reason) && ` · ${migrationReason(item.reason || item.precheck?.reason || '')}`}</span>
                  {item.pendingDelta && <span>{migrationReason('PENDING_DELTA')}</span>}
                  {migrationAvatarSkipped(item) > 0 && <span>头像跳过：{migrationAvatarSkipped(item)}</span>}
                </div></div>
                {conflict && choice && <fieldset className="migration-choices" disabled={saving}>
                  <legend className="connection-caption">{item.name} 的处理方式</legend>
                  <label><input type="radio" name={`choice-${item.id}`} checked={choice.action === 'skip'} onChange={() => setChoice({ id: item.id, action: 'skip' })} />跳过</label>
                  {item.category !== 'reacquire' && <>
                    <label><input type="radio" name={`choice-${item.id}`} checked={choice.action === 'copy'} onChange={() => setChoice({ id: item.id, action: 'copy', targetName: copyName(item.name) })} />保留为副本</label>
                    {choice.action === 'copy' && <input className="form-input" aria-label={`${item.name} 的目标名称`} value={choice.targetName ?? copyName(item.name)} onChange={event => setChoice({ id: item.id, action: 'copy', targetName: event.target.value })} />}
                    <label><input type="radio" name={`choice-${item.id}`} disabled={!item.precheck?.existingSkillId} checked={choice.action === 'map'} onChange={() => { if (item.precheck?.existingSkillId) setChoice({ id: item.id, action: 'map', mapToSkillId: item.precheck.existingSkillId }) }} />确认映射到已有 Skill</label>
                    <span className="connection-caption">视为同一个 Skill，不导入内容</span>
                  </>}
                </fieldset>}
              </div>
            })}
          </div></section>
        })}
        {!status.items.length && <p className="connection-caption">没有可迁移的 Skill。</p>}
        <section className="migration-keys">
          <label><input type="checkbox" checked={copyKeys} disabled={saving} onChange={event => setCopyKeys(event.target.checked)} />同时复制个人钥匙</label>
          <p className="connection-caption">只在本机复制，服务器拿不到钥匙值；首次运行时需要重新授权。</p>
          {copyKeys && <>
            {keyError ? <p role="alert">未能读取钥匙名称，请取消勾选后重试。</p> : names === null ? <p role="status">正在读取钥匙名称…</p> : !names.length ? <p className="connection-caption">源空间没有个人钥匙。</p> : names.map(key => {
              const selected = keys.find(item => item.name === key.name)
              return <div className="migration-key" key={key.name}>
                <label><input type="checkbox" disabled={saving} checked={!!selected} onChange={event => setKeys(current => event.target.checked ? [...current, { name: key.name, conflict: { action: 'skip' } }] : current.filter(item => item.name !== key.name))} />{key.name} <span className="connection-caption">授权 {key.authorizedSkillCount} 个 Skill{key.conflict ? ' · 目标已有同名钥匙' : ''}</span></label>
                {selected && key.conflict && <div className="migration-key-actions">
                  <select className="form-input" disabled={saving} aria-label={`${key.name} 同名处理`} value={selected.conflict.action} onChange={event => {
                    const action = event.target.value
                    setKey({ name: key.name, conflict: action === 'rename' ? { action, name: `${key.name.slice(0, 98)}_2` } : { action: action === 'overwrite' ? 'overwrite' : 'skip' } })
                  }}><option value="skip">跳过</option><option value="overwrite">覆盖</option><option value="rename">重命名</option></select>
                  {selected.conflict.action === 'rename' && <input className="form-input" disabled={saving} aria-label={`${key.name} 的新名称`} value={selected.conflict.name} onChange={event => setKey({ name: key.name, conflict: { action: 'rename', name: event.target.value } })} />}
                </div>}
              </div>
            })}
          </>}
        </section>
      </div>
      {(invalid || error || externalError) && <p className="inline-status" role="alert">{invalid || error || externalError}</p>}
      <div className="modal-actions">
        <button className="btn btn-ghost" disabled={saving} onClick={onCancel}>{switching ? '不迁移，只切换' : '取消'}</button>
        <button className="btn btn-primary" disabled={saving || !!invalid || copyKeys && (names === null || keyError)} onClick={() => void submit()}>{saving ? '正在保存…' : '开始迁移'}</button>
      </div>
    </div>
  </FocusTrapDialog>
}

type Flow = { source: SpaceHandle; target: SpaceHandle; again: boolean; phase: 'ask' | 'snapshot' | 'precheck'; status?: MigrationStatus; error?: string }
export function useMigrationFlow() {
  const [flow, setFlow] = useState<Flow | null>(null)
  const flowRef = useRef<Flow | null>(null)
  const resolve = useRef<((choice: SpaceCommitChoice) => void) | null>(null)
  const migrationId = useRef<string | null>(null)
  const snapshotId = useRef<string | null>(null)
  const cancelled = useRef(false)
  const mounted = useRef(true)
  const stopListen = useRef<(() => void) | null>(null)
  const update = (next: Flow | null): void => { flowRef.current = next; if (mounted.current) setFlow(next) }
  const finish = (choice: SpaceCommitChoice): void => { update(null); resolve.current?.(choice); resolve.current = null }
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false; cancelled.current = true
      stopListen.current?.()
      if (snapshotId.current) void migrationCancel(snapshotId.current).catch(() => {})
      resolve.current?.('取消'); resolve.current = null
    }
  }, [])
  const snapshot = async (input: Flow): Promise<void> => {
    if (flowRef.current?.phase === 'snapshot') return
    cancelled.current = false; snapshotId.current = null
    update({ ...input, phase: 'snapshot', error: undefined })
    try {
      const pending = await authState()
      const target = input.again ? { spaceId: pending.spaceId, generation: pending.generation } : input.target
      const stop = await listen<MigrationProgress>('migration-progress', event => {
        if (event.payload.state !== 'snapshotting' || event.payload.space?.spaceId !== target.spaceId || event.payload.space.generation !== target.generation) return
        snapshotId.current = event.payload.localMigrationId
        if (cancelled.current) void migrationCancel(event.payload.localMigrationId).catch(() => {})
      })
      stopListen.current = stop
      if (!mounted.current) { stop(); return }
      const kind = (input.again ? input.target : input.source).spaceId === 'local' ? 'local' : input.again ? 'candidate' : 'pending'
      const status = await migrationSnapshotBegin(kind, { space: target })
      snapshotId.current = status.localMigrationId
      if (cancelled.current || !mounted.current) {
        await migrationCancel(status.localMigrationId)
        if (input.again) finish('取消'); else update({ ...input, phase: 'ask', error: '已取消读取，可只切换或取消连接。' })
      } else update({ ...input, phase: 'precheck', status })
    } catch (error: unknown) {
      if (mounted.current) {
        if (input.again && cancelled.current) finish('取消')
        else update({ ...input, phase: 'ask', error: cancelled.current ? '已取消读取，可只切换或取消连接。' : migrationSnapshotError(error) })
      }
    } finally { stopListen.current?.(); stopListen.current = null }
  }
  const begin = (source: SpaceHandle, target: SpaceHandle, again = false): Promise<SpaceCommitChoice> => {
    migrationId.current = null
    if (!again && (source.spaceId === target.spaceId || target.spaceId === 'local')) return Promise.resolve('只切换')
    const next: Flow = { source, target, again, phase: 'ask' }
    return new Promise(done => {
      resolve.current = done
      update(next)
      if (again) void snapshot(next)
    })
  }
  const dismissPrecheck = async (): Promise<void> => {
    if (!flow?.status) return
    try { await migrationCancel(flow.status.localMigrationId); finish(flow.again ? '取消' : '只切换') }
    catch { update({ ...flow, error: '未能取消迁移，请重试' }) }
  }
  const dialog = flow?.phase === 'precheck' && flow.status
    ? <MigrationPrecheck key={flow.status.localMigrationId} status={flow.status} switching={!flow.again} externalError={flow.error} onCancel={() => void dismissPrecheck()} onConfirm={async (items, keys) => {
      await migrationSetChoices(flow.status!.localMigrationId, { items, keys })
      migrationId.current = flow.status!.localMigrationId
      snapshotId.current = null
      finish(migrationCommitChoice(flow.again))
    }} />
    : flow ? <FocusTrapDialog className="modal-layer migration-dialog-layer" label="迁移 Skill" onEscape={() => { if (flow.phase !== 'snapshot') finish('取消') }} escapeDisabled={flow.phase === 'snapshot'}>
      <div className="modal-card migration-dialog">
        <div className="modal-head"><h2>{flow.phase === 'snapshot' ? '正在读取原账号的 Skill…' : '是否把原账号的 Skill 迁移到当前账号？'}</h2></div>
        <p className="modal-copy">复制并保留原账号的数据；不迁移账号、团队、密码与团队钥匙。</p>
        {flow.error && <p className="inline-status" role="alert">{flow.error}</p>}
        <div className="modal-actions">
          {flow.phase === 'snapshot' ? <button className="btn btn-ghost" onClick={() => {
            cancelled.current = true
            if (snapshotId.current) void migrationCancel(snapshotId.current).catch(() => { update({ ...flow, error: '取消未完成，正在等待读取结束。' }) })
            update({ ...flow, error: '正在取消…' })
          }}>取消</button> : <>
            <button className="btn btn-ghost" onClick={() => finish('取消')}>取消</button>
            {!flow.again && <button className="btn btn-ghost" onClick={() => finish('只切换')}>只切换</button>}
            <button className="btn btn-primary" onClick={() => void snapshot(flow)}>{flow.again ? '重试' : '迁移并切换'}</button>
          </>}
        </div>
      </div>
    </FocusTrapDialog> : null
  return { begin, migrationId, dialog }
}
