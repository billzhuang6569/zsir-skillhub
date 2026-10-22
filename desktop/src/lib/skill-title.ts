export type SkillTitlePreference = 'skill-name' | 'ai-title'

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
