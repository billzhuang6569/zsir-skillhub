import { createHash, randomBytes } from 'node:crypto'
import { z } from 'zod'
import { config } from '../config.js'
import { effectiveSource, getSettingSecret, getSettingValue, hasSettingSecret, maskedSetting, writeServerSetting } from './server-settings.js'
import { AiServiceError, aiJsonRequest, normalizeAiBaseUrl } from './ai-http.js'

export const AiDraft = z.object({
  protocol: z.enum(['openai', 'anthropic', 'openai-responses']),
  baseUrl: z.string().max(2048).transform(normalizeAiBaseUrl),
  model: z.string().trim().min(1).max(200),
  apiKey: z.string().min(1).max(1024).optional(),
}).strict()
export type EffectiveAi = z.infer<typeof AiDraft> & { apiKey: string; source: 'env' | 'setting' }

export function aiProviderInfo(): { baseUrl: string | null; model: string | null; protocol: string | null } {
  const value = getSettingValue('ai')
  return { baseUrl: value?.baseUrl ?? null, model: value?.model ?? null, protocol: value?.protocol ?? null }
}

export function aiStatus(): { configured: boolean; source: 'env' | 'setting' | 'none' } {
  const configured = getSettingValue('ai') !== null && hasSettingSecret('ai')
  return { configured, source: configured ? effectiveSource('ai') : 'none' }
}

export function aiPolicy(): { limits: { instanceDaily: number; perUserDaily: number }; allowedPrivateHosts: string[] } {
  return getSettingValue('ai.policy') ?? {
    limits: { instanceDaily: config.AI_GLOBAL_DAILY_LIMIT, perUserDaily: config.AI_PER_USER_DAILY_LIMIT ?? 50 },
    allowedPrivateHosts: [],
  }
}

/** The only resolver of effective provider credentials, shared by every AI caller. */
export async function resolveAiConfig(): Promise<EffectiveAi | null> {
  if (!aiStatus().configured) return null
  const value = getSettingValue('ai')!
  const apiKey = await getSettingSecret('ai')
  if (!apiKey) return null
  return { protocol: value.protocol, baseUrl: value.baseUrl, model: value.model, apiKey, source: effectiveSource('ai') as 'env' | 'setting' }
}

export function aiSettingsView(): object {
  const status = aiStatus()
  const value = getSettingValue('ai')
  const mask = maskedSetting('ai').secret?.mask
  return { source: status.source, protocol: value?.protocol ?? null, baseUrl: value?.baseUrl ?? null,
    model: value?.model ?? null, keyLast4: status.source === 'env' ? (config.AI_API_KEY!.length > 4 ? config.AI_API_KEY!.slice(-4) : null) : mask?.slice(4) || null,
    ...aiPolicy(), lastTest: status.source === 'env' ? null : value?.lastTest ?? null }
}

export async function resolveAiDraft(input: z.infer<typeof AiDraft>): Promise<EffectiveAi> {
  let apiKey = input.apiKey
  if (!apiKey) {
    const saved = await resolveAiConfig()
    if (!saved || normalizeAiBaseUrl(saved.baseUrl) !== input.baseUrl) throw new AiServiceError('API_KEY_REQUIRED')
    apiKey = saved.apiKey
  }
  return { ...input, apiKey, source: 'setting' }
}

function endpoint(baseUrl: string, path: string): URL {
  return new URL(`${baseUrl.replace(/\/+$/, '').replace(/\/v1$/i, '')}/v1/${path}`)
}

function headers(draft: EffectiveAi): Record<string, string> {
  return draft.protocol === 'anthropic' ? { 'x-api-key': draft.apiKey, 'anthropic-version': '2023-06-01' }
    : { authorization: `Bearer ${draft.apiKey}` }
}

export async function aiModels(draft: EffectiveAi): Promise<string[]> {
  const response = await aiJsonRequest(endpoint(draft.baseUrl, 'models'), headers(draft), undefined, aiPolicy().allowedPrivateHosts, config.AI_TIMEOUT_MS)
  const parsed = z.object({ data: z.array(z.object({ id: z.string().min(1).max(200) })).max(10_000) }).safeParse(response)
  if (!parsed.success) throw new AiServiceError('AI_INVALID_RESPONSE', 502)
  return [...new Set(parsed.data.data.map(model => model.id))]
}

export async function requestSafeAiCompletion(draft: EffectiveAi, system: string, input: string,
  format: 'json' | 'text' = 'json', maxTokens = config.AI_MAX_TOKENS): Promise<string> {
  const anthropic = draft.protocol === 'anthropic'
  const responses = draft.protocol === 'openai-responses'
  const body = anthropic ? { model: draft.model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: input }] }
    : responses ? { model: draft.model, max_output_tokens: maxTokens, instructions: system, input,
      ...(format === 'json' ? { text: { format: { type: 'json_object' } } } : {}) }
      : { model: draft.model, max_tokens: maxTokens, messages: [{ role: 'system', content: system }, { role: 'user', content: input }],
        ...(format === 'json' ? { response_format: { type: 'json_object' } } : {}) }
  const payload = await aiJsonRequest(endpoint(draft.baseUrl, anthropic ? 'messages' : responses ? 'responses' : 'chat/completions'),
    headers(draft), body, aiPolicy().allowedPrivateHosts, config.AI_TIMEOUT_MS)
  const block = z.object({ type: z.string(), text: z.string().optional() })
  let text: string
  try {
    text = anthropic ? z.object({ content: z.array(block) }).parse(payload).content.filter(b => b.type === 'text').map(b => b.text ?? '').join('')
      : responses ? z.object({ output: z.array(z.object({ content: z.array(block).optional() })) }).parse(payload).output
        .flatMap(o => o.content ?? []).filter(b => b.type === 'output_text').map(b => b.text ?? '').join('')
        : z.object({ choices: z.array(z.object({ message: z.object({ content: z.string() }) })) }).parse(payload).choices[0]?.message.content ?? ''
  } catch { throw new AiServiceError('AI_INVALID_RESPONSE', 502) }
  if (!text.trim()) throw new AiServiceError('AI_INVALID_RESPONSE', 502)
  return text
}

type DraftReceipt = { digest: string; adminId: string; expires: number; at: string; latencyMs: number }
const drafts = new Map<string, DraftReceipt>()
function draftDigest(draft: EffectiveAi): string {
  return createHash('sha256').update(JSON.stringify([draft.protocol, draft.baseUrl, draft.model,
    createHash('sha256').update(draft.apiKey).digest('hex'), aiPolicy().allowedPrivateHosts])).digest('hex')
}

export async function testAiDraft(draft: EffectiveAi, adminId: string): Promise<{ ok: true; latencyMs: number; draftToken: string }> {
  const digest = draftDigest(draft)
  const start = Date.now()
  const text = await requestSafeAiCompletion(draft, 'Return only JSON: {"ok":true}', 'Reply with the requested JSON.', 'json', 64)
  try { z.object({ ok: z.literal(true) }).strict().parse(JSON.parse(text)) }
  catch { throw new AiServiceError('AI_INVALID_RESPONSE', 502) }
  const latencyMs = Date.now() - start
  for (const [token, receipt] of drafts) if (receipt.expires <= Date.now()) drafts.delete(token)
  if (drafts.size >= 1000) throw new AiServiceError('AI_DRAFT_CAPACITY', 429)
  const draftToken = randomBytes(32).toString('base64url')
  drafts.set(draftToken, { digest, adminId, expires: Date.now() + 600_000, at: new Date().toISOString(), latencyMs })
  return { ok: true, latencyMs, draftToken }
}

export async function saveAiDraft(draft: EffectiveAi, token: string, adminId: string): Promise<void> {
  const receipt = drafts.get(token)
  if (!receipt || receipt.expires <= Date.now() || receipt.adminId !== adminId || receipt.digest !== draftDigest(draft)) {
    throw new AiServiceError('TEST_REQUIRED', 409)
  }
  // Consume before the first await: concurrent saves cannot reuse the receipt.
  drafts.delete(token)
  await writeServerSetting('ai', { value: { protocol: draft.protocol, baseUrl: draft.baseUrl, model: draft.model,
    lastTest: { ok: true, at: receipt.at, latencyMs: receipt.latencyMs } }, secret: draft.apiKey }, adminId)
}
