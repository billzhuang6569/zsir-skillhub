import { userMessage } from '../lib/user-message.js'
import { useState } from 'react'
import { useStore } from '../store/index.js'
import { openAgentSkillDir, openSkillDir, libraryJoinLocal } from '../lib/tauri.js'
import { LIBRARY_ENTRIES_CHANGED_EVENT } from '../lib/library-sync.js'
import AgentBrandIcon from './AgentBrandIcon.js'
import { CategoryIcon } from './SkillCard.js'
import { Icon } from './Icon.js'
import { toast } from './Toast.js'
import { EMPTY_COPY } from '../lib/state-copy.js'
import './LocalSkillPreviewPanel.css'

function messageOf(error: unknown): string {
  return userMessage(error)
}

export default function LocalSkillPreviewPanel() {
  const skill = useStore((state) => state.localSkillPreview)
  const requestLocalSkillImport = useStore((state) => state.requestLocalSkillImport)
  const [opening, setOpening] = useState(false)
  const [joining, setJoining] = useState(false)

  if (!skill) return <aside className="local-skill-preview empty" aria-label="本地 Skill 预览">
    <div className="local-preview-empty-icon"><Icon name="doc" size={20} /></div>
    <h2>{EMPTY_COPY.localPreview.title}</h2>
    <p>{EMPTY_COPY.localPreview.hint}</p>
  </aside>

  const openInFileManager = async (): Promise<void> => {
    const source = skill.sources[0]
    if (!source || opening) return
    setOpening(true)
    try {
      if (skill.managedSkillId) await openSkillDir(skill.managedSkillId)
      else await openAgentSkillDir(source.agentKey, source.entryName, source.group)
    } catch (error: unknown) {
      toast(`无法打开文件夹：${messageOf(error)}`, 'error')
    } finally {
      setOpening(false)
    }
  }

  return <aside className="local-skill-preview" aria-label={`${skill.displayName} 本地预览`}>
    <header className="local-preview-head">
      <CategoryIcon size={112} />
      <div>
        <span className="eyebrow">本地 Skill</span>
        <h2>{skill.displayName}</h2>
        <span className="mono local-preview-slug">{skill.name}</span>
      </div>
    </header>

    <section className="local-preview-profile">
      <div className="local-preview-title-row"><h3>Profile</h3><span className="chip mono">{skill.version}</span></div>
      <p>{skill.description || '这个本地 Skill 暂未提供简介。加入 SkillHub 后可以生成完整 Profile。'}</p>
      {skill.labels.length > 0 && <div className="profile-label-list">{skill.labels.map((label) => <i key={label}>{label}</i>)}</div>}
    </section>

    <section className="local-preview-sources">
      <h3>发现位置</h3>
      {skill.sources.map((source) => <div key={`${source.agentKey}:${source.group ?? ''}/${source.entryName}`}>
        <AgentBrandIcon agent={{ key: source.agentKey, name: source.agentName }} size={30} />
        <span><b>{source.agentName}</b><small className="mono">{source.group ? `${source.group}/${source.entryName}` : source.entryName}</small></span>
      </div>)}
      <p className="mono" title={skill.localPath}>{skill.localPath}</p>
      {skill.sources.some((source) => source.group) && <p className="local-preview-note">这个 Skill 放在分组文件夹里。加入 SkillHub 会复制一份，原分组中的文件保持不动；如果之后在 Agent 中看到两个同名 Skill，可以删除原分组里的旧副本。</p>}
    </section>

    <div className="local-preview-actions">
      <button type="button" className="btn btn-ghost" disabled={opening} onClick={() => void openInFileManager()}><Icon name="folder" size={14} />打开文件夹</button>
      {skill.joinLocalId ? <button type="button" className="btn btn-primary" disabled={joining} onClick={() => {
        setJoining(true)
        void libraryJoinLocal([skill.joinLocalId!]).then(report => {
          toast(report.problems.length ? '已提交，稍后自动重试' : '已加入账号同步')
          window.dispatchEvent(new Event(LIBRARY_ENTRIES_CHANGED_EVENT))
        }).catch((reason: unknown) => toast(messageOf(reason), 'error')).finally(() => setJoining(false))
      }}><Icon name="cloud" size={14} />{joining ? '正在加入…' : '加入账号同步'}</button>
        : !skill.managedSkillId && <button type="button" className="btn btn-primary" disabled={skill.alreadyManaged} onClick={() => requestLocalSkillImport(skill.id)}><Icon name="plus" size={14} />{skill.alreadyManaged ? '同名已管理' : '加入 SkillHub'}</button>}
    </div>
  </aside>
}
