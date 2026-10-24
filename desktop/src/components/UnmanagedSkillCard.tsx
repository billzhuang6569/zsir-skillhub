import type { UnmanagedSkill } from '../lib/tauri.js'
import { Icon } from './Icon.js'
import { SkillAvatarIcon } from './SkillAvatarIcon.js'
import { findLocalSkillByManagedId } from '../lib/skills.js'
import './SkillCard.css'
import SkillListName from './SkillListName.js'
import { skillListText } from '../lib/skill-title.js'
import { useStore } from '../store/index.js'

type Props = {
  skill: UnmanagedSkill
  alreadyManaged: boolean
  previewed: boolean
}

export default function UnmanagedSkillCard({ skill, alreadyManaged, previewed }: Props) {
  const skillTitlePreference = useStore((state) => state.skillTitlePreference)
  const avatarUrl = useStore((state) => skill.managedSkillId
    ? findLocalSkillByManagedId(state.skills, skill.managedSkillId)?.avatarUrl
    : undefined)
  const title = skillListText(skill, skillTitlePreference)
  return <article className={`local-library-card${previewed ? ' previewed' : ''}`} title={skill.localPath}>
    <SkillAvatarIcon avatarUrl={avatarUrl} size={44} />
    <span className="local-library-copy">
      <span className="local-library-name-row">
        <SkillListName name={title.primary} className={skillTitlePreference === 'skill-name' ? 'skill-primary-name' : undefined} />
        <span className="skill-library-version mono">{skill.version}</span>
      </span>
      <span className="local-library-meta">
        <span className={`local-library-subtitle${!title.secondary ? ' placeholder' : skillTitlePreference === 'ai-title' ? ' mono' : ''}`}>{title.secondary || '尚未分析技能名'}</span>
        <span>{skill.sources.slice(0, 2).map((source) => source.agentName).join(' + ') || '本地 Agent'}</span>
      </span>
    </span>
    <span className="local-library-state">
      {alreadyManaged && !skill.joinLocalId ? <span className="skill-library-system-state"><Icon name="check" size={13} />已管理</span> : <span>待加入</span>}
    </span>
    <Icon name="left" size={14} />
  </article>
}
