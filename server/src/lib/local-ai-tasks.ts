import { createHash } from 'node:crypto'
import { containsSensitiveContent, redactSensitiveContent } from './sensitive-content.js'
import type { AvatarStyle } from './avatar-style-catalog.js'
import type { Input } from './skill-avatar-input.js'

export const AVATAR_DRAFT_CONFIG_VERSION = 'draftAvatarPrompt.v1'
export const AVATAR_DRAFT_DEADLINE_MS = 10 * 60_000
const draftClients = new Map<string, number>()

export function recordAvatarDraftClient(ownerId: string, now = Date.now()): void {
  for (const [id, seen] of draftClients) if (seen + 5 * 60_000 <= now) draftClients.delete(id)
  draftClients.set(ownerId, now)
}

export function avatarDraftClientOnline(ownerId: string, now = Date.now()): boolean {
  const seen = draftClients.get(ownerId)
  return seen !== undefined && seen + 5 * 60_000 > now
}

export function boundedAvatarInput(input: Input, style: AvatarStyle): Input {
  const bounded = (text: string, limit: number): string => redactSensitiveContent(text).content.slice(0, limit)
  return {
    name: bounded(input.name, style.inputTemplate.name.maxLength),
    description: bounded(input.description, style.inputTemplate.description.maxLength),
    scenarios: style.inputTemplate.scenarios ? input.scenarios.slice(0, style.inputTemplate.scenarios.maxItems)
      .map(text => bounded(text, style.inputTemplate.scenarios!.maxLength)) : [],
  }
}

export function avatarDraftInput(input: Input, style: AvatarStyle) {
  if (Buffer.byteLength(style.metaPrompt, 'utf8') > 16 * 1024) return null
  return { ...boundedAvatarInput(input, style), brief: style.metaPrompt,
    constraints: { minLength: 300, maxLength: 12_000, language: 'en' as const, mustInclude: style.legacy?.fixedStyle ?? null } }
}

export function avatarDraftInputHash(avatarJobId: string, style: AvatarStyle, input: NonNullable<ReturnType<typeof avatarDraftInput>>): string {
  return createHash('sha256').update(JSON.stringify([AVATAR_DRAFT_CONFIG_VERSION, 'draftAvatarPrompt', avatarJobId,
    style.styleId, style.styleVersion, input.name, input.description, input.scenarios, input.brief])).digest('hex')
}

/** Both producers use this validation before the server appends the canvas. */
export function validAvatarDraft(draft: string, style: AvatarStyle): boolean {
  return draft.length >= 300 && draft.length <= 12_000
    && !/[\u3040-\u30ff\u31f0-\u31ff\u3400-\u9fff\uf900-\ufaff\u1100-\u11ff\u3130-\u318f\ua960-\ua97f\uac00-\ud7ff\uff66-\uff9f\u{20000}-\u{323af}]/u.test(draft)
    && (!style.legacy || draft.includes(style.legacy.fixedStyle))
    && redactSensitiveContent(draft).redactedSecrets === 0 && !containsSensitiveContent(draft)
}

export function avatarDraftWithCanvas(draft: string, style: AvatarStyle): string {
  return draft + '\n\n' + (style.legacy?.canvas ?? `Aspect ratio: ${style.aspectRatio}.`)
}

// Increment when the result schema or input construction changes.
export const LOCAL_AI_CONFIG_VERSION = 'analyzeSkill.v1'
export const LOCAL_AI_LEASE_TTL_MS = 3 * 60 * 1000
export const LOCAL_AI_BACKOFF_BASE_MS = 15 * 60 * 1000
export const LOCAL_AI_BACKOFF_MAX_MS = 24 * 60 * 60 * 1000
export const LOCAL_AI_MAX_FAILURES = 3
// Keep in sync with desktop/src-tauri/src/local_inference/protocol.rs.
export const LOCAL_AI_INPUT_LIMITS = { name: 256, description: 2000, skillMd: 64 * 1024, files: 200, file: 512 } as const
export const LOCAL_AI_FAILURE_CODES = [
  'NOT_INSTALLED', 'EXECUTABLE', 'SHIM_UNSUPPORTED', 'VERSION_UNSUPPORTED',
  'ISOLATION_UNSUPPORTED', 'NOT_LOGGED_IN', 'SPAWN', 'IO', 'TIMEOUT', 'CANCELLED',
  'TERMINATION_FAILED', 'OUTPUT_LIMIT', 'EXIT', 'INVALID_JSON', 'MODEL_ERROR',
  'INVALID_RESULT', 'INVALID_INPUT', 'BUSY', 'STALE_SPACE', 'UNAVAILABLE', 'MODELS_UNSUPPORTED',
] as const

export type LocalAiTaskType = 'analyzeSkill' | 'draftAvatarPrompt'
export type LocalAiInput = { name: string; description: string; skillMd: string; files: string[] }
type SkillInput = { id: string; name: string; description: string | null; sourceContent: string | null }

export function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, 'utf8')
  if (bytes.length <= maxBytes) return bytes.toString('utf8')
  let end = maxBytes
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1
  return bytes.subarray(0, end).toString('utf8')
}

export function buildLocalAiInput(skill: SkillInput): LocalAiInput {
  const bounded = (text: string, limit: number): string => truncateUtf8(redactSensitiveContent(text).content, limit)
  return {
    name: bounded(skill.name, LOCAL_AI_INPUT_LIMITS.name),
    description: bounded(skill.description ?? '', LOCAL_AI_INPUT_LIMITS.description),
    skillMd: bounded(skill.sourceContent ?? '', LOCAL_AI_INPUT_LIMITS.skillMd),
    // The Skill row has no file list. Do not unpack or read additional storage.
    files: [],
  }
}

export function localAiInputHash(
  skillId: string, input: LocalAiInput, type: LocalAiTaskType = 'analyzeSkill',
  configVersion: string = LOCAL_AI_CONFIG_VERSION,
): string {
  return createHash('sha256').update(JSON.stringify([
    configVersion, type, skillId, input.name, input.description, input.skillMd, input.files,
  ])).digest('hex')
}

export function localAiBackoffMs(failureCount: number): number {
  return Math.min(LOCAL_AI_BACKOFF_MAX_MS, LOCAL_AI_BACKOFF_BASE_MS * 2 ** Math.min(7, Math.max(0, failureCount - 1)))
}
