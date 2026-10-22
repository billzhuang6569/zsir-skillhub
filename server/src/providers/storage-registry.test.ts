import { afterEach, describe, expect, it, vi } from 'vitest'
import { configSchema } from '../config-schema.js'
import { createStorageRegistry, s3StorageNamespace } from './storage-registry.js'

const base = { DATABASE_URL: 'postgresql://unused', JWT_SECRET: 'test-secret-long-enough' }
const s3 = { S3_ENDPOINT: 'http://minio:9000', S3_REGION: 'us-east-1', S3_BUCKET: 'skillhub',
  S3_ACCESS_KEY_ID: 'fixture', S3_SECRET_ACCESS_KEY: 'fixture-secret', S3_FORCE_PATH_STYLE: 'true', S3_PREFIX: 'instance' }
afterEach(() => vi.unstubAllGlobals())

describe('storage config and registry', () => {
  it('defaults to filesystem, accepts configured S3 before switching and requires complete S3 configuration', () => {
    expect(configSchema.parse(base).STORAGE_DEFAULT).toBe('filesystem')
    expect(configSchema.safeParse({ ...base, STORAGE_DEFAULT: 's3' }).success).toBe(false)
    for (const field of ['S3_ENDPOINT', 'S3_REGION', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY']) {
      expect(configSchema.safeParse({ ...base, ...s3, [field]: '' }).success).toBe(false)
    }
    expect(configSchema.parse({ ...base, ...s3 }).STORAGE_DEFAULT).toBe('filesystem')
    expect(configSchema.parse({ ...base, ...s3, STORAGE_DEFAULT: 's3' }).STORAGE_DEFAULT).toBe('s3')
  })
  it.each(['http://public.example.com', 'ftp://minio', 'https://user:secret@host.test', 'https://host.test?q=x', 'https://host.test#x', 'https://host.test/path'])('rejects unsafe endpoint %s', endpoint => {
    expect(configSchema.safeParse({ ...base, ...s3, S3_ENDPOINT: endpoint }).success).toBe(false)
  })
  it.each(['http://127.0.0.1:9000', 'http://[::1]:9000', 'http://minio:9000', 'https://s3.example.com'])('accepts endpoint %s', endpoint => {
    expect(configSchema.safeParse({ ...base, ...s3, S3_ENDPOINT: endpoint }).success).toBe(true)
  })
  it('validates prefix and path-style boolean and stabilizes namespace independently of credentials', () => {
    expect(configSchema.safeParse({ ...base, ...s3, S3_PREFIX: '../bad' }).success).toBe(false)
    expect(configSchema.safeParse({ ...base, ...s3, S3_FORCE_PATH_STYLE: 'maybe' }).success).toBe(false)
    const a = createStorageRegistry(configSchema.parse({ ...base, ...s3 })).target('cards', 's3')
    const b = createStorageRegistry(configSchema.parse({ ...base, ...s3, S3_ENDPOINT: s3.S3_ENDPOINT + '/', S3_SECRET_ACCESS_KEY: 'rotated' })).target('media', 's3')
    expect(a.storageNamespace).toMatch(/^s3:[0-9a-f]{16}$/)
    expect(b.storageNamespace).toBe(a.storageNamespace)
    expect(s3StorageNamespace(s3.S3_ENDPOINT, 'otherbucket', s3.S3_PREFIX)).not.toBe(a.storageNamespace)
  })
  it('keeps legacy roots readable with S3 default and returns 503 for unknown namespace', async () => {
    const registry = createStorageRegistry(configSchema.parse({ ...base, ...s3, STORAGE_DEFAULT: 's3' }))
    expect(registry.target('cards').storage.provider).toBe('s3')
    expect(registry.read('cards', { storageProvider: 'filesystem', storageNamespace: null }).provider).toBe('filesystem')
    for (const location of [
      { storageProvider: 's3', storageNamespace: null }, { storageProvider: 's3', storageNamespace: 's3:old' },
      { storageProvider: 'filesystem', storageNamespace: 'unknown' },
    ]) {
      try { registry.read('media', location); expect.unreachable() } catch (error) { expect(error).toMatchObject({ statusCode: 503 }) }
    }
    vi.stubGlobal('fetch', vi.fn(async () => new Response('s3 bytes')))
    expect(await registry.read('cards', registry.target('cards')).get('key')).toEqual(Buffer.from('s3 bytes'))
  })
})
