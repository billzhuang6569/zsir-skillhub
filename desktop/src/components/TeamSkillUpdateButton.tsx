import { useState } from 'react'
import { useStore, type LocalSkill } from '../store/index.js'
import { apiDownloadSkillPackage, apiGetTeamSkills, sameSpace } from '../lib/api.js'
import { importSkillPackage, getLocalSkills, getSkillPackageDiff, type SkillDiffLine } from '../lib/tauri.js'
import { teamSkillHasUpdate } from '../lib/skill-library.js'
import { teamKeyChanges } from '../lib/team-update-state.js'
import { Icon } from './Icon.js'
import FocusTrapDialog from './FocusTrapDialog.js'
import { toast } from './Toast.js'

const updating = new Set<string>()
export default function TeamSkillUpdateButton({ skill }: { skill: LocalSkill }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [choice, setChoice] = useState<'preserve' | 'overwrite'>('preserve')
  const [error, setError] = useState('')
  const [diff, setDiff] = useState<SkillDiffLine[] | null>(null)
  const preview = async (): Promise<void> => {
    const space = useStore.getState().activeSpace
    if (!space || !skill.serverId) return
    try {
      const pack = await apiDownloadSkillPackage(skill.serverId, space, skill.teamSharedFrom)
      const [, lines] = await getSkillPackageDiff(skill.id, pack.base64, pack.sha256)
      setDiff(lines.map(line => ({ ...line, kind: line.kind === 'add' ? 'del' : line.kind === 'del' ? 'add' : 'ctx' })))
    } catch (reason) { setError(String(reason)) }
  }
  const update = async (): Promise<void> => {
    const { activeSpace, currentUser } = useStore.getState()
    if (!skill.serverId || !skill.serverOwnerId || !skill.teamSharedFrom) {
      setError('这个 Skill 缺少团队来源信息，请重新获取')
      return
    }
    if (!activeSpace || !currentUser || updating.has(skill.id)) return
    updating.add(skill.id)
    setBusy(true)
    setError('')
    try {
      const pack = await apiDownloadSkillPackage(skill.serverId, activeSpace, skill.teamSharedFrom)
      const currentTeam = (await apiGetTeamSkills(skill.teamSharedFrom, activeSpace)).find(item => item.id === skill.serverId)
      if (!currentTeam) throw new Error('团队已停止共享 · 本机副本保留')
      if (currentTeam.currentVersion !== pack.version || currentTeam.teamVersionId && pack.versionId && currentTeam.teamVersionId !== pack.versionId) throw new Error('团队版本已变化，请刷新后重新确认')
      if (!sameSpace(activeSpace, useStore.getState().activeSpace) || currentUser.id !== useStore.getState().currentUser?.id) throw new Error('账号已切换，请重新打开 Skill')
      if (skill.teamVersionId && pack.versionId && skill.teamVersionId !== pack.versionId || pack.version !== skill.latestVersion) throw new Error('团队版本已变化，请刷新后重新确认')
      const imported = await importSkillPackage({
        skillId: skill.id, name: skill.name, serverId: skill.serverId, serverOwnerId: skill.serverOwnerId,
        packageBase64: pack.base64, expectedSha256: pack.sha256, version: pack.version, sourceVersionId: pack.versionId,
        displayName: skill.displayName, description: skill.description, sourceUrl: skill.sourceUrl, category: skill.category,
        labels: skill.labels, teamId: skill.teamSharedFrom, teamIds: [skill.teamSharedFrom], isOwn: false,
        acquisitionSource: 'team', acquiredByUserId: currentUser.id, replaceExistingMarketplace: true,
        teamModifications: choice, installCount: skill.installCount, triggerScenarios: skill.fitScenarios ?? [],
        compatibleAgents: skill.compatibleAgents, envDependencies: (skill.teamEnvDeps ?? skill.envDeps).map(dep => ({ ...dep, sharedTeams: dep.sharedTeams ?? [] })),
      }, activeSpace)
      if (!sameSpace(activeSpace, useStore.getState().activeSpace)) return
      const local = await getLocalSkills()
      if (!sameSpace(activeSpace, useStore.getState().activeSpace) || currentUser.id !== useStore.getState().currentUser?.id) return
      const state = useStore.getState()
      const known = new Map(state.skills.map(item => [item.id, item]))
      state.setSkills([...local.map(item => item.id === skill.id ? { ...skill, ...imported, latestVersion: pack.version, teamUpdateStatus: 'up_to_date' }
        : { ...known.get(item.id), ...item }), ...state.skills.filter(item => !item.localPath)])
      window.dispatchEvent(new Event('skillhub:refresh-team-shares'))
      toast('已更新，已安装的 Agent 已自动刷新')
      setOpen(false)
    } catch (reason: unknown) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { updating.delete(skill.id); setBusy(false) }
  }
  if (skill.acquisitionSource !== 'team' || !teamSkillHasUpdate(skill)) return null
  const keys = teamKeyChanges(skill.envDeps, skill.teamEnvDeps ?? skill.envDeps)
  return <span onClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
    <span role="button" tabIndex={0} className="btn btn-primary skill-library-get" aria-label="更新到团队最新版本" title="更新到团队最新版本" aria-disabled={busy}
      onClick={() => { if (!busy) setOpen(true) }} onKeyDown={event => { if (!busy && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); setOpen(true) } }}><Icon name="refresh-cw" size={15} /></span>
    {open && <FocusTrapDialog className="modal-layer above-sheet" label={`更新到 ${skill.latestVersion}`} onEscape={() => setOpen(false)} escapeDisabled={busy}>
      <div className="modal-card skill-dialog compact"><h2>更新到 {skill.latestVersion}</h2>
        <p>{skill.acquisitionVersion ?? skill.version} → {skill.latestVersion}</p>
        <p>{skill.authorName ?? skill.sharedBy?.displayName ?? '作者'} · {skill.teamChangelog || '暂无更新说明'}</p>
        <button className="btn btn-ghost" disabled={busy} onClick={() => void preview()}>查看区别</button>
        {diff && <pre>{diff.map(line => `${line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '}${line.content}`).join('\n')}</pre>}
        <p>更新后需要：{(skill.teamEnvDeps ?? []).map(dep => dep.key).join('、') || '无需钥匙'}</p>
        {keys.added.length > 0 && <p>新增钥匙：{keys.added.join('、')}</p>}
        {keys.removed.length > 0 && <p>不再需要：{keys.removed.join('、')}</p>}
        {keys.changed.length > 0 && <p>要求有变化：{keys.changed.join('、')}</p>}
        {(skill.teamEnvDeps ?? []).filter(dep => keys.added.includes(dep.key) || keys.changed.includes(dep.key)).map(dep => <p key={dep.key}>{dep.key} · {dep.required ? '必需' : '可选'}{dep.description ? ` · ${dep.description}` : ''}{dep.obtain ? ` · ${dep.obtain}` : ''}</p>)}
        {skill.sourceLocalModified && <fieldset><legend>你修改过这个 Skill</legend>
          <label><input type="radio" checked={choice === 'preserve'} onChange={() => setChoice('preserve')} disabled={busy} />保留我的修改，再更新</label>
          <p>本机内容另存为「{skill.displayName}（我的修改）」，原 Skill 换成作者的新内容，继续收到团队更新。</p>
          <label><input type="radio" checked={choice === 'overwrite'} onChange={() => setChoice('overwrite')} disabled={busy} />直接覆盖</label><p>更新前先记录一次，可在历史里恢复。</p>
        </fieldset>}
        <p>已安装的 Agent 会自动刷新。</p>{error && <p role="alert" className="banner banner-error">{error}</p>}
        <div className="modal-actions"><button className="btn btn-ghost" disabled={busy} onClick={() => setOpen(false)}>取消</button><button className="btn btn-primary" disabled={busy} onClick={() => void update()}>{busy ? '更新中…' : '更新'}</button></div>
      </div></FocusTrapDialog>}
  </span>
}
