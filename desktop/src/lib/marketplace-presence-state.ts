import type { LocalSkill } from '../store/index.js'

export function marketplaceManagedListingIds(skills: LocalSkill[]): string[] {
  return [...new Set(skills.flatMap((skill) => (
    skill.localPath && skill.serverId ? [skill.serverId] : []
  )))].sort()
}
