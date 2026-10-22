import type { LocalSkill } from '../store/index.js'

/**
 * Window event for edits that change whether a Skill's required environment
 * values are ready (values, sources, team bindings, shares). `detail` narrows
 * the refresh to one Skill; without it every cached result is read again.
 */
export const ENV_READINESS_CHANGED_EVENT = 'skillhub:env-readiness-changed'

export type EnvReadinessChange = { skillId?: string; serverId?: string }

export function notifyEnvReadinessChanged(change: EnvReadinessChange = {}): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent<EnvReadinessChange>(ENV_READINESS_CHANGED_EVENT, { detail: change }))
}

/** Concurrent environment policy reads; each may make one network request. */
export const ENV_READINESS_CONCURRENCY = 2

export function needsEnvReadinessCheck(skill: LocalSkill): boolean {
  return Boolean(skill.localPath) && skill.envDeps.some((dependency) => dependency.required)
}

/**
 * Everything the native policy read depends on, and nothing else: a new
 * avatar or list refresh must not trigger another network round.
 */
export function envReadinessSignature(skill: LocalSkill): string {
  return JSON.stringify([
    skill.id,
    skill.serverId ?? null,
    skill.serverOwnerId ?? null,
    skill.isOwn,
    skill.acquisitionSource,
    skill.teamSharedFrom ?? null,
    skill.envDeps
      .map((dependency) => [
        dependency.key,
        dependency.required,
        dependency.configured,
        dependency.sharePolicy,
        [...(dependency.sharedTeams ?? [])].sort(),
      ])
      .sort((left, right) => String(left[0]).localeCompare(String(right[0]))),
  ])
}

