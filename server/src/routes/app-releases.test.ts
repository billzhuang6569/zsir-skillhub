import Fastify, { type FastifyInstance } from 'fastify'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockConfig = vi.hoisted(() => ({ APP_UPDATE_MANIFEST_PATH: '' }))
const mockDb = vi.hoisted(() => ({ appReleaseDownloadMetric: { upsert: vi.fn() } }))
vi.mock('../config.js', () => ({ config: mockConfig }))
vi.mock('../db.js', () => ({ db: mockDb }))

import { appReleasesRoutes } from './app-releases.js'

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify()
  await app.register(appReleasesRoutes, { prefix: '/api/app-releases' })
  await app.ready()
  return app
}

function releaseManifest() {
  return {
    schemaVersion: 2,
    releases: [{
      target: 'darwin', arch: 'aarch64', version: '0.9.0',
      notes: '支持应用内安全更新', pubDate: '2026-09-01T08:00:00.000Z', minimumSystemVersion: '11.0',
      installer: {
        kind: 'dmg',
        url: 'https://downloads.example.com/skillhub/v0.9.0/SkillHub_0.9.0_aarch64.dmg',
        sha256: 'b'.repeat(64), size: 2048,
      },
      updater: {
        url: 'https://downloads.example.com/skillhub/v0.9.0/SkillHub.app.tar.gz',
        signature: 'trusted-signature', sha256: 'c'.repeat(64), size: 1024,
      },
    }, {
      target: 'darwin', arch: 'x86_64', version: '0.9.0',
      notes: '支持 Intel Mac', pubDate: '2026-09-01T08:00:00.000Z', minimumSystemVersion: '11.0',
      installer: {
        kind: 'dmg',
        url: 'https://downloads.example.com/skillhub/v0.9.0/SkillHub_0.9.0_x86_64.dmg',
        sha256: 'f'.repeat(64), size: 2048,
      },
      updater: {
        url: 'https://downloads.example.com/skillhub/v0.9.0/SkillHub_x86_64.app.tar.gz',
        signature: 'intel-signature', sha256: 'a'.repeat(64), size: 1024,
      },
    }, {
      target: 'windows', arch: 'x86_64', version: '0.10.0',
      notes: 'Windows 正式版', pubDate: '2026-09-02T08:00:00.000Z', minimumSystemVersion: '10.0.19041',
      installer: {
        kind: 'nsis',
        url: 'https://downloads.example.com/skillhub/v0.10.0/SkillHub_0.10.0_x64-setup.exe',
        sha256: 'd'.repeat(64), size: 4096,
      },
      updater: {
        url: 'https://downloads.example.com/skillhub/v0.10.0/SkillHub_0.10.0_x64-setup.nsis.zip',
        signature: 'windows-signature', sha256: 'e'.repeat(64), size: 3072,
      },
    }],
  }
}

describe('app release download endpoints', () => {
  let app: FastifyInstance | undefined

  beforeEach(async () => {
    vi.clearAllMocks()
    const directory = await mkdtemp(join(tmpdir(), 'skillhub-app-release-'))
    mockConfig.APP_UPDATE_MANIFEST_PATH = join(directory, 'manifest.json')
  })

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  it('returns release metadata with a directly downloadable DMG URL', async () => {
    await writeFile(mockConfig.APP_UPDATE_MANIFEST_PATH, JSON.stringify(releaseManifest()))
    app = await buildApp()

    const response = await app.inject({ method: 'GET', url: '/api/app-releases/latest' })
    expect(response.statusCode).toBe(200)
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.json()).toEqual({
      version: '0.9.0',
      notes: '支持应用内安全更新',
      pubDate: '2026-09-01T08:00:00.000Z',
      platform: 'darwin',
      target: 'darwin',
      arch: 'aarch64',
      minimumSystemVersion: '11.0',
      download: releaseManifest().releases[0]?.installer,
    })
  })

  it('selects and redirects a Windows installer by target and architecture', async () => {
    await writeFile(mockConfig.APP_UPDATE_MANIFEST_PATH, JSON.stringify(releaseManifest()))
    app = await buildApp()

    const metadata = await app.inject({ method: 'GET', url: '/api/app-releases/latest?target=windows&arch=x86_64' })
    expect(metadata.statusCode).toBe(200)
    expect(metadata.json()).toMatchObject({ version: '0.10.0', target: 'windows', arch: 'x86_64', download: { kind: 'nsis' } })
    const download = await app.inject({ method: 'GET', url: '/api/app-releases/latest/download?target=windows&arch=x86_64' })
    expect(download.statusCode).toBe(307)
    expect(download.headers.location).toBe(releaseManifest().releases[2]?.installer.url)
    expect(mockDb.appReleaseDownloadMetric.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ version: '0.10.0', target: 'windows', arch: 'x86_64', count: 1 }),
      update: { count: { increment: 1 } },
    }))
    const defaultWindows = await app.inject({ method: 'GET', url: '/api/app-releases/latest?target=windows' })
    expect(defaultWindows.statusCode).toBe(200)
    expect(defaultWindows.json()).toMatchObject({ target: 'windows', arch: 'x86_64' })
    expect((await app.inject({ method: 'GET', url: '/api/app-releases/latest?target=windows&arch=i686' })).statusCode).toBe(204)
  })

  it('keeps Intel and Apple Silicon installer routes distinct', async () => {
    await writeFile(mockConfig.APP_UPDATE_MANIFEST_PATH, JSON.stringify(releaseManifest()))
    app = await buildApp()

    const intel = await app.inject({ method: 'GET', url: '/api/app-releases/latest?target=darwin&arch=x86_64' })
    expect(intel.statusCode).toBe(200)
    expect(intel.json()).toMatchObject({ target: 'darwin', arch: 'x86_64', download: { kind: 'dmg' } })
    const intelDownload = await app.inject({ method: 'GET', url: '/api/app-releases/latest/download?target=darwin&arch=x86_64' })
    expect(intelDownload.statusCode).toBe(307)
    expect(intelDownload.headers.location).toBe(releaseManifest().releases[1]?.installer.url)
    const defaultMac = await app.inject({ method: 'GET', url: '/api/app-releases/latest?target=darwin' })
    expect(defaultMac.json()).toMatchObject({ target: 'darwin', arch: 'aarch64' })
  })

  it('redirects the stable DMG endpoint to the immutable versioned artifact', async () => {
    await writeFile(mockConfig.APP_UPDATE_MANIFEST_PATH, JSON.stringify(releaseManifest()))
    app = await buildApp()

    const response = await app.inject({ method: 'GET', url: '/api/app-releases/latest/dmg' })
    expect(response.statusCode).toBe(307)
    expect(response.headers.location).toBe(releaseManifest().releases[0]?.installer.url)
  })

  it('keeps downloads available when metric persistence fails', async () => {
    await writeFile(mockConfig.APP_UPDATE_MANIFEST_PATH, JSON.stringify(releaseManifest()))
    mockDb.appReleaseDownloadMetric.upsert.mockRejectedValueOnce(new Error('database unavailable'))
    app = await buildApp()

    const response = await app.inject({ method: 'GET', url: '/api/app-releases/latest/download?target=darwin&arch=aarch64' })
    expect(response.statusCode).toBe(307)
    expect(response.headers.location).toBe(releaseManifest().releases[0]?.installer.url)
  })

  it('fails closed for malformed manifests and returns no release when disabled', async () => {
    app = await buildApp()
    const missing = await app.inject({ method: 'GET', url: '/api/app-releases/latest' })
    expect(missing.statusCode).toBe(204)
    expect(missing.headers['cache-control']).toBe('no-store')
    await writeFile(mockConfig.APP_UPDATE_MANIFEST_PATH, '{invalid')
    expect((await app.inject({ method: 'GET', url: '/api/app-releases/latest' })).statusCode).toBe(503)
  })
})
