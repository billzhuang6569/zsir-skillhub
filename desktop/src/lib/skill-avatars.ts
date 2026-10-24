import type { SpaceHandle } from './tauri.js'
import { useStore, type LocalSkill } from '../store/index.js'
import { readAuthSpace } from '../store/index.js'
import {
  ApiError, apiEnsureCloudSkillAvatar, apiEnsureSkillAvatar, apiGetSkillAvatars, apiRestoreCloudSkillAvatar, apiRestoreSkillAvatar,
  apiUploadCloudSkillAvatar, apiUploadSkillAvatar, sameSpace, type ApiSkillAvatar, type CustomAvatarImage, type SkillAvatarRegistration,
} from './api.js'
import { cacheSkillAvatar, ensureSkillAvatarIdentity, readAvatarParking, writeAvatarParking } from './tauri.js'
import { mayGenerateSkillAvatar } from './skills.js'
import {
  AVATAR_POLL_MS, avatarAttemptAt, avatarSignature, createAvatarRetryState, deferAvatar, isAvatarIdentityConflict, needsAvatarWork,
  parkAvatarConflict, parkedSignatureFor, recordAvatarFailure, recordAvatarListFailure, recordAvatarListSuccess, recordAvatarSuccess,
  releaseAvatarParking, type AvatarRetryState,
} from './avatar-retry.js'
import { AVATAR_STATUS_CONFLICT, avatarIdentityFor, parkingResolvedByReadBack, parseParkedAvatars, type AvatarIdentity } from './avatar-identity.js'

/**
 * The identity and sanitized-on-Server introduction a local Skill registers its avatar
 * with. Avatar registration and the custom upload (#214) send exactly this, so a Skill
 * that never registered can still upload, and a later restore draws from the same input.
 */
export function avatarRegistration(skill: Pick<LocalSkill, 'name' | 'displayName' | 'description' | 'fitScenarios' | 'serverId'>, identity: AvatarIdentity): SkillAvatarRegistration {
  return {
    localSkillId: identity.stableId, aliasLocalIds: identity.aliasLocalIds, skillId: skill.serverId,
    name: skill.displayName.trim().slice(0, 128) || skill.name.slice(0, 128),
    description: (skill.description?.trim() || skill.displayName || skill.name).slice(0, 500),
    scenarios: (skill.fitScenarios ?? []).slice(0, 8).map(value => value.slice(0, 100)),
  }
}

/** Only the owner of a Skill that may generate an avatar may replace it; never system, team or store Skills, never guests. */
export function canChangeSkillAvatar(skill: LocalSkill, userId: string | null | undefined): boolean {
  return Boolean(userId) && !skill.isSystem && mayGenerateSkillAvatar(skill, userId as string)
}

/**
 * A custom avatar response belongs to the request that sent it: the same account and
 * login space are still active, the detail sheet is still open on that Skill, and the
 * Skill's avatar still belongs to that account. Anything else is dropped unseen.
 */
export function customAvatarResponseIsCurrent(request: { userId: string; space: SpaceHandle; skillId: string; sheetOpen: () => boolean },
  state: { currentUserId: string | null | undefined; space: SpaceHandle | null; skill: Pick<LocalSkill, 'id' | 'avatarAccountUserId'> | undefined }): boolean {
  return state.currentUserId === request.userId && state.space === request.space && request.sheetOpen()
    && state.skill?.id === request.skillId && (state.skill.avatarAccountUserId === undefined || state.skill.avatarAccountUserId === request.userId)
}

/** Feedback for deliberate user actions; background generation details stay private. */
export function customAvatarErrorMessage(error: unknown, action: 'upload' | 'restore'): string {
  if (action === 'restore') return '暂时无法恢复默认头像，请稍后再试；当前头像已保留'
  if (error instanceof ApiError && error.kind === 'http') {
    if (error.status === 429 && error.code === 'AVATAR_DAILY_QUOTA') return '暂时无法更换头像，请稍后再试'
    if (error.status === 429) return error.retryAfterSeconds ? `上传过于频繁，${error.retryAfterSeconds} 秒后再试` : '上传过于频繁，请稍后再试'
    if (error.status === 400 && error.code === 'AVATAR_IMAGE_DIMENSIONS') return '图片太小，至少 256×256'
    if (error.status === 400 || error.status === 409 || error.status === 404) return error.message
    if ((error.status ?? 0) >= 500) return '头像服务暂时不可用，请稍后重试'
  }
  if (error instanceof ApiError) return '头像服务暂时不可用，请稍后重试'
  return error instanceof Error ? error.message : '头像服务暂时不可用，请稍后重试'
}

export type CustomAvatarOutcome ={ status: 'applied'; avatar: ApiSkillAvatar } | { status: 'stale' }

/**
 * Display revision per Skill, bumped whenever a custom upload or restore result is
 * applied. An avatar pass records the revisions when it starts; a pass whose list
 * read began before the user's change must not write that Skill's cache, store
 * entry or settled marker, or a stale "generated" snapshot would replace the user's
 * image and stop the pass from ever looking again.
 */
const displayRevisions = new Map<string, number>()
const displayRevision = (skillId: string): number => displayRevisions.get(skillId) ?? 0

async function applyCustomAvatarResult(skill: LocalSkill, userId: string, result: ApiSkillAvatar, current: () => boolean): Promise<CustomAvatarOutcome> {
  if (!current()) return { status: 'stale' }
  displayRevisions.set(skill.id, displayRevision(skill.id) + 1)
  if (skill.localPath) await cacheSkillAvatar(skill.id, userId, result.avatarUrl, result.avatarStatus)
  if (!current()) return { status: 'stale' }
  useStore.setState(state => ({ skills: state.skills.map(item => item.id === skill.id && item.serverId === skill.serverId
    ? { ...item, avatarUrl: result.avatarUrl, avatarStatus: result.avatarStatus, avatarSource: result.avatarSource ?? 'generated', avatarAccountUserId: userId }
    : item) }))
  // A pending restore is picked up by the regular avatar pass.
  if (session && result.avatarStatus === 'pending') session.settled.delete(skill.id)
  return { status: 'applied', avatar: result }
}

/** Uploads a cropped image as the Skill's avatar: local Skills with their registration, cloud-only Skills by id. */
export async function uploadCustomSkillAvatar(skill: LocalSkill, image: CustomAvatarImage, userId: string, space: SpaceHandle, sheetOpen: () => boolean): Promise<CustomAvatarOutcome> {
  const current = (): boolean => customAvatarResponseIsCurrent({ userId, space, skillId: skill.id, sheetOpen },
    { currentUserId: useStore.getState().currentUser?.id, space: readAuthSpace(), skill: useStore.getState().skills.find(item => item.id === skill.id) })
  if (!canChangeSkillAvatar(skill, userId)) throw new Error('当前账号不能更换这个 Skill 的头像')
  let result: ApiSkillAvatar
  if (skill.localPath) {
    const deviceId = skill.avatarLocalId ?? await ensureSkillAvatarIdentity(skill.id)
    const identity = avatarIdentityFor(skill, userId, deviceId)
    if (!identity) throw new Error('无法确定这个 Skill 的头像身份')
    if (!current()) return { status: 'stale' }
    result = await apiUploadSkillAvatar(avatarRegistration(skill, identity), image, space)
  } else if (skill.serverId) {
    result = await apiUploadCloudSkillAvatar(skill.serverId, image, space)
  } else throw new Error('无法确定这个 Skill 的头像身份')
  return applyCustomAvatarResult(skill, userId, result, current)
}

/** 恢复自动生成; a 429 / 503 leaves the custom image untouched on the Server and here. */
export async function restoreGeneratedSkillAvatar(skill: LocalSkill, userId: string, space: SpaceHandle, sheetOpen: () => boolean): Promise<CustomAvatarOutcome> {
  const current = (): boolean => customAvatarResponseIsCurrent({ userId, space, skillId: skill.id, sheetOpen },
    { currentUserId: useStore.getState().currentUser?.id, space: readAuthSpace(), skill: useStore.getState().skills.find(item => item.id === skill.id) })
  if (!canChangeSkillAvatar(skill, userId)) throw new Error('当前账号不能更换这个 Skill 的头像')
  let result: ApiSkillAvatar
  if (skill.localPath) {
    const identity = avatarIdentityFor(skill, userId)
    if (!identity) throw new Error('无法确定这个 Skill 的头像身份')
    result = await apiRestoreSkillAvatar(identity.stableId, space)
  } else if (skill.serverId) {
    result = await apiRestoreCloudSkillAvatar(skill.serverId, space)
  } else throw new Error('无法确定这个 Skill 的头像身份')
  return applyCustomAvatarResult(skill, userId, result, current)
}

/** When the caller should run the next pass; null means only an inventory change or focus needs one. */
export type AvatarSyncOutcome = { wakeAt: number | null }

type AvatarSession = { key: string; retry: AvatarRetryState; settled: Map<string, string> }
let session: AvatarSession | null = null

export function resetSkillAvatarCache(): void { session = null; displayRevisions.clear() }

export const AVATAR_SELECTIONS_CHANGED_EVENT = 'skillhub:avatar-selections-changed'

/** Read selections after a deliberate style change, including already settled local images.
 * Never register/ensure missing avatars: newOnly must not create paid work. */
export async function refreshSkillAvatarSelections(userId: string, space: SpaceHandle, signal: AbortSignal): Promise<boolean> {
  const current = (): boolean => !signal.aborted && useStore.getState().currentUser?.id === userId
    && sameSpace(readAuthSpace(), space)
  if (!current()) return false
  const skills = useStore.getState().skills.filter(skill => canChangeSkillAvatar(skill, userId))
  // Invalidate background reads started before this intentional selection change.
  const revisions = new Map(skills.map(skill => {
    const revision = displayRevision(skill.id) + 1
    displayRevisions.set(skill.id, revision)
    return [skill.id, revision]
  }))
  const { items } = await apiGetSkillAvatars(space, signal)
  if (!current()) return false
  let pending = false
  for (const skill of skills) {
    const fresh = (): boolean => current() && displayRevision(skill.id) === revisions.get(skill.id)
    if (!fresh()) continue
    const identity = skill.localPath ? avatarIdentityFor(skill, userId) : null
    const avatar = identity ? items.find(item => item.localSkillId === identity.stableId)
      ?? items.find(item => typeof item.localSkillId === 'string' && identity.aliasLocalIds.includes(item.localSkillId))
      : skill.serverId ? items.find(item => item.skillId === skill.serverId) : undefined
    if (!avatar) continue
    pending ||= avatar.avatarStatus === 'pending'
    if (skill.localPath) await cacheSkillAvatar(skill.id, userId, avatar.avatarUrl, avatar.avatarStatus, space)
    if (!fresh()) continue
    useStore.setState(state => ({ skills: state.skills.map(item => item.id === skill.id && item.serverId === skill.serverId
      ? { ...item, avatarUrl: avatar.avatarUrl, avatarStatus: avatar.avatarStatus, avatarSource: avatar.avatarSource ?? 'generated', avatarAccountUserId: userId }
      : item) }))
  }
  return pending
}

/** One retry/settled record per login; a new space (re-login) checks everything again. */
function sessionFor(userId: string, space: SpaceHandle): AvatarSession {
  const key = `${userId}\n${space.spaceId}\n${space.generation}`
  if (session?.key !== key) session = { key, retry: createAvatarRetryState(), settled: new Map() }
  return session
}

/**
 * Persists the account's parked conflicts; a write failure keeps the in-memory
 * parking. Never runs while the file could not be read: a damaged or unsafe
 * record is left for the user to inspect, not silently replaced.
 */
async function persistParking(userId: string, retry: AvatarRetryState): Promise<void> {
  if (retry.parkingLoadFailed) return
  await writeAvatarParking(userId, JSON.stringify(retry.parked)).catch(() => undefined)
}

// Internal diagnostic only; the APP no longer offers task recovery controls (#228).
const PARKING_PROBLEM = '头像停放记录无法读取，已暂停新的头像生成请求。'

/** Reads the persisted parking; returns false (and pauses generation) on any read or parse failure. */
async function loadParking(userId: string, retry: AvatarRetryState, current: () => boolean): Promise<boolean> {
  let parsed: ReturnType<typeof parseParkedAvatars>
  try { parsed = parseParkedAvatars(await readAvatarParking(userId)) } catch { parsed = null }
  if (!current()) return false
  retry.parkedLoaded = true
  if (parsed === null) {
    retry.parkingLoadFailed = true
    useStore.setState({ avatarParkingProblem: PARKING_PROBLEM })
    return false
  }
  retry.parked = parsed
  retry.parkingLoadFailed = false
  useStore.setState({ avatarParkingProblem: null })
  for (const skill of useStore.getState().skills) if (parkedSignatureFor(retry, userId, skill)) markConflict(skill.id, skill.serverId, true)
  return true
}

/** Read-only retry of a failed parking load from the UI; never writes the file. */
export async function reloadAvatarParking(userId: string, space: SpaceHandle): Promise<boolean> {
  const current = (): boolean => useStore.getState().currentUser?.id === userId && readAuthSpace() === space
  if (!current()) return false
  const { retry } = sessionFor(userId, space)
  return loadParking(userId, retry, current)
}

function markConflict(skillId: string, serverId: string | null | undefined, conflict: boolean): void {
  useStore.setState(state => ({ skills: state.skills.map(item => item.id === skillId && item.serverId === serverId
    ? (conflict ? { ...item, avatarStatus: AVATAR_STATUS_CONFLICT } : (item.avatarStatus === AVATAR_STATUS_CONFLICT ? { ...item, avatarStatus: 'pending' } : item))
    : item) }))
}

/**
 * Read-only check of parked Skills against the Server's list: parking is
 * released only when the canonical + alias relation matches exactly (see
 * `parkingResolvedByReadBack`); anything else keeps it parked. Never ensures.
 */
function reconcileParking(userId: string, retry: AvatarRetryState, items: ApiSkillAvatar[] | null): string[] {
  const released: string[] = []
  for (const skill of useStore.getState().skills) {
    const signature = parkedSignatureFor(retry, userId, skill)
    if (!signature) continue
    const identity = avatarIdentityFor(skill, userId)
    if (identity && parkingResolvedByReadBack(items, identity, skill.serverId)) {
      releaseAvatarParking(retry, signature)
      markConflict(skill.id, skill.serverId, false)
      released.push(skill.id)
    } else {
      markConflict(skill.id, skill.serverId, true)
    }
  }
  return released
}

/**
 * Manual "重新核对" from the detail view: one read-only list read, then the
 * same strict release rule. It never calls ensure to probe the identity.
 */
export async function recheckSkillAvatarIdentity(skill: LocalSkill, userId: string, space: SpaceHandle): Promise<'released' | 'parked' | 'not-parked' | 'stale'> {
  const current = (): boolean => useStore.getState().currentUser?.id === userId && readAuthSpace() === space
  if (!current()) return 'stale'
  const { retry } = sessionFor(userId, space)
  if (!parkedSignatureFor(retry, userId, skill)) return 'not-parked'
  let items: ApiSkillAvatar[] | null = null
  try { items = (await apiGetSkillAvatars(space, new AbortController().signal)).items } catch { items = null }
  // The account may have changed while the read was in flight: never apply
  // one account's read-back to another account's cards.
  if (!current()) return 'stale'
  const released = reconcileParking(userId, retry, items)
  await persistParking(userId, retry)
  return released.includes(skill.id) ? 'released' : 'parked'
}

export async function syncSkillAvatars(userId: string, space: SpaceHandle, signal: AbortSignal): Promise<AvatarSyncOutcome> {
  const current = (): boolean => !signal.aborted && useStore.getState().currentUser?.id === userId
    && readAuthSpace() === space
  if (!current()) return { wakeAt: null }
  const { retry, settled } = sessionFor(userId, space)
  if (!retry.parkedLoaded) {
    // Parking survives sign-out / sign-in / restarts: load it before deciding any work.
    await loadParking(userId, retry, current)
    if (!current()) return { wakeAt: null }
  }
  // With an unreadable parking file nothing may be ensured in this session:
  // any parked Skill could be among the work. Read-only display continues.
  const generationBlocked = retry.parkingLoadFailed
  const now = Date.now()
  const parkedCount = Object.keys(retry.parked).length
  // The read-only parked check is scheduled on its own, once per session
  // (a new login is a new session), independent of whether any other Skill
  // has work; focus and re-renders after it do not repeat it.
  const parkingCheckDue = parkedCount > 0 && !retry.parkingChecked
  const work = generationBlocked ? [] : useStore.getState().skills.filter(skill => needsAvatarWork(skill, userId, settled, retry.parked))
  if (work.length === 0 && !parkingCheckDue) return { wakeAt: null }
  // Skills still waiting out a back-off cost nothing until their time comes.
  const due = work.filter(skill => avatarAttemptAt(retry, skill.id, false) <= now)
  // Captured before the list read: a custom upload / restore applied after this point wins.
  const revisions = new Map(due.map(skill => [skill.id, displayRevision(skill.id)]))
  const earliestWait = (): number | null => {
    if (generationBlocked) return null
    const times = useStore.getState().skills.filter(skill => needsAvatarWork(skill, userId, settled, retry.parked))
      .map(skill => avatarAttemptAt(retry, skill.id, true)).filter(time => time > Date.now())
    return times.length > 0 ? Math.min(...times) : null
  }
  if (due.length === 0 && !parkingCheckDue) return { wakeAt: earliestWait() }
  if (!parkingCheckDue && retry.listNextAttemptAt > now) return { wakeAt: retry.listNextAttemptAt }

  let items: ApiSkillAvatar[]
  try {
    items = (await apiGetSkillAvatars(space, signal)).items
    recordAvatarListSuccess(retry)
  } catch (error: unknown) {
    if (!current()) return { wakeAt: null }
    recordAvatarListFailure(retry, error, Date.now())
    // A failed read-back keeps every parked Skill parked; the session's one
    // automatic check is spent (manual "重新核对" stays available).
    if (parkingCheckDue) retry.parkingChecked = true
    return { wakeAt: due.length > 0 ? retry.listNextAttemptAt : earliestWait() }
  }
  if (!current()) return { wakeAt: null }
  if (parkingCheckDue) {
    retry.parkingChecked = true
    // Releases only on the strict canonical + alias rule; released Skills are
    // picked up by the next pass, never ensured in this one.
    reconcileParking(userId, retry, items)
    await persistParking(userId, retry)
    if (!current()) return { wakeAt: null }
  }
  if (due.length === 0) return { wakeAt: earliestWait() }

  let polling = false
  for (const skill of due) {
    if (!current()) return { wakeAt: null }
    const fresh = (): boolean => displayRevision(skill.id) === revisions.get(skill.id)
    if (!fresh()) continue
    try {
      const generate = !skill.copiedFromSource && mayGenerateSkillAvatar(skill, userId)
      // Device id stays on the sidecar; the account entry id is the stable identity once bound (#149).
      const deviceId = skill.localPath ? skill.avatarLocalId ?? await ensureSkillAvatarIdentity(skill.id) : undefined
      if (!current()) return { wakeAt: null }
      const identity = skill.localPath ? avatarIdentityFor(skill, userId, deviceId) : null
      const localId = identity?.stableId
      let avatar = identity ? items.find(item => item.localSkillId === identity.stableId)
        ?? items.find(item => identity.aliasLocalIds.length > 0 && typeof item.localSkillId === 'string' && identity.aliasLocalIds.includes(item.localSkillId))
        : skill.serverId ? items.find(item => item.skillId === skill.serverId) : undefined
      if (generate && identity && (!avatar || (skill.serverId && avatar.skillId !== skill.serverId) || avatar.localSkillId !== identity.stableId)) {
        // Registering a new (or continuing an) avatar may start paid generation.
        const attemptAt = avatarAttemptAt(retry, skill.id, true)
        if (attemptAt > Date.now()) { deferAvatar(retry, skill.id, attemptAt); continue }
        avatar = await apiEnsureSkillAvatar(avatarRegistration(skill, identity), space, signal)
      } else if (generate && !localId && skill.serverId && skill.avatarStatus !== 'ready') {
        // A pending cloud avatar is only being read back; anything else may generate.
        const attemptAt = avatarAttemptAt(retry, skill.id, skill.avatarStatus !== 'pending')
        if (attemptAt > Date.now()) { deferAvatar(retry, skill.id, attemptAt); continue }
        avatar = await apiEnsureCloudSkillAvatar(skill.serverId, space, signal)
      }
      if (!current()) return { wakeAt: null }
      recordAvatarSuccess(retry, skill.id)
      // The user changed this avatar while the pass was reading: its snapshot is stale.
      if (!fresh()) continue
      const result = avatar ?? { avatarUrl: skill.avatarUrl ?? null, avatarStatus: skill.avatarStatus ?? 'none' }
      if (skill.localPath && (skill.avatarAccountUserId !== userId || skill.avatarUrl !== result.avatarUrl
        || skill.avatarStatus !== result.avatarStatus || !skill.avatarLocalId)) {
        await cacheSkillAvatar(skill.id, userId, result.avatarUrl, result.avatarStatus)
      }
      if (!current()) return { wakeAt: null }
      if (!fresh()) continue
      const source = avatar?.avatarSource ?? skill.avatarSource
      const next = { avatarLocalId: deviceId, avatarUrl: result.avatarUrl, avatarStatus: result.avatarStatus, avatarAccountUserId: userId, avatarSource: source }
      // Writing an unchanged result would hand every list consumer a new array.
      if (skill.avatarLocalId !== next.avatarLocalId || skill.avatarUrl !== next.avatarUrl
        || skill.avatarStatus !== next.avatarStatus || skill.avatarAccountUserId !== userId || skill.avatarSource !== source) {
        useStore.setState(state => ({ skills: state.skills.map(item => item.id === skill.id && item.serverId === skill.serverId
          ? { ...item, ...next }
          : item) }))
      }
      // Only a running Server task needs another look; anything else waits for new inputs.
      if (generate && result.avatarStatus === 'pending') polling = true
      else settled.set(skill.id, avatarSignature({ ...skill, ...next }))
    } catch (error: unknown) {
      if (!current()) return { wakeAt: null }
      if (isAvatarIdentityConflict(error)) {
        // Two tasks claim this identity: park until a verified read-back or an
        // identity change; no timer, no probing ensure, survives re-login.
        parkAvatarConflict(retry, userId, skill, Date.now())
        markConflict(skill.id, skill.serverId, true)
        await persistParking(userId, retry)
        continue
      }
      recordAvatarFailure(retry, skill.id, error, Date.now())
    }
  }
  const wait = earliestWait()
  if (polling) return { wakeAt: Math.min(Date.now() + AVATAR_POLL_MS, wait ?? Infinity) }
  return { wakeAt: wait }
}
