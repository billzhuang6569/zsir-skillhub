import type { UnmanagedSkill } from '../lib/tauri.js'
import { Icon } from './Icon.js'
import { CategoryIcon } from './SkillCard.js'
import './SkillCard.css'
import { skillListText } from '../lib/skill-title.js'
import { useStore } from '../store/index.js'

type Props = {
  skill: UnmanagedSkill
  alreadyManaged: boolean
  previewed: boolean
}

export default function UnmanagedSkillCard({ skill, alreadyManaged, previewed }: Props) {
  const skillTitlePreference = useStore((state) => state.skillTitlePreference)
  const title = skillListText(skill, skillTitlePreference)
  return <article className={`local-library-card${previewed ? ' previewed' : ''}`} title={skill.localPath}>
    <CategoryIcon size={44} />
    <span className="local-library-copy">
      <span className="local-library-name-row">
        <strong className={skillTitlePreference === 'skill-name' ? 'skill-primary-name' : undefined}>{title.primary}</strong>
        <span className="skill-library-version mono">{skill.version}</span>
      </span>
      <span className="local-library-meta">
        {title.secondary && <span className={`local-library-subtitle${skillTitlePreference === 'ai-title' ? ' mono' : ''}`}>{title.secondary}</span>}
        <span>{skill.sources.slice(0, 2).map((source) => source.agentName).join(' + ') || '本地 Agent'}</span>
      </span>
    </span>
    <span className="local-library-state">
      {alreadyManaged ? <span className="skill-library-system-state"><Icon name="check" size={13} />已管理</span> : <span>待加入</span>}
    </span>
    <Icon name="left" size={14} />
  </article>
}
