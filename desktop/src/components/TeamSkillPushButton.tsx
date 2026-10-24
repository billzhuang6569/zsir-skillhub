import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore, type LocalSkill, type Team } from '../store/index.js'
import { ApiError, apiCreateSkillVersion, apiGetSkillVersions, apiPushTeamVersion, apiTeamPushInfo, apiDownloadSkillPackage, sameSpace } from '../lib/api.js'
import { createSkillPackage, readSkillMd, getLocalSkills, getSkillVersionState, getSkillTree, recordSkillFormalVersion, getSkillPackageDiff, getSkillPackageFileDiffs, type SkillDiffLine, type SkillPackageFileDiff, type SkillTreeEntry } from '../lib/tauri.js'
import { matchesPushContent, teamPushError, teamPushPlan } from '../lib/team-push-plan.js'
import { buildReviewTree, diffRowsWithHunkSeparators } from '../lib/team-push-review.js'
import ConfirmModal from './ConfirmModal.js'
import FocusTrapDialog from './FocusTrapDialog.js'
import VersionChange from './VersionChange.js'
import InfoRows from './InfoRows.js'
import { Icon } from './Icon.js'
import './TeamSkillPushButton.css'
import { toast } from './Toast.js'

function statusLabel(status: SkillPackageFileDiff['status']): string {
  return status === 'added' ? '新增' : status === 'deleted' ? '已删除' : '已修改'
}

export default function TeamSkillPushButton({ skill, team }: { skill: LocalSkill; team: Team }) {
  const [info, setInfo] = useState<Awaited<ReturnType<typeof apiTeamPushInfo>> | null>(null)
  const [pack, setPack] = useState<Awaited<ReturnType<typeof createSkillPackage>> | null>(null)
  const [open, setOpen] = useState(false)
  const [reviewOpen, setReviewOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [version, setVersion] = useState<string | null>(null)
  const [full, setFull] = useState(false)
  const [note, setNote] = useState('')
  const [diff, setDiff] = useState<[number, SkillDiffLine[]] | null>(null)
  const [fileDiffs, setFileDiffs] = useState<SkillPackageFileDiff[]>([])
  const [tree, setTree] = useState<SkillTreeEntry[]>([])
  const [onlyChanged, setOnlyChanged] = useState(false)
  const [selectedPath, setSelectedPath] = useState('')
  const sidebarWidth = useStore(state => state.sidebarWidth)
  const request = useRef<Parameters<typeof apiCreateSkillVersion>[1] | null>(null)
  const published = useRef<string | null>(null)
  const receiptId = useRef<string | undefined>(undefined)
  const session = useRef<string | null>(null)
  const sessionKey = (): string => JSON.stringify([useStore.getState().activeSpace, useStore.getState().currentUser?.id])
  const reviewTree = useMemo(() => buildReviewTree(tree, fileDiffs), [tree, fileDiffs])
  const visibleTree = reviewTree.filter(entry => !onlyChanged || entry.status)
  const selectedDiff = fileDiffs.find(file => file.path === selectedPath)
  const selectedRows = useMemo(() => selectedDiff ? diffRowsWithHunkSeparators(selectedDiff.lines) : [], [selectedDiff])
  const same = Boolean(info && pack && matchesPushContent(info, pack))

  useEffect(() => {
    if (open) return
    const { activeSpace } = useStore.getState()
    if (!activeSpace || !skill.serverId || !skill.localPath) return
    let active = true
    void Promise.all([apiTeamPushInfo(skill.serverId, team.id, activeSpace), createSkillPackage(skill.id)]).then(async ([remote, local]) => {
      if (!remote.contentIdentity) {
        const before = await apiDownloadSkillPackage(skill.serverId!, activeSpace, team.id)
        if (before.version !== remote.version || (remote.versionId && before.versionId !== remote.versionId)) return
        if ((await getSkillPackageDiff(skill.id, before.base64, before.sha256))[0] === 0) remote.contentIdentity = local
      }
      if (active && sameSpace(activeSpace, useStore.getState().activeSpace)) { setInfo(remote); setPack(local) }
    }).catch(() => { if (active) setError('无法检查团队版本，请确认服务器支持团队推送并重试') })
    return () => { active = false }
  }, [skill.id, skill.serverId, skill.workingCopyHash, skill.version, team.id, open])
  const prepare = async (refresh = false): Promise<void> => {
    const space = useStore.getState().activeSpace
    if (!skill.serverId || !space || (busy && !refresh)) return
    request.current = null
    published.current = null
    session.current = sessionKey()
    setVersion(null); setDiff(null); setFileDiffs([]); setTree([]); setSelectedPath('')
    setOpen(true); setReviewOpen(false); setBusy(true); setError('')
    try {
      const [versions, state, local, currentInfo, skills] = await Promise.all([apiGetSkillVersions(skill.serverId), getSkillVersionState(skill.id), createSkillPackage(skill.id), apiTeamPushInfo(skill.serverId, team.id, space), getLocalSkills()])
      setPack(local)
      setInfo(currentInfo)
      const fresh = skills.find(item => item.id === skill.id)
      const plan = teamPushPlan(versions, local, state, fresh?.version ?? skill.version, currentInfo.versionId, Boolean(fresh && !fresh.hasWorkingCopy))
      let existing = plan.existing
      receiptId.current = plan.receiptId
      published.current = existing?.id ?? null
      if (existing) setNote(existing.changelog ?? '')
      const before = await apiDownloadSkillPackage(skill.serverId, space, team.id)
      if (before.version !== currentInfo.version || (currentInfo.versionId && before.versionId && currentInfo.versionId !== before.versionId)) throw new Error('团队版本已被更新，请重新确认')
      const [changes, byFile, localTree] = await Promise.all([
        getSkillPackageDiff(skill.id, before.base64, before.sha256),
        getSkillPackageFileDiffs(skill.id, before.base64, before.sha256),
        getSkillTree(skill.id),
      ])
      setDiff(changes); setFileDiffs(byFile); setTree(localTree)
      if (byFile[0]) setSelectedPath(byFile[0].path)
      if (changes[0] === 0) {
        setInfo({ ...currentInfo, contentIdentity: local })
        existing = versions.find(item => item.id === currentInfo.versionId) ?? existing
        published.current = existing?.id ?? null
      }
      if (session.current !== sessionKey()) throw new Error('账号已切换，请重新打开推送确认框')
      setVersion(existing?.version ?? plan.version)
      setFull(!existing && versions.length >= 30)
      if (!existing && state.pending) setError('本机版本尚未完成账号同步。请先完成同步，再重新打开推送窗口。')
    } catch (reason) { setError(teamPushError(reason)) }
    finally { setBusy(false) }
  }
  const push = async (): Promise<void> => {
    const { activeSpace, currentUser } = useStore.getState()
    if (!activeSpace || !currentUser || !skill.serverId || !pack || !version || !info || busy) return
    const current = (): boolean => sameSpace(activeSpace, useStore.getState().activeSpace) && currentUser.id === useStore.getState().currentUser?.id
    setBusy(true); setError('')
    try {
      if (session.current !== sessionKey()) throw new Error('账号已切换，请重新打开推送确认框')
      if (!request.current) {
        const [latest, skillMd] = await Promise.all([createSkillPackage(skill.id), readSkillMd(skill.id)])
        if (latest.sha256 !== pack.sha256) throw new Error('内容已变化，请重新打开推送确认框')
        request.current = { version, changelog: note.trim(), skillMd, packageBase64: pack.base64, packageSha256: pack.sha256, libraryVersionReceiptId: receiptId.current,
          envDependencies: skill.envDeps.map(({ key, description, required, obtain }) => ({ key, description, required, obtain })) }
      }
      if (!current()) throw new Error('账号已切换')
      if (!published.current) published.current = (await apiCreateSkillVersion(skill.serverId, request.current)).id
      if (!current()) throw new Error('账号已切换')
      await recordSkillFormalVersion(skill.id, published.current)
      if (!current()) throw new Error('账号已切换')
      await apiPushTeamVersion(skill.serverId, team.id, published.current, info.versionId, activeSpace)
      if (!current()) return
      const state = useStore.getState()
      state.setSkills(state.skills.map(item => item.id === skill.id ? { ...item, sharedTo: { ...item.sharedTo, [team.id]: { version, envShared: false } } } : item))
      setInfo(await apiTeamPushInfo(skill.serverId, team.id, activeSpace))
      request.current = null; published.current = null; setOpen(false); setReviewOpen(false)
      window.dispatchEvent(new Event('skillhub:refresh-team-shares'))
      toast('已发布并推送到当前团队')
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 409 && reason.code === 'TEAM_VERSION_CHANGED') {
        await prepare(true)
        setError('团队版本已被更新，请重新确认')
      } else setError(teamPushError(reason))
    }
    finally { setBusy(false) }
  }

  return <>
    {!same && info && <span className="chip">有未推送修改</span>}
    <button className="btn btn-soft btn-sm" disabled={same || busy || !info || !pack} title={error || undefined} onClick={() => void prepare()}>{same ? '已是最新' : '推送更新'}</button>
    {open && !reviewOpen && <ConfirmModal eyebrow="团队推送" title={`推送到「${team.name}」`} description="发布此版本后，当前团队中已获取该 Skill 的成员会收到更新通知。其他团队不受影响。"
      confirmLabel={same ? '已是最新' : '发布并推送'} busy={busy} confirmDisabled={full || !version || same}
      onCancel={() => setOpen(false)} onConfirm={() => void push()}>
      <div className="team-push-confirm-body">
        <VersionChange current={info?.version ?? '正在检查…'} next={version ?? '正在检查…'} />
        <InfoRows rows={[{ label: '变化文件', value: `${diff?.[0] ?? 0} 个` }, { label: '将通知', value: `${info?.recipientCount ?? 0} 人` }]} />
        <button type="button" className="btn btn-soft team-push-review-link" onClick={() => setReviewOpen(true)} disabled={busy}>查看区别</button>
        <div className="form-stack"><label>更新说明（可选）<textarea autoFocus value={note} onChange={event => setNote(event.target.value)} disabled={busy || Boolean(request.current) || Boolean(published.current)} maxLength={500} rows={3} /></label></div>
        {full && <div className="banner banner-warn" role="alert">30 个版本名额已用尽，无法发布。</div>}{error && <div role="alert" className="banner banner-error">{error}</div>}
      </div>
    </ConfirmModal>}
    {open && reviewOpen && <FocusTrapDialog className="modal-layer above-sheet team-review-layer" style={{ left: `${sidebarWidth}px` }} label="审阅团队更新" onEscape={() => setReviewOpen(false)}>
      <div className="team-review-screen">
      <header className="team-review-header"><div className="team-review-heading"><span className="eyebrow">团队推送</span><h2>审阅更新</h2></div><button type="button" className="ico-btn" aria-label="返回推送确认" title="返回推送确认" onClick={() => setReviewOpen(false)}><Icon name="x" size={16} /></button>
        <div className="team-review-summary"><VersionChange current={info?.version ?? '—'} next={version ?? '—'} /><InfoRows rows={[{ label: '变化文件', value: `${diff?.[0] ?? 0} 个` }, { label: '将通知', value: `${info?.recipientCount ?? 0} 人` }]} /></div>
      </header>
      <div className="team-review-workspace">
        <aside className="skill-tree-panel team-review-tree" aria-label="Skill 文件结构">
          <select className="team-review-file-select" value={selectedPath} onChange={event => setSelectedPath(event.target.value)} aria-label="选择变化文件">{reviewTree.filter(entry => entry.kind === 'file').map(entry => <option key={entry.path} value={entry.path}>{entry.path}{entry.status ? ` · ${statusLabel(entry.status)}` : ''}</option>)}</select>
          <div className="details-panel-head"><div><h3>文件结构</h3><p>{fileDiffs.length} 个文件有变化</p></div><label className="team-review-filter"><input type="checkbox" checked={onlyChanged} onChange={event => setOnlyChanged(event.target.checked)} />只看有变化的文件</label></div>
          <ul className="skill-tree-list">{visibleTree.map(entry => {
            const change = fileDiffs.find(file => file.path === entry.path)
            const status = change?.status ?? entry.status
            return <li key={entry.path} className={entry.path === selectedPath ? 'active' : ''} style={{ paddingLeft: `${10 + entry.depth * 14}px` }} title={entry.path}>
              {entry.kind === 'directory' ? <><Icon name="folder" size={12} /><span>{entry.name}</span>{status && <i className={`team-review-dot ${status}`} aria-label="目录中有变化" />}</> : <button type="button" className={`skill-tree-file${status === 'deleted' ? ' deleted' : ''}`} aria-current={entry.path === selectedPath ? 'true' : undefined} onClick={() => setSelectedPath(entry.path)}><Icon name="doc" size={12} /><span>{entry.name}</span>{status && <i className={`team-review-dot ${status}`} aria-hidden="true" />}{(status === 'added' || status === 'deleted') && <b className={`team-review-mark ${status}`}>{status === 'added' ? '+' : '−'}</b>}</button>}
            </li>
          })}</ul>
        </aside>
        <section className="skill-document-panel team-review-diff" aria-label={selectedPath ? `${selectedPath} 差异` : '文件差异'}>
          {selectedDiff ? <><div className="details-panel-head"><div><h3 className="mono">{selectedDiff.path}</h3><p><span className={`chip ${selectedDiff.status === 'added' ? 'chip-ok' : selectedDiff.status === 'deleted' ? 'chip-danger' : 'chip-warn'}`}>{statusLabel(selectedDiff.status)}</span></p></div></div>
            {selectedDiff.binary ? <div className="compact-empty">这是二进制文件，无法显示逐行差异。</div> : selectedDiff.tooLarge ? <div className="compact-empty">文件差异超过 2000 行，已省略全文。</div> : <pre className="team-review-lines">{selectedRows.map((row, index) => row.type === 'gap'
              ? <span key={`gap-${index}`} className="team-review-gap">⋯ 跳过 {row.skipped} 行未变化内容</span>
              : <span key={`${row.line.oldLine}-${row.line.newLine}-${index}`} className={`team-review-line ${row.line.kind}`}><i>{row.line.oldLine ?? ''}</i><i>{row.line.newLine ?? ''}</i><code>{row.line.kind === 'add' ? '+' : row.line.kind === 'del' ? '−' : ' '}{row.line.content}</code></span>)}</pre>}
          </> : <div className="compact-empty">选择一个有变化的文件查看差异。</div>}
        </section>
      </div>
      <footer className="team-review-footer">
        <div className="form-stack"><label>更新说明（可选）<textarea value={note} onChange={event => setNote(event.target.value)} disabled={busy || Boolean(request.current) || Boolean(published.current)} maxLength={500} rows={2} /></label></div>
        <div className="team-review-actions">{error && <div role="alert" className="banner banner-error">{error}</div>}{full && <div role="alert" className="banner banner-warn">30 个版本名额已用尽，无法发布。</div>}<div className="modal-actions"><button type="button" className="btn btn-ghost" disabled={busy} onClick={() => { setReviewOpen(false); setOpen(false) }}>取消</button><button type="button" className="btn btn-primary" disabled={busy || full || !version || same} onClick={() => void push()}>{busy ? '处理中…' : '发布并推送'}</button></div></div>
      </footer>
      </div>
    </FocusTrapDialog>}
  </>
}
