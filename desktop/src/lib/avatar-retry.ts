import { ApiError } from './api.ts'
import { mayGenerateSkillAvatar } from './skills.ts'
import type { LocalSkill } from '../store/index.js'
import { avatarIdentityFor, avatarParkSignature, type ParkedAvatars } from './avatar-identity.ts'

/** Poll interval while a generation task is still running on the Server. */
export const AVATAR_POLL_MS = 15_000
const BACKOFF_BASE_MS = 30_000
const BACKOFF_MAX_MS = 30 * 60_000
/** A disabled service is checked again after this long, or on a new login. */
const DISABLED_PAUSE_MS = 6 * 60 * 60_000
const DAY_MS = 24 * 60 * 60_000

type Backoff = { failures: number; nextAttemptAt: number }

/**
 * Retry facts for one signed-in session. Kept outside React so effect
 * rebuilds and focus events cannot reset a back-off.
 */
export type AvatarRetryState = {
  /** Account-wide pause for new generation requests (daily quota, user rate limit, disabled). */
  generationPausedUntil: number
  generationPauseFailures: number
  listFailures: number
  listNextAttemptAt: number
  skills: Map<string, Backoff>
  /**
   * Identity conflicts (409 AVATAR_IDENTITY_CONFLICT) keyed by identity
   * signature. Persisted per account; a parked Skill is never ensured again
   * until the Server's read-back proves the canonical + alias relation or its
   * identity fields change. `loaded` marks that the persisted file was read.
   */
  parked: ParkedAvatars
  parkedLoaded: boolean
  /** The parking file could not be read: no new ensure in this session, and the file is never rewritten. */
  parkingLoadFailed: boolean
  /** The once-per-session read-only check of parked Skills has run (success or failure). */
  parkingChecked: boolean
}

export function createAvatarRetryState(): AvatarRetryState {
  return { generationPausedUntil: 0, generationPauseFailures: 0, listFailures: 0, listNextAttemptAt: 0, skills: new Map(), parked: {}, parkedLoaded: false, parkingLoadFailed: false, parkingChecked: false }
}

export const AVATAR_IDENTITY_CONFLICT = 'AVATAR_IDENTITY_CONFLICT'

export function isAvatarIdentityConflict(error: unknown): boolean {
  return error instanceof ApiError && error.kind === 'http' && error.status === 409
    && (error.code === AVATAR_IDENTITY_CONFLICT || error.code === null || error.code === undefined)
}

/** Parks the Skill's current identity; returns the signature written. */
export function parkAvatarConflict(state: AvatarRetryState, userId: string, skill: LocalSkill, now: number): string | null {
  const identity = avatarIdentityFor(skill, userId)
  if (!identity) return null
  const signature = avatarParkSignature(userId, identity, skill.serverId)
  state.parked[signature] = { parkedAt: now, stableId: identity.stableId, aliasLocalIds: identity.aliasLocalIds, serverId: skill.serverId ?? null }
  return signature
}

export function parkedSignatureFor(state: AvatarRetryState, userId: string, skill: LocalSkill): string | null {
  const identity = avatarIdentityFor(skill, userId)
  if (!identity) return null
  const signature = avatarParkSignature(userId, identity, skill.serverId)
  return signature in state.parked ? signature : null
}

export function releaseAvatarParking(state: AvatarRetryState, signature: string): void {
  delete state.parked[signature]
}

/** Exponential back-off with ±20% jitter so clients behind one address spread out. */
export function avatarBackoffMs(failures: number, random: () => number = Math.random): number {
  const base = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1))
  return Math.round(base * (0.8 + random() * 0.4))
}

function nextUtcMidnight(now: number): number {
  return Math.floor(now / DAY_MS) * DAY_MS + DAY_MS
}

function isGenerationDisabled(error: ApiError): boolean {
  // Servers before the code field only sent the message.
  return error.status === 503 && (error.code === 'AVATAR_GENERATION_DISABLED' || error.message === '头像生成暂未开启')
}

function pauseGeneration(state: AvatarRetryState, until: number): void {
  state.generationPausedUntil = Math.max(state.generationPausedUntil, until)
}

/**
 * Records a failed request for one Skill. Quota, per-user rate limits and a
 * disabled service pause every new generation for the account; anything else
 * backs off only that Skill. Caller aborts leave no trace.
 */
export function recordAvatarFailure(
  state: AvatarRetryState,
  skillKey: string,
  error: unknown,
  now: number,
  random: () => number = Math.random,
): void {
  if (error instanceof ApiError && error.kind === 'aborted') return
  // An identity conflict is not retried by time: `parkAvatarConflict` (called
  // by the pass with the Skill) parks it until a verified read-back. Nothing
  // is scheduled here so focus / re-render cannot bring the request back.
  if (isAvatarIdentityConflict(error)) return
  if (error instanceof ApiError && error.kind === 'http') {
    if (error.status === 429) {
      const retryAfterMs = error.retryAfterSeconds === null ? null : error.retryAfterSeconds * 1000
      if (error.code === 'AVATAR_DAILY_QUOTA') {
        pauseGeneration(state, retryAfterMs === null ? nextUtcMidnight(now) : now + retryAfterMs)
      } else {
        state.generationPauseFailures += 1
        pauseGeneration(state, now + (retryAfterMs ?? avatarBackoffMs(state.generationPauseFailures, random)))
      }
      return
    }
    if (isGenerationDisabled(error)) {
      pauseGeneration(state, now + DISABLED_PAUSE_MS)
      return
    }
  }
  const failures = (state.skills.get(skillKey)?.failures ?? 0) + 1
  state.skills.set(skillKey, { failures, nextAttemptAt: now + avatarBackoffMs(failures, random) })
}

/** Parks a Skill whose request must wait (e.g. for the account pause) so passes skip it until then. */
export function deferAvatar(state: AvatarRetryState, skillKey: string, until: number): void {
  const current = state.skills.get(skillKey)
  state.skills.set(skillKey, { failures: current?.failures ?? 0, nextAttemptAt: Math.max(current?.nextAttemptAt ?? 0, until) })
}

export function recordAvatarSuccess(state: AvatarRetryState, skillKey: string): void {
  state.skills.delete(skillKey)
  state.generationPauseFailures = 0
}

/** Earliest time this Skill may send a request; generation also waits for the account pause. */
export function avatarAttemptAt(state: AvatarRetryState, skillKey: string, generation: boolean): number {
  const skill = state.skills.get(skillKey)?.nextAttemptAt ?? 0
  return generation ? Math.max(skill, state.generationPausedUntil) : skill
}

export function recordAvatarListFailure(state: AvatarRetryState, error: unknown, now: number, random: () => number = Math.random): void {
  if (error instanceof ApiError && error.kind === 'aborted') return
  state.listFailures += 1
  const retryAfterMs = error instanceof ApiError && error.retryAfterSeconds !== null ? error.retryAfterSeconds * 1000 : 0
  state.listNextAttemptAt = now + Math.max(retryAfterMs, avatarBackoffMs(state.listFailures, random))
}

export function recordAvatarListSuccess(state: AvatarRetryState): void {
  state.listFailures = 0
  state.listNextAttemptAt = 0
}

/** The avatar facts a pass reads and writes; a match means nothing changed since it settled. */
export function avatarSignature(skill: Pick<LocalSkill, 'serverId' | 'avatarLocalId' | 'avatarStatus' | 'avatarUrl' | 'avatarAccountUserId'>): string {
  return [skill.serverId ?? '', skill.avatarLocalId ?? '', skill.avatarStatus ?? '', skill.avatarUrl ?? '', skill.avatarAccountUserId ?? ''].join('\n')
}

/** Only a running Server task, or inputs that changed since the Skill settled, need a request. */
export function needsAvatarWork(skill: LocalSkill, userId: string, settled: ReadonlyMap<string, string>, parked?: ParkedAvatars): boolean {
  if (parked) {
    const identity = avatarIdentityFor(skill, userId)
    if (identity && avatarParkSignature(userId, identity, skill.serverId) in parked) return false
  }
  const generate = mayGenerateSkillAvatar(skill, userId)
  if (!generate && (!skill.localPath || !skill.avatarUrl)) return false
  if (generate && skill.avatarStatus === 'pending') return true
  return settled.get(skill.id) !== avatarSignature(skill)
}
