import { useState } from 'react'
import { useStore, type LocalSkill } from '../store/index.js'
import { UNCONFIRMED_SKILL_ROOT_HINT, agentAcceptsSkillWrites } from '../lib/agents.js'
import { preflightUnmanageSkill, unmanageSkill, type AgentInfo, type UnmanagePlan } from '../lib/tauri.js'
import { syncedToAccount } from '../lib/library-sync.js'
import FocusTrapDialog from './FocusTrapDialog.js'
import './SkillControls.css'

/**
 * "取消 SkillHub 托管": the selected Agents get their own copy in place of the
 * SkillHub link. A Skill in the signed-in account's library stays managed
 * and keeps syncing (#91); any other Skill leaves SkillHub on this computer.
 */
export default function UnmanageSkillDialog({ skill, agents, onClose, onDone }: {
  skill: LocalSkill; agents: AgentInfo[]; onClose: () => void; onDone: (keptInSkillHub: boolean) => void
}) {
  const currentUserId = useStore((state) => state.currentUser?.id)
  const synced = syncedToAccount(skill, currentUserId)
  const [selected, setSelected] = useState<string[]>(agents.filter((a) => skill.agents[a.key] === 'on' && a.detected && agentAcceptsSkillWrites(a)).map((a) => a.key))
  const [plan, setPlan] = useState<UnmanagePlan | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async (): Promise<void> => {
    if (busy) return
    setBusy(true); setError(null)
    try {
      const id = skill.marketplaceLocalId ?? skill.id
      if (!plan) setPlan(await preflightUnmanageSkill(id, selected))
      else { await unmanageSkill(id, selected, plan.planDigest); onDone(synced); window.dispatchEvent(new Event('skillhub-local-changed')) }
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : String(reason)); setPlan(null)
    } finally { setBusy(false) }
  }
  return <FocusTrapDialog className="modal-layer above-sheet" label="取消 SkillHub 托管" onEscape={onClose} escapeDisabled={busy}>
    <div className="modal-card skill-dialog compact">
      <div className="modal-head"><h2>取消 SkillHub 托管「{skill.displayName}」</h2></div>
      <p className="modal-copy">{synced
        ? '把一份独立文件交给所选 Agent，由 Agent 自行管理。SkillHub 中的原件仍在账号中并继续在所有设备同步，不会产生新的账号条目；Agent 里的这份之后不再随 SkillHub 更新。'
        : '将独立文件交回所选 Agent，这台电脑上的 SkillHub 不再管理它。这个 Skill 不在当前账号中，其他设备不受影响。'}</p>
      {!plan ? <div className="agent-picker">{agents.filter((agent) => agent.detected).map((agent) => <label key={agent.key} title={agentAcceptsSkillWrites(agent) ? undefined : UNCONFIRMED_SKILL_ROOT_HINT}>
        <input type="checkbox" checked={selected.includes(agent.key)} disabled={busy || !agentAcceptsSkillWrites(agent)} onChange={(event) => setSelected((keys) => event.target.checked ? [...keys, agent.key] : keys.filter((key) => key !== agent.key))} />
        <span><b>{agent.name}</b><small>{agentAcceptsSkillWrites(agent) ? agent.dir : `Skill 目录未确认 · ${agent.dir}`}</small></span>
      </label>)}</div> : <div className="selection-box"><b>文件将保留在</b><span>{plan.destinations.map((path) => <div key={path}>{path}</div>)}</span><b>可发现此 Skill 的 Agent</b><span>{plan.affectedAgents.join('、')}（共用目录的 Agent 会一起看到）</span></div>}
      <p className="modal-copy">{synced
        ? '未选中的 Agent 继续通过 SkillHub 使用原件。所选 Agent 中已有同名的独立文件时不会覆盖；密钥不会写入交出的文件，依赖 SkillHub 配置的功能需在 Agent 中重新配置。'
        : '未选中的受管安装会移除。历史和原配置保留在本机回收站；密钥不会写入交回的文件，依赖 SkillHub 配置的功能需在 Agent 中重新配置。'}</p>
      {error && <div className="banner banner-error" role="alert">{error}</div>}
      <div className="modal-actions"><button className="btn btn-ghost" disabled={busy} onClick={onClose}>取消</button>{plan && <button className="btn btn-ghost" disabled={busy} onClick={() => setPlan(null)}>返回选择</button>}<button className="btn btn-primary" disabled={busy || selected.length === 0} onClick={() => void submit()}>{busy ? '处理中…' : plan ? (synced ? '交给所选 Agent' : '交回文件并取消托管') : '检查文件'}</button></div>
    </div>
  </FocusTrapDialog>
}
