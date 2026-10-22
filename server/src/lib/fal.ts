import { z } from 'zod'
import { config } from '../config.js'
import { prepareTopicCover, MAX_TOPIC_COVER_BYTES } from './topic-cover-assets.js'
import { parseRetryAfterMs } from '../utils/retry-after.js'
import { classicAvatarStyle } from './avatar-style-catalog.js'
import { getSettingSecret, hasSettingSecret } from './server-settings.js'

export async function resolveFalKey(): Promise<string | null> {
  return config.FAL_KEY || (config.SKILLHUB_PROFILE === 'selfhost' ? getSettingSecret('fal') : null)
}

export function falAvailable(): boolean {
  return Boolean(config.FAL_KEY) || (config.SKILLHUB_PROFILE === 'selfhost' && hasSettingSecret('fal'))
}

export const FAL_AVATAR_MODEL = classicAvatarStyle.fal.meta.model
export type AvatarFalOptions = { model: string; parameters: Record<string, unknown> }
export function falAvatarPayload(prompt: string, options: AvatarFalOptions = classicAvatarStyle.fal.meta): Record<string, unknown> {
  return { prompt, ...options.parameters }
}

export class FalError extends Error {
  /**
   * `status` and `retryAfterMs` are set only for HTTP refusals, so the worker
   * can honour the provider's wait; the response body is never retained.
   */
  constructor(
    public readonly code: string,
    public readonly status: number | null = null,
    public readonly retryAfterMs: number | null = null,
  ) { super(code); this.name = 'FalError' }
}

function falHttpError(prefix: string, response: Pick<Response, 'status' | 'headers'>): FalError {
  return new FalError(`${prefix}${response.status}`, response.status, parseRetryAfterMs(response.headers.get('retry-after')))
}

async function falRequest(path: string, body?: Record<string, unknown>, model = FAL_AVATAR_MODEL): Promise<unknown> {
  const key = await resolveFalKey()
  if (!key) throw new FalError('fal_not_configured')
  const response = await fetch(`https://queue.fal.run/${model}${path}`, {
    method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(20_000),
    headers: { Authorization: `Key ${key}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!response.ok) throw falHttpError('fal_http_', response)
  return await response.json() as unknown
}

export async function submitFalAvatar(prompt: string, options: AvatarFalOptions = classicAvatarStyle.fal.meta): Promise<string> {
  // No automatic retry: a timeout may already have accepted a paid request.
  const result = z.object({ request_id: z.string().uuid() }).parse(await falRequest('', falAvatarPayload(prompt, options), options.model))
  return result.request_id
}

export async function findSubmittedFalAvatar(prompt: string, submittedAt: Date, options: AvatarFalOptions = classicAvatarStyle.fal.meta): Promise<string | null> {
  const key = await resolveFalKey()
  if (!key) throw new FalError('fal_not_configured')
  const start = submittedAt.getTime() - 30_000
  const latestSentAt = submittedAt.getTime() + 120_000
  const expected = falAvatarPayload(prompt, options)
  const matches = new Set<string>()
  let cursor: string | null = null
  // ponytail: at most 300 history rows; larger/incomplete windows stay quarantined for manual inspection.
  for (let page = 0; page < 3; page += 1) {
    const url = new URL('https://api.fal.ai/v1/models/requests/by-endpoint')
    url.search = new URLSearchParams({ endpoint_id: options.model, expand: 'payloads', limit: '100',
      // History sorts by completion; do not assume its time filter uses sent_at.
      // Keep slow completions visible, then restrict the actual submission time below.
      start: new Date(start).toISOString(), end: new Date(Date.now() + 1_000).toISOString(),
      ...(cursor ? { cursor } : {}), }).toString()
    const response = await fetch(url, { headers: { Authorization: `Key ${key}` },
      redirect: 'error', signal: AbortSignal.timeout(20_000) })
    if (!response.ok) throw falHttpError('fal_history_http_', response)
    const result = z.object({ items: z.array(z.object({
      request_id: z.string().uuid(), endpoint_id: z.string(), sent_at: z.string().datetime(),
      json_input: z.record(z.unknown()).nullish(),
    })), next_cursor: z.string().nullable(), has_more: z.boolean() }).parse(await response.json())
    for (const item of result.items) {
      const sent = Date.parse(item.sent_at)
      if (item.endpoint_id === options.model && sent >= start && sent <= latestSentAt
        && Object.entries(expected).every(([key, value]) => item.json_input?.[key] === value)) matches.add(item.request_id)
    }
    if (!result.has_more && !result.next_cursor) return matches.size === 1 ? [...matches][0] : null
    if (!result.has_more || !result.next_cursor || result.next_cursor === cursor) throw new FalError('fal_history_incomplete')
    cursor = result.next_cursor
  }
  throw new FalError('fal_history_incomplete')
}

export async function pollFalAvatar(requestId: string, options: AvatarFalOptions = classicAvatarStyle.fal.meta): Promise<string | null> {
  const id = z.string().uuid().parse(requestId)
  const status = z.object({
    status: z.enum(['IN_QUEUE', 'IN_PROGRESS', 'COMPLETED']), error: z.unknown().optional(),
  }).parse(await falRequest(`/requests/${id}/status`, undefined, options.model))
  if (status.error !== undefined && status.error !== null) throw new FalError('fal_generation_failed')
  if (status.status !== 'COMPLETED') return null
  const result = z.object({
    images: z.array(z.object({ url: z.string().url() })).length(1), error: z.unknown().optional(),
  }).safeParse(await falRequest(`/requests/${id}`, undefined, options.model))
  if (!result.success || (result.data.error !== undefined && result.data.error !== null)) {
    throw new FalError('fal_invalid_result')
  }
  return falImageUrl(result.data.images[0].url)
}

export function falImageUrl(value: string): string {
  const url = new URL(value)
  const allowed = /^(?:[a-z0-9-]+\.)?fal\.media$/.test(url.hostname)
    || (url.hostname === 'storage.googleapis.com' && url.pathname.startsWith('/falserverless/'))
  if (!allowed || url.protocol !== 'https:' || url.port || url.username || url.password) {
    throw new FalError('fal_invalid_image_url')
  }
  return url.toString()
}

export function validateAvatarJpeg(bytes: Buffer): void {
  prepareTopicCover({ mimeType: 'image/jpeg', dataBase64: bytes.toString('base64') })
  if (bytes.length < 4 || bytes.readUInt16BE(bytes.length - 2) !== 0xffd9) throw new FalError('invalid_avatar_jpeg')
  for (let offset = 2; offset + 4 < bytes.length;) {
    if (bytes[offset] !== 0xff) throw new FalError('invalid_avatar_jpeg')
    const marker = bytes[offset + 1]
    if (marker === 0xff) { offset += 1; continue }
    if (marker === 0xda || marker === 0xd9) break
    const length = bytes.readUInt16BE(offset + 2)
    if (length < 2 || offset + 2 + length > bytes.length) throw new FalError('invalid_avatar_jpeg')
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (length < 8) throw new FalError('invalid_avatar_jpeg')
      const height = bytes.readUInt16BE(offset + 5)
      const width = bytes.readUInt16BE(offset + 7)
      if (width < 128 || width > 1024 || width !== height) throw new FalError('invalid_avatar_dimensions')
      return // Picem also decodes the full image before its asset becomes ready.
    }
    offset += 2 + length
  }
  throw new FalError('invalid_avatar_jpeg')
}

export async function downloadFalAvatar(value: string): Promise<Buffer> {
  const response = await fetch(falImageUrl(value), { redirect: 'error', signal: AbortSignal.timeout(20_000) })
  if (!response.ok || !response.body || !response.headers.get('content-type')?.startsWith('image/jpeg')) {
    throw new FalError('fal_image_unavailable')
  }
  const chunks: Uint8Array[] = []
  let length = 0
  for await (const chunk of response.body) {
    length += chunk.length
    if (length > MAX_TOPIC_COVER_BYTES) throw new FalError('fal_image_too_large')
    chunks.push(chunk)
  }
  const bytes = Buffer.concat(chunks)
  validateAvatarJpeg(bytes)
  return bytes
}
