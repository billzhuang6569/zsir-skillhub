import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { config } from '../config.js'
import { db } from '../db.js'
import { MediaError } from '../lib/media.js'

const Asset = z.object({ id: z.string().regex(/^ast_[a-zA-Z0-9_-]+$/), status: z.string() })
const Access = z.object({ url: z.string().url().optional(), status: z.string().optional() })

async function picemRequest(path: string, method = 'GET', body?: FormData | Record<string, unknown>, key?: string): Promise<unknown> {
  if (!config.PICEM_API_KEY) throw new MediaError(503, '媒体服务尚未配置')
  try {
    const response = await fetch(`${config.PICEM_BASE_URL}${path}`, {
      method, redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: {
        Authorization: `Bearer ${config.PICEM_API_KEY}`,
        ...(body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
        ...(key ? { 'Idempotency-Key': key } : {}),
      },
      body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
    })
    if (!response.ok) throw new MediaError(response.status >= 500 ? 503 : 502, '媒体服务暂时不可用')
    return await response.json() as unknown
  } catch (error: unknown) {
    if (error instanceof MediaError) throw error
    // Keep API keys, signed links and upstream response bodies out of errors/logs.
    throw new MediaError(503, '媒体服务暂时不可用，请重试')
  }
}

export function publicImageUrl(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.hostname !== 'picem-media.whatonearth.work'
    || url.port || url.username || url.password || url.search || url.hash) {
    throw new MediaError(502, '媒体服务返回了无效图片地址')
  }
  return url.toString()
}

export function isRetiredMedia(value: string | null | undefined): boolean {
  if (!value) return false
  try {
    const url = new URL(value)
    const host = url.hostname.replace(/\.$/, '')
    return host === 'pictshare.whatonearth.work'
      || (host === 'bill-api.whatonearth.work' && url.pathname.startsWith('/skillhub/topic-covers/'))
  } catch { return false }
}

export async function authorizeMediaUrl(value: string | null | undefined, userId: string, current?: string | null): Promise<void> {
  if (!value) return
  if (isRetiredMedia(value)) throw new MediaError(426, '请升级 SkillHub 后重新上传图片')
  const url = new URL(value)
  if (value === current) return
  if (url.hostname.replace(/\.$/, '') !== 'picem-media.whatonearth.work') return
  publicImageUrl(value)
  const asset = await db.mediaAsset.findUnique({ where: { url: value } })
  if (!asset || asset.uploadedById !== userId || asset.visibility !== 'public') throw new MediaError(403, '无权使用这张图片')
}

export async function uploadMedia(bytes: Buffer, mimeType: string, name: string, options: {
  purpose: 'avatar' | 'image'; visibility: 'public' | 'private'; ownerRef: string; userId?: string
}): Promise<{ assetId: string; url: string | null }> {
  // The same owner/content always resumes the same upstream request after a timeout.
  const key = createHash('sha256').update(JSON.stringify(options)).update(bytes).digest('hex')
  const body = new FormData()
  body.append('file', new Blob([new Uint8Array(bytes)], { type: mimeType }), name)
  body.append('purpose', options.purpose)
  body.append('visibility', options.visibility)
  body.append('owner_ref', options.ownerRef)
  await db.mediaAsset.upsert({ where: { id: key }, create: {
    id: key, uploadedById: options.userId ?? null, ownerRef: options.ownerRef,
    purpose: options.purpose, visibility: options.visibility,
  }, update: {} })
  let asset = Asset.parse(await picemRequest('/v1/assets', 'POST', body, key))
  await db.mediaAsset.update({ where: { id: key }, data: { assetId: asset.id, status: asset.status } })
  const deadline = Date.now() + 60_000
  while (asset.status !== 'ready') {
    if (['failed', 'deleted', 'deleting'].includes(asset.status) || Date.now() >= deadline) throw new MediaError(503, '图片尚未就绪，请重试')
    await delay(1_000)
    asset = Asset.parse(await picemRequest(`/v1/assets/${encodeURIComponent(asset.id)}`))
  }
  const access = Access.parse(await picemRequest(`/v1/assets/${encodeURIComponent(asset.id)}/access`, 'POST', { variant: options.purpose === 'avatar' ? 'avatar-256' : 'original' }))
  if (!access.url) throw new MediaError(503, '图片尚未就绪，请重试')
  const url = options.visibility === 'public' ? publicImageUrl(access.url) : null
  await db.mediaAsset.update({ where: { id: key }, data: { status: 'ready', url } })
  return { assetId: asset.id, url }
}

export async function removeMedia(ownerRef: string): Promise<void> {
  // Cleanup is scoped to an unpublished feedback submission; public unlinking never deletes shared media.
  const assets = await db.mediaAsset.findMany({ where: { ownerRef, visibility: 'private' } })
  for (const asset of assets) {
    if (!asset.assetId) continue // Unknown upload result retains its stable key for reconciliation.
    await db.mediaAsset.update({ where: { id: asset.id }, data: { status: 'deleting' } })
    await picemRequest(`/v1/assets/${encodeURIComponent(asset.assetId)}`, 'DELETE')
    const deadline = Date.now() + 60_000
    while (Asset.parse(await picemRequest(`/v1/assets/${encodeURIComponent(asset.assetId)}`)).status !== 'deleted') {
      if (Date.now() >= deadline) throw new MediaError(503, '图片清理尚未完成')
      await delay(1_000)
    }
    await db.mediaAsset.update({ where: { id: asset.id }, data: { status: 'deleted', url: null } })
  }
}

export async function readPrivateMedia(assetId: string, ownerRef: string, maxBytes: number): Promise<Buffer> {
  const asset = await db.mediaAsset.findUnique({ where: { assetId } })
  if (!asset || asset.ownerRef !== ownerRef || asset.visibility !== 'private') throw new MediaError(404, '图片不存在')
  const access = Access.parse(await picemRequest(`/v1/assets/${encodeURIComponent(assetId)}/access`, 'POST', { variant: 'original', expires_in: 60 }))
  if (!access.url) throw new MediaError(503, '图片尚未就绪')
  const url = new URL(access.url)
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.aliyuncs.com')) throw new MediaError(502, '图片地址无效')
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(15_000) })
  if (!response.ok || !response.body) throw new MediaError(503, '图片读取失败')
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of response.body) {
    size += chunk.length
    if (size > maxBytes) throw new MediaError(502, '图片超过大小限制')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}
