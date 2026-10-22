import Fastify, { type FastifyInstance } from 'fastify'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockConfig = vi.hoisted(() => ({ APP_UPDATE_MANIFEST_PATH: '' }))
vi.mock('../config.js', () => ({ config: mockConfig }))

import { appUpdatesRoutes, compareAppVersions } from './app-updates.js'

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify()
  await app.register(appUpdatesRoutes, { prefix: '/api/app-updates' })
  await app.ready()
  return app
}

describe('app update manifest endpoint', () => {
  let app: FastifyInstance | undefined

  beforeEach(async () => {
    const directory = await mkdtemp(join(tmpdir(), 'skillhub-app-update-'))
    mockConfig.APP_UPDATE_MANIFEST_PATH = join(directory, 'manifest.json')
  })

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  it('compares stable and prerelease versions as SemVer', () => {
    expect(compareAppVersions('1.2.0', '1.1.9')).toBe(1)
    expect(compareAppVersions('1.2.0-beta.2', '1.2.0-beta.10')).toBe(-1)
    expect(compareAppVersions('1.2.0', '1.2.0-beta.10')).toBe(1)
    expect(compareAppVersions('1.2.0+build.2', '1.2.0+build.1')).toBe(0)
  })

  it('returns the standard updater response only for a newer matching artifact', async () => {
    await writeFile(mockConfig.APP_UPDATE_MANIFEST_PATH, JSON.stringify({
      schemaVersion: 2,
      releases: [{
        target: 'darwin', arch: 'aarch64', version: '1.2.0', notes: '稳定性改进',
        pubDate: '2026-08-13T08:00:00.000Z', minimumSystemVersion: '11.0',
        installer: { kind: 'dmg', url: 'https://downloads.example.com/skillhub/v1.2.0/SkillHub.dmg', sha256: 'a'.repeat(64), size: 1024 },
        updater: { url: 'https://cdn.example.com/skillhub/updates/v1.2.0/app.tar.gz', signature: 'signed-manifest-value' },
      }, {
        target: 'darwin', arch: 'x86_64', version: '1.2.0', notes: 'Intel Mac 更新',
        pubDate: '2026-08-13T08:00:00.000Z', minimumSystemVersion: '11.0',
        installer: { kind: 'dmg', url: 'https://downloads.example.com/skillhub/v1.2.0/SkillHub_x86_64.dmg', sha256: 'c'.repeat(64), size: 1024 },
        updater: { url: 'https://cdn.example.com/skillhub/updates/v1.2.0/app_x86_64.tar.gz', signature: 'intel-signature' },
      }, {
        target: 'windows', arch: 'x86_64', version: '1.3.0', notes: 'Windows 更新',
        pubDate: '2026-08-14T08:00:00.000Z', minimumSystemVersion: '10.0.19041',
        installer: { kind: 'nsis', url: 'https://downloads.example.com/skillhub/v1.3.0/setup.exe', sha256: 'b'.repeat(64), size: 2048 },
        updater: { url: 'https://cdn.example.com/skillhub/updates/v1.3.0/setup.nsis.zip', signature: 'windows-signature' },
      }],
    }))
    app = await buildApp()

    const available = await app.inject({ method: 'GET', url: '/api/app-updates/darwin/aarch64/1.1.0' })
    expect(available.statusCode).toBe(200)
    expect(available.headers['cache-control']).toBe('no-store')
    expect(available.json()).toEqual({
      version: '1.2.0', notes: '稳定性改进', pub_date: '2026-08-13T08:00:00.000Z',
      url: 'https://cdn.example.com/skillhub/updates/v1.2.0/app.tar.gz', signature: 'signed-manifest-value',
    })
    const intel = await app.inject({ method: 'GET', url: '/api/app-updates/darwin/x86_64/1.1.0' })
    expect(intel.statusCode).toBe(200)
    expect(intel.json()).toMatchObject({
      version: '1.2.0', url: 'https://cdn.example.com/skillhub/updates/v1.2.0/app_x86_64.tar.gz', signature: 'intel-signature',
    })
    expect((await app.inject({ method: 'GET', url: '/api/app-updates/darwin/x86_64/1.2.0' })).statusCode).toBe(204)
    expect((await app.inject({ method: 'GET', url: '/api/app-updates/darwin/aarch64/1.2.0' })).statusCode).toBe(204)
    expect((await app.inject({ method: 'GET', url: '/api/app-updates/windows/x86_64/1.2.0' })).json()).toMatchObject({
      version: '1.3.0', url: 'https://cdn.example.com/skillhub/updates/v1.3.0/setup.nsis.zip', signature: 'windows-signature',
    })
  })

  it('fails closed on malformed manifests and treats a missing manifest as disabled', async () => {
    app = await buildApp()
    const missing = await app.inject({ method: 'GET', url: '/api/app-updates/darwin/aarch64/1.0.0' })
    expect(missing.statusCode).toBe(204)
    expect(missing.headers['cache-control']).toBe('no-store')
    await writeFile(mockConfig.APP_UPDATE_MANIFEST_PATH, '{invalid')
    expect((await app.inject({ method: 'GET', url: '/api/app-updates/darwin/aarch64/1.0.0' })).statusCode).toBe(503)
  })
})
