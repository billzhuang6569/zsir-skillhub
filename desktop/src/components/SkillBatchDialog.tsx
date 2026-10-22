import { useEffect, useRef, useState } from 'react'
import { useStore, type LocalSkill } from '../store/index.js'
import { readAuthSpace } from '../store/index.js'
import { ApiError, apiGetTeams, apiGetTeamSkills, apiGetSkillVersions, apiShareSkillToTeam } from '../lib/api.js'
import { librarySharePreflight, getLocalSkills } from '../lib/tauri.js'
import { cloudOperationReason, cloudSelectionId, isRetryableCloudBatchResult, runCloudBatch, type BatchResult } from '../lib/cloud-selection.js'
import { requestLibrarySync } from '../lib/library-sync.js'
import { startAccountDeleteBatch } from '../lib/account-delete-flow.js'
import { shareSkillWithServerSync, shareVersionReadbackUnknown } from '../lib/team-share-flow.js'
import { prepareAccountTeamShare, SharePreparationUnknown, type ShareVersionReceipt } from '../lib/prepare-account-share.js'
import { userMessage } from '../lib/user-message.js'
import FocusTrapDialog from './FocusTrapDialog.js'
import './SkillControls.css'

export default function SkillBatchDialog({ skills, action, onClose }: {
  skills: LocalSkill[]; action: 'share' | 'delete'; onClose: () => void
}) {
  const [frozen] = useState(() => skills.map(skill => ({ ...skill })))
  const [accountId] = useState(() => useStore.getState().currentUser?.id ?? null)
  const [space] = useState(readAuthSpace)
  const teams = useStore(state => state.teams)
  const syncEnabled = useStore(state => state.librarySyncEnabled)
  const currentUser = useStore(state => state.currentUser)
  const [teamId, setTeamId] = useState(teams[0]?.id ?? '')
  const [results, setResults] = useState<BatchResult[]>([])
  const [busy, setBusy] = useState(false)
  const [started, setStarted] = useState(false)
  const [online, setOnline] = useState(navigator.onLine)
  const [teamPreview, setTeamPreview] = useState<{ teamId: string; sharedIds: string[]; error: string | null } | null>(null)
  const [previews, setPreviews] = useState<Record<string, { note?: string; error?: string }>>({})
  const [previewAttempt, setPreviewAttempt] = useState(0)
  const cancelled = useRef(false)
  const running = useRef(false)
  const receipts = useRef(new Map<string, { serverId: string } | ShareVersionReceipt>())
  const sessionMatches = (): boolean => Boolean(accountId && space && useStore.getState().currentUser?.id === accountId && readAuthSpace() === space)
  useEffect(() => {
    const update = (): void => setOnline(navigator.onLine)
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    return () => { cancelled.current = true; window.removeEventListener('online', update); window.removeEventListener('offline', update) }
  }, [])
  useEffect(() => {
    if (currentUser?.id !== accountId) { cancelled.current = true; onClose() }
  }, [accountId, currentUser?.id, onClose])
  useEffect(() => {
    if (action !== 'share' || !teamId || started) return
    let active = true
    setTeamPreview(null)
    setPreviews({})
    void (async (): Promise<void> => {
      try {
        const memberships = await apiGetTeams()
        if (!memberships.some(team => team.id === teamId)) throw new Error('当前账号已无法访问目标团队')
        const shared = await apiGetTeamSkills(teamId)
        if (active && sessionMatches()) setTeamPreview({ teamId, sharedIds: shared.filter(skill => skill.authorId === accountId).map(skill => skill.id), error: null })
        for (const original of frozen) {
          if (!active || !sessionMatches() || !accountId) break
          const local = useStore.getState().skills.find(skill => cloudSelectionId(skill) === cloudSelectionId(original)) ?? original
          if (cloudOperationReason(local, accountId, 'share', syncEnabled, online) || shared.some(skill => skill.id === local.serverId && skill.authorId === accountId)) continue
          try {
            const note = await librarySharePreflight(local.marketplaceLocalId ?? local.id, accountId)
            if (active && sessionMatches()) setPreviews(previous => ({ ...previous, [cloudSelectionId(local)]: { note } }))
          } catch (error: unknown) {
            if (active && sessionMatches()) setPreviews(previous => ({ ...previous, [cloudSelectionId(local)]: { error: `核验失败，可重试：${userMessage(error)}` } }))
          }
        }
      } catch (error: unknown) {
        if (active && sessionMatches()) setTeamPreview({ teamId, sharedIds: [], error: `核验失败，可重试：${userMessage(error)}` })
      }
    })()
    return () => { active = false }
  }, [action, teamId, started, online, previewAttempt])

  const currentSkill = (skill: LocalSkill): LocalSkill => useStore.getState().skills.find(item => cloudSelectionId(item) === cloudSelectionId(skill)) ?? skill
  const reason = (skill: LocalSkill): string | null => cloudOperationReason(currentSkill(skill), accountId, action, syncEnabled, online)
    ?? (action === 'share' ? teamPreview?.teamId !== teamId ? '正在核验团队权限及共享状态' : teamPreview.error : null)
    ?? (action === 'share' && !alreadyShared(skill) ? previews[cloudSelectionId(skill)]?.error ?? (!previews[cloudSelectionId(skill)]?.note ? '正在检查内容及版本' : null) : null)
  const alreadyShared = (skill: LocalSkill): boolean => Boolean(action === 'share' && skill.serverId && teamPreview?.teamId === teamId && teamPreview.sharedIds.includes(skill.serverId))
  const available = frozen.filter(skill => !reason(skill) && !alreadyShared(skill))
  const skipped = frozen.filter(alreadyShared)
  const title = action === 'delete' ? `将 ${frozen.length} 个 Skill 从账号删除` : `将 ${frozen.length} 个 Skill 共享到团队`
  const execute = async (original: LocalSkill): Promise<BatchResult> => {
    const skill = currentSkill(original)
    const base = { id: cloudSelectionId(original), name: original.displayName }
    const blocked = cloudOperationReason(skill, accountId, action, useStore.getState().librarySyncEnabled, navigator.onLine)
    if (blocked) return { ...base, kind: 'failed', message: blocked }
    if (!accountId || !space || !sessionMatches()) return { ...base, kind: 'stopped', message: '账号已切换' }
    let serverId: string | undefined
    let sent = false
    const jobId = `${accountId}:batch:${Date.now()}:${base.id}`
    if (useStore.getState().teamShareJobs[skill.id]) return { ...base, kind: 'failed', message: '这个 Skill 正在共享，请稍后重试' }
    useStore.getState().setTeamShareJob(skill.id, { id: jobId, teamId, action: 'share' })
    try {
      const memberships = await apiGetTeams()
      if (!sessionMatches() || cancelled.current) return { ...base, kind: 'stopped', message: '批次已停止' }
      if (!memberships.some(team => team.id === teamId)) return { ...base, kind: 'failed', message: '当前账号已无法访问目标团队' }
      const shared = await apiGetTeamSkills(teamId)
      if (!sessionMatches() || cancelled.current) return { ...base, kind: 'stopped', message: '批次已停止' }
      if (shared.some(item => item.id === skill.serverId && item.authorId === accountId)) return { ...base, kind: 'skipped', message: '已经共享' }
      // Same author-asset preparation used by the single-item detail flow.
      // Always refresh local state first; never share a stale pending selection.
      const locals = await getLocalSkills()
      if (!sessionMatches() || cancelled.current) return { ...base, kind: 'stopped', message: '批次已停止' }
      const fresh = locals.find(item => item.libraryEntryId === skill.libraryEntryId && item.libraryAccountId === accountId)
      if (!fresh) return { ...base, kind: 'failed', message: '本机副本已变化，请刷新后再试' }
      const freshReason = cloudOperationReason(fresh, accountId, 'share', useStore.getState().librarySyncEnabled, navigator.onLine)
      if (freshReason) return { ...base, kind: 'failed', message: freshReason }
      const prepared = await prepareAccountTeamShare(fresh, accountId, () => sessionMatches() && !cancelled.current)
      if (!sessionMatches() || cancelled.current) return { ...base, kind: 'stopped', message: '批次已停止' }
      const shareable = await shareSkillWithServerSync({ skill: prepared, currentUserId: accountId, teamId,
        sync: async () => prepared,
        share: async (id, target) => {
          if (!sessionMatches() || cancelled.current) throw new Error('批次已停止')
          serverId = id
          receipts.current.set(base.id, { serverId: id })
          sent = true
          await apiShareSkillToTeam(id, target)
        },
      })
      if (sessionMatches()) useStore.getState().replaceSkill(skill.id, { ...shareable, sharedTo: { ...shareable.sharedTo, [teamId]: { version: shareable.version, envShared: false } } })
      return { ...base, kind: 'done', message: 'Skill 已共享，本次未提供个人环境变量值' }
    } catch (error: unknown) {
      if (!sent) {
        if (error instanceof SharePreparationUnknown) receipts.current.set(base.id, error.receipt)
        return { ...base, kind: error instanceof SharePreparationUnknown ? 'unconfirmed' : 'failed', message: userMessage(error) }
      }
      // A lost POST response is settled by a read before it can be retried.
      if (sessionMatches() && serverId) {
        try {
          const shared = await apiGetTeamSkills(teamId)
          if (!sessionMatches()) return { ...base, kind: 'unconfirmed', message: '账号已切换，原账号共享结果待核验' }
          if (shared.some(item => item.id === serverId)) return { ...base, kind: 'done', message: '已读回确认共享成功' }
          return { ...base, kind: 'failed', message: userMessage(error) }
        } catch { /* Keep the ambiguous result separate from confirmed failure. */ }
      }
      return { ...base, kind: error instanceof ApiError && error.kind === 'http' && error.status !== null && error.status < 500 ? 'failed' : 'unconfirmed', message: `${userMessage(error)}；共享状态待核验` }
    } finally { useStore.getState().clearTeamShareJob(skill.id, jobId) }
  }
  const run = async (retry = false): Promise<void> => {
    if (running.current || !sessionMatches()) return
    const targets = retry ? frozen.filter(skill => results.some(result => result.id === cloudSelectionId(skill) && isRetryableCloudBatchResult(result))) : available
    running.current = true; cancelled.current = false; setBusy(true); setStarted(true)
    if (retry) setResults(previous => previous.filter(result => !targets.some(skill => cloudSelectionId(skill) === result.id)))
    else setResults(frozen.filter(skill => !targets.includes(skill)).map(skill => ({ id: cloudSelectionId(skill), name: skill.displayName,
      kind: reason(skill) ? 'ineligible' as const : 'skipped' as const, message: reason(skill) ?? '已经共享' })))
    try {
      await runCloudBatch(targets, () => sessionMatches() && !cancelled.current, execute,
        skill => ({ id: cloudSelectionId(skill), name: skill.displayName }), result => setResults(previous => [...previous, result]))
      if (sessionMatches()) requestLibrarySync()
    } finally { running.current = false; setBusy(false) }
  }
  const reconcile = async (): Promise<void> => {
    if (running.current || !sessionMatches()) return
    running.current = true; setBusy(true)
    const updates = new Map<string, BatchResult>()
    try {
      {
        const shared = await apiGetTeamSkills(teamId)
        if (!sessionMatches()) return
        for (const result of results.filter(item => item.kind === 'unconfirmed')) {
          const receipt = receipts.current.get(result.id)
          if (!receipt) continue
          if ('version' in receipt) {
            const versions = await apiGetSkillVersions(receipt.serverId)
            if (!sessionMatches()) return
            updates.set(result.id, { ...result, kind: 'unconfirmed', message: shareVersionReadbackUnknown(receipt, versions).message })
          } else if (shared.some(skill => skill.id === receipt.serverId)) {
            updates.set(result.id, { ...result, kind: 'done', message: '已读回确认共享成功' })
          } else updates.set(result.id, { ...result, kind: 'failed', message: '已读回确认尚未共享，可重试' })
        }
      }
      if (sessionMatches()) setResults(previous => previous.map(result => updates.get(result.id) ?? result))
    } catch (error: unknown) {
      if (sessionMatches()) setResults(previous => previous.map(result => result.kind === 'unconfirmed' ? { ...result, message: `仍无法核验：${userMessage(error)}` } : result))
    } finally { running.current = false; setBusy(false) }
  }
  if (action === 'delete') {
    // Confirm only (#360): the deletion runs in the background and each row
    // leaves the list on its own; one toast reports anything that needs attention.
    const blocked = frozen.filter(skill => reason(skill))
    return <FocusTrapDialog className="modal-layer above-sheet" label={title} onEscape={onClose}>
      <div className="modal-card skill-dialog compact"><div className="modal-head"><h2>{title}</h2></div>
        <p className="modal-copy">仅删除我的账号副本，其他设备联网后移入回收站，可从设置的账号回收站恢复。已公开或已共享的版本不会自动撤销。</p>
        <div className="skill-batch-items" aria-label="将要删除的 Skill">{frozen.map(skill => {
          const why = reason(skill)
          return <div key={cloudSelectionId(skill)} className={why ? 'blocked' : undefined}><strong>{skill.displayName}</strong>{why && <span>{why}</span>}</div>
        })}</div>
        <div className="modal-actions"><button className="btn btn-ghost" onClick={onClose}>取消</button>
          <button className="btn btn-danger" disabled={!available.length || !sessionMatches()} onClick={() => { startAccountDeleteBatch(available); onClose() }}>{blocked.length > 0 ? `删除 ${available.length} 个` : '删除'}</button></div>
      </div>
    </FocusTrapDialog>
  }
  const labels: Record<BatchResult['kind'], string> = { done: '成功', 'local-pending': '本机待清理', kept: '保留', failed: '失败', unconfirmed: '结果待确认', skipped: '已共享跳过', ineligible: '无法操作', stopped: '未执行' }
  return <FocusTrapDialog className="modal-layer above-sheet" label={title} onEscape={() => { if (busy) cancelled.current = true; else onClose() }}>
    <div className="modal-card skill-dialog"><div className="modal-head"><h2>{title}</h2></div>
      {action === 'share' && <label>目标团队 <select value={teamId} disabled={started} onChange={event => setTeamId(event.target.value)}>{teams.map(team => <option key={team.id} value={team.id}>{team.name}</option>)}</select></label>}
      <p className="modal-copy">本批次仅共享 Skill 内容；个人环境变量值可从单项详情提供。</p>
      {!started && <p>已选 {frozen.length} 个 · 待共享 {available.length} 个 · 已共享 {skipped.length} 个 · 无法操作 {frozen.filter(skill => reason(skill)).length} 个</p>}
      <div className="skill-batch-items">{frozen.map(skill => {
        const result = results.find(item => item.id === cloudSelectionId(skill))
        return <div key={cloudSelectionId(skill)}><strong>{skill.displayName}</strong><span>{result ? `${labels[result.kind]}：${result.message}` : reason(skill) ?? (alreadyShared(skill) ? '已经共享' : busy ? '等待执行' : previews[cloudSelectionId(skill)]?.note ?? '可以操作')}</span></div>
      })}</div>
      {started && <p role="status">{Object.entries(labels).map(([kind, label]) => `${label} ${results.filter(result => result.kind === kind).length}`).join(' · ')}</p>}
      <div className="modal-actions"><button className="btn btn-ghost" onClick={() => { if (busy) cancelled.current = true; else onClose() }}>{busy ? '停止后续项目' : started ? '关闭' : '取消'}</button>
        {!started && action === 'share' && (teamPreview?.error || Object.values(previews).some(preview => preview.error)) && <button className="btn btn-soft" disabled={!sessionMatches() || !online} onClick={() => setPreviewAttempt(attempt => attempt + 1)}>重试核验</button>}
        {!started && <button className="btn btn-primary" disabled={!available.length || !sessionMatches() || !teamId} onClick={() => void run()}>共享可用的 {available.length} 个</button>}
        {started && !busy && results.some(isRetryableCloudBatchResult) && <button className="btn btn-primary" disabled={!sessionMatches()} onClick={() => void run(true)}>重试已确认失败的项目</button>}
        {started && !busy && results.some(result => result.kind === 'unconfirmed' || result.kind === 'local-pending') && <button className="btn btn-soft" onClick={() => void reconcile()}>读回核验待确认项</button>}
      </div>
    </div>
  </FocusTrapDialog>
}
