import { useSyncExternalStore } from 'react'
import { useStore } from '../store/index.js'
import { ApiError, apiCreateSkillVersion, sameSpace } from './api.js'
import { freezeSkillVersion, packageFrozenSkillVersion, recordSkillFormalVersion, releaseFrozenSkillVersion,
  saveFrozenSkillVersion, getLocalSkill, getSkillVersions } from './tauri.js'
import { requestLibrarySync } from './library-sync.js'
import { reconcileLocalSkillRefresh } from './ui-helpers.js'
import { userMessage } from './user-message.js'
import { toast } from '../components/Toast.js'
import { VersionCreateTasks, versionTaskKey, type VersionTaskIdentity, type VersionTask } from './version-create-task.js'

export function versionIdentity(managedSkillId: string): VersionTaskIdentity {
  const state = useStore.getState()
  return { managedSkillId, accountId: state.currentUser?.id ?? null, space: state.authSpace ?? state.activeSpace }
}
function matches(identity: VersionTaskIdentity): boolean {
  const current = versionIdentity(identity.managedSkillId)
  return current.accountId === identity.accountId && (current.space === null && identity.space === null || sameSpace(current.space, identity.space))
}
export const versionCreateTasks = new VersionCreateTasks({
  matches,
  freeze: input => freezeSkillVersion(input.managedSkillId, input.changelog, input.version),
  package: (task, token) => packageFrozenSkillVersion(task.managedSkillId, token),
  publish: (task, request) => apiCreateSkillVersion(task.serverId!, request, task.space ?? undefined),
  record: (task, token) => task.result
    ? recordSkillFormalVersion(task.managedSkillId, task.result.id, undefined, token)
    : saveFrozenSkillVersion(task.managedSkillId, token, task.version, task.allocation),
  refresh: async task => {
    const local = await getLocalSkill(task.managedSkillId)
    if (!matches(task)) return
    if (local) {
      local.versions = await getSkillVersions(task.managedSkillId)
      if (!matches(task)) return
      const state = useStore.getState()
      const previous = [...state.skills, ...state.marketplaceSkills].find(skill => (skill.marketplaceLocalId ?? skill.id) === task.managedSkillId)
      if (previous) useStore.getState().replaceSkill(previous.id, reconcileLocalSkillRefresh(previous, local))
    }
    requestLibrarySync()
  },
  release: releaseFrozenSkillVersion,
  status: error => error instanceof ApiError ? error.status : null,
  message: userMessage,
  notify: (message, error) => { toast(message, error ? 'error' : 'default'); if (error) requestLibrarySync() },
})
useStore.subscribe(() => versionCreateTasks.cancelStale())

export function useVersionCreateTask(managedSkillId: string): VersionTask | undefined {
  useStore(state => state.currentUser?.id)
  useStore(state => state.authSpace ?? state.activeSpace)
  const key = versionTaskKey(versionIdentity(managedSkillId))
  return useSyncExternalStore(versionCreateTasks.subscribe, () => versionCreateTasks.get(key))
}
