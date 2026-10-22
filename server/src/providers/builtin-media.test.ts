import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { ObjectMissingError } from './object-storage.js'

const mediaAsset = vi.hoisted(() => ({ upsert: vi.fn(), update: vi.fn(), findUnique: vi.fn(), findMany: vi.fn() }))
const storage = vi.hoisted(() => ({ provider: 'filesystem', get: vi.fn(), head: vi.fn(), put: vi.fn(), delete: vi.fn() }))
vi.mock('../db.js', () => ({ db: { mediaAsset } }))
vi.mock('../config.js', () => ({ config: { SKILLHUB_PROFILE: 'selfhost', MEDIA_STORAGE_DIR: '/test/media', PUBLIC_BASE_URL: 'https://host.test/skillhub' } }))
vi.mock('./filesystem-object-storage.js', () => ({ createFilesystemObjectStorage: () => storage }))
import { config } from '../config.js'
import * as s3Provider from './s3-object-storage.js'
import { s3StorageNamespace } from './storage-registry.js'
import { readPublicMedia } from './builtin-media.js'
import { authorizeMediaUrl, publicImageUrl, readPrivateMedia, removeMedia, uploadMedia } from '../lib/media.js'
import { parseStoredFeedbackAttachments, readFeedbackAttachment, storeFeedbackAttachments } from '../lib/feedback-attachments.js'

const bytes = Buffer.from('prepared image')
const options = { purpose: 'avatar' as const, visibility: 'public' as const, ownerRef: 'user:owner', userId: 'owner' }
const id = createHash('sha256').update(JSON.stringify(options)).update(bytes).digest('hex')
const key = `${id.slice(0, 2)}/${id}.png`
const url = `/media/${key}`
const row = { id, assetId: id, ownerRef: options.ownerRef, uploadedById: 'owner', visibility: 'public', status: 'ready',
  storageProvider: 'filesystem', storageNamespace: null, storageKey: key, mimeType: 'image/png', url }

beforeEach(() => {
  vi.resetAllMocks()
  storage.put.mockResolvedValue(undefined)
  storage.get.mockResolvedValue(bytes)
  storage.head.mockResolvedValue({ size: bytes.length })
  mediaAsset.findUnique.mockResolvedValue(row)
  mediaAsset.upsert.mockImplementation(async input => input.create)
  Object.assign(config, { STORAGE_DEFAULT: 'filesystem', S3_ENDPOINT: undefined, S3_REGION: undefined, S3_BUCKET: undefined,
    S3_ACCESS_KEY_ID: undefined, S3_SECRET_ACCESS_KEY: undefined, S3_PREFIX: '', S3_FORCE_PATH_STYLE: true })
})
afterEach(() => vi.restoreAllMocks())

describe('builtin media through the selfhost facade', () => {
  it('writes S3 attribution and reads old local rows independently of the default', async () => {
    Object.assign(config, { STORAGE_DEFAULT: 's3', S3_ENDPOINT: 'http://seaweedfs:8333', S3_REGION: 'us-east-1',
      S3_BUCKET: 'skillhub', S3_ACCESS_KEY_ID: 'fixture', S3_SECRET_ACCESS_KEY: 'fixture-secret' })
    const s3 = { provider: 's3' as const, get: vi.fn(async () => bytes), put: vi.fn(async () => {}), head: vi.fn(), delete: vi.fn() }
    vi.spyOn(s3Provider, 'createS3ObjectStorage').mockReturnValue(s3)
    const namespace = s3StorageNamespace(config.S3_ENDPOINT!, config.S3_BUCKET!, '')
    await uploadMedia(bytes, 'image/png', 'image', options)
    expect(mediaAsset.upsert.mock.calls[0][0].create).toMatchObject({ storageProvider: 's3', storageNamespace: namespace })
    expect(s3.put).toHaveBeenCalledWith(key, bytes)
    expect(await readPublicMedia(url)).toEqual({ bytes, mimeType: 'image/png' })
    expect(storage.get).toHaveBeenCalledWith(key)
    mediaAsset.findUnique.mockResolvedValue({ ...row, storageProvider: 's3', storageNamespace: namespace })
    expect((await readPublicMedia(url)).bytes).toEqual(bytes)
    expect(s3.get).toHaveBeenCalledWith(key)
    // Retrying an old upload must not leave its row pointing at unwritten local bytes.
    mediaAsset.upsert.mockResolvedValue(row)
    await uploadMedia(bytes, 'image/png', 'image', options)
    expect(storage.put).toHaveBeenCalledWith(key, bytes)
  })
  it('stores bytes under the stable digest and returns the same relative URL after an address change', async (): Promise<void> => {
    expect(await uploadMedia(bytes, 'image/png', '../../untrusted.png', options)).toEqual({ assetId: id, url })
    config.PUBLIC_BASE_URL = 'https://new-host.test/new-base'
    expect(await uploadMedia(bytes, 'image/png', 'new-name.png', options)).toEqual({ assetId: id, url })
    expect(storage.put.mock.calls).toEqual([[key, bytes], [key, bytes]])
    expect(mediaAsset.upsert).toHaveBeenCalledWith({ where: { id }, create: {
      id, assetId: id, uploadedById: 'owner', ownerRef: options.ownerRef, purpose: 'avatar', visibility: 'public',
      mimeType: 'image/png', storageKey: key, storageProvider: 'filesystem', storageNamespace: null,
    }, update: {} })
    expect(mediaAsset.update).toHaveBeenCalledWith({ where: { id }, data: { status: 'ready', url } })
    expect(await uploadMedia(bytes, 'image/png', 'same.png', { ...options, ownerRef: 'user:other' })).not.toEqual({ assetId: id, url })
  })

  it('persists private keys before writing, leaves failed writes unready and never returns a private URL', async (): Promise<void> => {
    const privateOptions = { ...options, visibility: 'private' as const }
    storage.put.mockRejectedValueOnce(new Error('fsync failed'))
    await expect(uploadMedia(bytes, 'image/png', 'private.png', privateOptions)).rejects.toThrow('fsync failed')
    expect(mediaAsset.upsert).toHaveBeenCalledOnce()
    expect(mediaAsset.update).not.toHaveBeenCalled()
    const result = await uploadMedia(bytes, 'image/png', 'private.png', privateOptions)
    expect(result.url).toBeNull()
    expect(mediaAsset.update).toHaveBeenCalledWith({ where: { id: result.assetId }, data: { status: 'ready', url: null } })
  })

  it('authorizes only the uploader of a ready public asset, even when it matches current', async (): Promise<void> => {
    await expect(authorizeMediaUrl(url, 'owner')).resolves.toBeUndefined()
    await expect(authorizeMediaUrl(url, 'other', url)).rejects.toMatchObject({ statusCode: 403 })
    for (const asset of [null, { ...row, visibility: 'private' }, { ...row, status: 'deleted' }]) {
      mediaAsset.findUnique.mockResolvedValue(asset)
      await expect(authorizeMediaUrl(url, 'owner', url)).rejects.toMatchObject({ statusCode: 403 })
    }
  })

  it('round-trips feedback metadata with the actual builtin digest before reading private bytes', async (): Promise<void> => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const stored = await storeFeedbackAttachments('feedback-id', [{ fileName: 'screen.png', mimeType: 'image/png', dataBase64: png.toString('base64') }])
    const parsed = parseStoredFeedbackAttachments(JSON.parse(JSON.stringify(stored)) as unknown)
    expect(parsed).toEqual(stored)
    expect(parsed).toHaveLength(1)
    const attachment = parsed[0]!
    expect(attachment.assetId).toMatch(/^[a-f0-9]{64}$/)
    mediaAsset.findUnique.mockResolvedValue({ ...row, id: attachment.assetId, assetId: attachment.assetId,
      ownerRef: 'feedback:feedback-id', visibility: 'private', url: null,
      storageKey: `${attachment.assetId.slice(0, 2)}/${attachment.assetId}.png` })
    storage.head.mockResolvedValue({ size: png.length })
    storage.get.mockResolvedValue(png)
    expect(await readFeedbackAttachment('feedback-id', attachment)).toEqual(png)
    await expect(readFeedbackAttachment('other-feedback', attachment)).rejects.toMatchObject({ statusCode: 404 })
  })

  it.each([`https://host.test${url}`, `//host.test${url}`, `${url}?x=1`, `${url}#x`, `${url}\n`,
    '/media/aa/../../secret', `/media/ff/${id}.png`, `/media/${id.slice(0, 2)}/${id}.svg`, url.toUpperCase()])('rejects invalid public URL %s', (value) => {
    expect(() => publicImageUrl(value)).toThrow()
  })

  it('reads private bytes only for the matching owner and ready private visibility', async (): Promise<void> => {
    const privateRow = { ...row, visibility: 'private', url: null }
    mediaAsset.findUnique.mockResolvedValue(privateRow)
    expect(await readPrivateMedia(id, options.ownerRef, bytes.length)).toEqual(bytes)
    storage.get.mockClear()
    await expect(readPrivateMedia(id, 'feedback:other', 100)).rejects.toMatchObject({ statusCode: 404 })
    for (const asset of [null, row, { ...privateRow, status: 'deleted' }]) {
      mediaAsset.findUnique.mockResolvedValue(asset)
      await expect(readPrivateMedia(id, options.ownerRef, 100)).rejects.toMatchObject({ statusCode: 404 })
    }
    expect(storage.get).not.toHaveBeenCalled()
  })

  it('bounds private reads before and after loading and distinguishes missing bytes from I/O errors', async (): Promise<void> => {
    mediaAsset.findUnique.mockResolvedValue({ ...row, visibility: 'private' })
    await expect(readPrivateMedia(id, options.ownerRef, bytes.length - 1)).rejects.toMatchObject({ statusCode: 502 })
    expect(storage.get).not.toHaveBeenCalled()
    storage.head.mockResolvedValue({ size: 1 })
    await expect(readPrivateMedia(id, options.ownerRef, bytes.length - 1)).rejects.toMatchObject({ statusCode: 502 })
    storage.head.mockResolvedValue(null)
    await expect(readPrivateMedia(id, options.ownerRef, 100)).rejects.toMatchObject({ statusCode: 404 })
    storage.head.mockResolvedValue({ size: 1 })
    storage.get.mockRejectedValueOnce(new ObjectMissingError())
    await expect(readPrivateMedia(id, options.ownerRef, 100)).rejects.toMatchObject({ statusCode: 404 })
    storage.get.mockRejectedValueOnce(new Error('EACCES'))
    await expect(readPrivateMedia(id, options.ownerRef, 100)).rejects.toThrow('EACCES')
  })

  it('deletes only private assets and preserves deleting status on a failed delete for retry', async (): Promise<void> => {
    mediaAsset.findMany.mockResolvedValue([{ ...row, visibility: 'private', url: null }])
    storage.delete.mockRejectedValueOnce(new Error('EACCES'))
    await expect(removeMedia(options.ownerRef)).rejects.toThrow('EACCES')
    expect(mediaAsset.update.mock.calls.at(-1)?.[0].data.status).toBe('deleting')
    await removeMedia(options.ownerRef)
    expect(mediaAsset.findMany).toHaveBeenCalledWith({ where: { ownerRef: options.ownerRef, visibility: 'private', storageProvider: { in: ['filesystem', 's3'] } } })
    expect(storage.delete).toHaveBeenCalledWith(key)
    expect(mediaAsset.update.mock.calls.at(-1)?.[0]).toEqual({ where: { id }, data: { status: 'deleted', url: null } })
  })
})
