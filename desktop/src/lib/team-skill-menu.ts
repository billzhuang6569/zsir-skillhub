import type { LocalSkill } from '../store/index.ts'

export function teamSkillMenuState(skill: LocalSkill, userId: string | null, online: boolean, busy = false) {
  const joined = Boolean(skill.localPath || (skill.libraryEntryId && skill.libraryAccountId === userId))
  return {
    joined,
    openFolder: Boolean(skill.localPath) && !skill.cloudDownload,
    quickAccess: joined && !busy,
    acquire: !joined && online && !busy && Boolean(userId),
    unshareVisible: Boolean(userId && skill.serverOwnerId === userId),
    unshareEnabled: online && !busy,
  }
}
