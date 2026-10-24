export type SkillTitlePreference = 'skill-name' | 'ai-title'

export const UNANALYSED_SKILL_NAME = '尚未分析技能名'

export function truncateSkillName(name: string): string {
  const characters = Array.from(name)
  return characters.length > 25 ? `${characters.slice(0, 25).join('')}…` : name
}

type SkillTitleSource = {
  name: string
  displayName: string
}

export type SkillListText = {
  primary: string
  secondary: string | null
}

export function skillListText(
  skill: SkillTitleSource,
  preference: SkillTitlePreference,
): SkillListText {
  const name = skill.name.trim()
  const displayName = skill.displayName.trim()
  const primary = preference === 'ai-title'
    ? displayName || name
    : name || displayName
  const secondary = preference === 'ai-title'
    ? name
    : displayName

  return {
    primary,
    secondary: secondary && secondary !== primary ? secondary : null,
  }
}
