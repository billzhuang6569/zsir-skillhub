import { createHash } from 'node:crypto'
import { config } from '../config.js'
import { db } from '../db.js'
import { MediaError, type MediaUploadOptions } from '../lib/media.js'
import { createStorageRegistry } from './storage-registry.js'
import { ObjectMissingError, type ObjectStorage } from './object-storage.js'
export { isRetiredMedia } from './picem-media.js'

const EXTENSIONS: Readonly<Record<string, string>> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }

export function publicImageUrl(value: string): string {
  if (!/^\/media\/([a-f0-9]{2})\/\1[a-f0-9]{62}\.(jpg|png|webp)(?![\s\S])/.test(value)) {
    throw new MediaError(502, '媒体服务返回了无效图片地址')
  }
  return value
}

export async function authorizeMediaUrl(value: string | null | undefined, userId: string, _current?: string | null): Promise<void> {
  if (!value) return
  publicImageUrl(value)
  const asset = await db.mediaAsset.findUnique({ where: { url: value } })
  if (!asset || asset.uploadedById !== userId || asset.visibility !== 'public' || asset.status !== 'ready') {
    throw new MediaError(403, '无权使用这张图片')
  }
}

export async function uploadMedia(bytes: Buffer, mimeType: string, _name: string, options: MediaUploadOptions): Promise<{ assetId: string; url: string | null }> {
  const ext = EXTENSIONS[mimeType]
  if (!ext) throw new MediaError(400, '图片类型无效')
  const id = createHash('sha256').update(JSON.stringify(options)).update(bytes).digest('hex')
  const storageKey = `${id.slice(0, 2)}/${id}.${ext}`
  const registry = createStorageRegistry(config)
  const target = registry.target('media')
  const url = options.visibility === 'public' ? `/media/${storageKey}` : null
  // Record the key before writing so an interrupted private upload can still be cleaned up.
  const asset = await db.mediaAsset.upsert({ where: { id }, create: {
    id, assetId: id, uploadedById: options.userId ?? null, ownerRef: options.ownerRef,
    purpose: options.purpose, visibility: options.visibility,
    mimeType, storageKey, storageProvider: target.storageProvider, storageNamespace: target.storageNamespace,
  }, update: {} })
  // A retry keeps the first row's attribution, even after the default changes.
  const storage = registry.read('media', asset)
  await storage.put(storageKey, bytes)
  await db.mediaAsset.update({ where: { id }, data: { status: 'ready', url } })
  return { assetId: id, url }
}

export async function removeMedia(ownerRef: string): Promise<void> {
  const registry = createStorageRegistry(config)
  const assets = await db.mediaAsset.findMany({ where: { ownerRef, visibility: 'private', storageProvider: { in: ['filesystem', 's3'] } } })
  for (const asset of assets) {
    if (!asset.storageKey) continue
    const storage = registry.read('media', asset)
    await db.mediaAsset.update({ where: { id: asset.id }, data: { status: 'deleting' } })
    await storage.delete(asset.storageKey)
    await db.mediaAsset.update({ where: { id: asset.id }, data: { status: 'deleted', url: null } })
  }
}

async function readBytes(storage: ObjectStorage, key: string): Promise<Buffer> {
  try { return await storage.get(key) } catch (error: unknown) {
    if (error instanceof ObjectMissingError) throw new MediaError(404, '图片不存在')
    throw error
  }
}

export async function readPrivateMedia(assetId: string, ownerRef: string, maxBytes: number): Promise<Buffer> {
  const asset = await db.mediaAsset.findUnique({ where: { assetId } })
  if (!asset || asset.ownerRef !== ownerRef || asset.visibility !== 'private' || asset.status !== 'ready'
    || !asset.storageKey) throw new MediaError(404, '图片不存在')
  const storage = createStorageRegistry(config).read('media', asset)
  const info = await storage.head(asset.storageKey)
  if (!info) throw new MediaError(404, '图片不存在')
  if (info.size > maxBytes) throw new MediaError(502, '图片超过大小限制')
  const bytes = await readBytes(storage, asset.storageKey)
  if (bytes.length > maxBytes) throw new MediaError(502, '图片超过大小限制')
  return bytes
}

export async function readPublicMedia(value: string): Promise<{ bytes: Buffer; mimeType: string }> {
  try { publicImageUrl(value) } catch { throw new MediaError(404, '图片不存在') }
  const asset = await db.mediaAsset.findUnique({ where: { url: value } })
  if (!asset || asset.visibility !== 'public' || asset.status !== 'ready' || !asset.mimeType
    || asset.storageKey !== value.slice('/media/'.length)
    || !EXTENSIONS[asset.mimeType]) throw new MediaError(404, '图片不存在')
  const storage = createStorageRegistry(config).read('media', asset)
  return { bytes: await readBytes(storage, asset.storageKey), mimeType: asset.mimeType }
}
