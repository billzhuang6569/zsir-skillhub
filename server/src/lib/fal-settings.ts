import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { config } from '../config.js'
import { db } from '../db.js'
import { AiServiceError } from './ai-http.js'
import { resolveAccountAvatarStyle } from './avatar-jobs.js'
import { effectiveSource, getSettingValue, hasSettingSecret, maskedSetting, writeServerSetting } from './server-settings.js'

export const FalDraft = z.object({ apiKey: z.string().min(16).max(512) }).strict()
type DraftReceipt = { digest: string; adminId: string; expires: number; at: string }
const drafts = new Map<string, DraftReceipt>()
const digest = (apiKey: string): string => createHash('sha256').update(apiKey).digest('hex')

export function falSettingsView(): object {
  const configured = hasSettingSecret('fal')
  const source = configured ? effectiveSource('fal') : 'none'
  const masked = source === 'env' ? `••••${config.FAL_KEY!.length > 4 ? config.FAL_KEY!.slice(-4) : ''}` : maskedSetting('fal').secret?.mask
  const lastTest = source === 'setting' ? getSettingValue('fal')?.lastTest : undefined
  return { configured, source, ...(configured && masked ? { masked } : {}), ...(lastTest ? { lastTest } : {}) }
}

/** Probe an impossible request ID, never the paid generation endpoint. Discard every body. */
export async function testFalDraft(apiKey: string, adminId: string): Promise<{ ok: true; latencyMs: number; draftToken: string }> {
  const { style } = await resolveAccountAvatarStyle(db, adminId)
  const start = Date.now()
  let status: number
  try {
    const response = await fetch(`https://queue.fal.run/${style.fal.meta.model}/requests/${randomUUID()}/status`, {
      method: 'GET', headers: { Authorization: `Key ${apiKey}` }, redirect: 'error', signal: AbortSignal.timeout(10_000),
    })
    status = response.status
    const reader = response.body?.getReader()
    if (reader) {
      let size = 0
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          size += value.byteLength
          if (size > 64 * 1024) throw new Error('response_limit')
        }
      } finally { await reader.cancel(); reader.releaseLock() }
    }
  } catch { throw new AiServiceError('FAL_UNREACHABLE', 502) }
  if (status === 401 || status === 403) throw new AiServiceError('FAL_KEY_INVALID', 400)
  if (status !== 404) throw new AiServiceError('FAL_UNREACHABLE', 502)
  const latencyMs = Date.now() - start
  // Same in-memory, bounded, single-use receipt protocol as ai-settings.ts.
  for (const [token, receipt] of drafts) if (receipt.expires <= Date.now()) drafts.delete(token)
  if (drafts.size >= 1000) throw new AiServiceError('FAL_DRAFT_CAPACITY', 429)
  const draftToken = randomBytes(32).toString('base64url')
  drafts.set(draftToken, { digest: digest(apiKey), adminId, expires: Date.now() + 600_000, at: new Date().toISOString() })
  return { ok: true, latencyMs, draftToken }
}

export async function saveFalDraft(apiKey: string, token: string, adminId: string): Promise<void> {
  if (effectiveSource('fal') === 'env') throw new AiServiceError('ENV_OVERRIDE', 409)
  const receipt = drafts.get(token)
  if (!receipt || receipt.expires <= Date.now() || receipt.adminId !== adminId || receipt.digest !== digest(apiKey)) {
    throw new AiServiceError('TEST_REQUIRED', 409)
  }
  drafts.delete(token) // Before the first await: concurrent saves cannot consume twice.
  await writeServerSetting('fal', { value: { lastTest: { ok: true, at: receipt.at } }, secret: apiKey }, adminId)
}
