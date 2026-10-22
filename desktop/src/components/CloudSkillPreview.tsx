import type { LocalSkill } from '../store/index.js'
import { SkillAvatarIcon } from './SkillAvatarIcon.js'
import { useSpaceCapabilities } from '../lib/use-space-capabilities.js'
import { isServerUnanalysed } from '../lib/instance-settings.js'

/** List metadata is usable immediately; local filesystem actions wait for verified landing. */
export default function CloudSkillPreview({ skill }: { skill: LocalSkill }) {
  const unanalysed = isServerUnanalysed(useSpaceCapabilities().profile, skill.serverAnalysisStatus)
  return <aside className="local-skill-preview" aria-label={`${skill.displayName} 云端预览`}>
    <header className="local-preview-head"><SkillAvatarIcon avatarUrl={skill.avatarUrl} size={56} />
      <div><span className="eyebrow">云端 Skill</span><h2>{skill.displayName}</h2><span className="mono">{skill.name}</span></div>
    </header>
    <section className="local-preview-profile">{unanalysed && <span className="inline-status checking">未分析</span>}<p>{skill.description}</p>
      <p role="status">{skill.cloudDownload?.error ? `${skill.cloudDownload.error}，稍后自动重试` : skill.cloudDownload?.phase === 'ready' ? '已下载，正在读取本机内容' : '正在下载，完成后即可使用'}</p>
    </section>
  </aside>
}
