import { afterEach, describe, expect, it, vi } from 'vitest'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { getInstanceIdentity } from './lib/instance-identity.js'
import { config } from './config.js'
import { REQUIRED_PRODUCTION_CAPABILITIES } from '../../scripts/verify-production-compatibility.mjs'
import {
  hasAppliedMigrationMarker,
  publicServiceInfo,
  SERVER_CAPABILITIES,
  SERVER_MIGRATION_MARKER,
  SERVER_VERSION,
  serverReleaseMetadataFromJson,
  serverVersionFromManifest,
} from './server-info.js'

vi.mock('./lib/instance-identity.js', () => ({ getInstanceIdentity: vi.fn() }))

const releaseMetadata = {
  schemaVersion: 1 as const,
  buildId: 'a'.repeat(64),
  migrationMarker: '20260804010000_add_skill_version_mutation_digest',
}
const originalConfig = {
  ...config, AI_API_BASE_URL: config.AI_API_BASE_URL, AI_API_KEY: config.AI_API_KEY,
  FAL_KEY: config.FAL_KEY, MIN_CLIENT_VERSION: config.MIN_CLIENT_VERSION,
  REGISTRATION_INVITE_CODE: config.REGISTRATION_INVITE_CODE,
}
afterEach(() => { Object.assign(config, originalConfig) })

describe('public server information', () => {
  it.each(['selfhost', 'yitan-official'] as const)('describes %s authentication, media and optional minimum version', (profile) => {
    Object.assign(config, {
      SKILLHUB_PROFILE: profile, AUTH_MODE: 'yitan', LOCAL_REGISTRATION_ENABLED: true,
      REGISTRATION_MODE: 'invite', REGISTRATION_INVITE_CODE: 'usable-invite',
      PUBLIC_BASE_URL: 'https://instance.example.test:8443/skills',
      TOPIC_IMAGE_HOSTS: ['images.example.test'], MIN_CLIENT_VERSION: '0.32.0-rc.1',
      SKILL_AVATARS_ENABLED: false, AI_API_BASE_URL: undefined, AI_API_KEY: undefined, FAL_KEY: undefined,
    })
    expect(publicServiceInfo('ready')).toMatchObject({
      profile,
      auth: { password: profile === 'selfhost', yitanOidc: true, registration: 'invite' },
      media: { allowedImageHosts: profile === 'selfhost' ? ['images.example.test', 'instance.example.test'] : ['images.example.test'] },
      features: { marketplace: profile === 'yitan-official', ai: false, avatars: false },
      minClientVersion: '0.32.0-rc.1',
    })
    expect(publicServiceInfo('ready').features.localAiLeases).toBe(profile === 'selfhost' ? true : undefined)
    expect(publicServiceInfo('ready').features.catalogInstall).toBe(profile === 'selfhost' ? true : undefined)
    config.AUTH_MODE = 'dual'
    expect(publicServiceInfo('ready').auth).toMatchObject({ password: true, yitanOidc: true })
    config.AUTH_MODE = 'legacy'
    expect(publicServiceInfo('ready').auth).toMatchObject({ password: true, yitanOidc: false })
    config.MIN_CLIENT_VERSION = undefined
    expect(publicServiceInfo('ready').minClientVersion).toBeNull()
    config.TOPIC_IMAGE_HOSTS.push('instance.example.test')
    expect(publicServiceInfo('ready').media.allowedImageHosts).toEqual(['images.example.test', 'instance.example.test'])
  })

  it.each([
    [false, 'open', undefined, 'closed'], [false, 'invite', 'code', 'closed'],
    [true, 'invite', undefined, 'closed'], [true, 'invite', '', 'closed'],
    [true, 'invite', '  ', 'closed'], [true, 'invite', 'code', 'invite'], [true, 'open', undefined, 'open'],
  ] as const)('describes registration enabled=%s mode=%s code=%s as %s', (enabled, mode, code, expected) => {
    Object.assign(config, { LOCAL_REGISTRATION_ENABLED: enabled, REGISTRATION_MODE: mode, REGISTRATION_INVITE_CODE: code })
    expect(publicServiceInfo('ready').auth.registration).toBe(expected)
  })

  it('uses effective env AI and profile-specific avatar rules without publishing secrets', () => {
    Object.assign(config, { SKILLHUB_PROFILE: 'selfhost', AI_API_BASE_URL: 'https://ai.example.test', AI_API_KEY: undefined, FAL_KEY: 'private-fal-key' })
    expect(publicServiceInfo('ready').features).toEqual({ marketplace: false, catalogInstall: true, ai: false, avatars: true, localAiLeases: true, localAiAvatarDrafts: false })
    config.AI_API_KEY = 'private-ai-key'
    config.AI_MODEL = 'model'.repeat(50)
    expect(publicServiceInfo('ready').features.ai).toBe(true)
    config.SKILLHUB_PROFILE = 'yitan-official'
    config.SKILL_AVATARS_ENABLED = false
    expect(publicServiceInfo('ready').features.avatars).toBe(false)
    config.SKILL_AVATARS_ENABLED = true
    expect(publicServiceInfo('ready').features.avatars).toBe(true)
    expect(JSON.stringify(publicServiceInfo('ready'))).not.toContain('private-')
  })
  it('advertises local avatar drafts only for enabled selfhost variants', () => {
    Object.assign(config, { SKILLHUB_PROFILE: 'selfhost', SKILL_AVATAR_MODEL_READS: 'variants', FAL_KEY: 'fixture-key' })
    expect(publicServiceInfo('ready').features.localAiAvatarDrafts).toBe(true)
    config.FAL_KEY = undefined; expect(publicServiceInfo('ready').features.localAiAvatarDrafts).toBe(false)
    config.FAL_KEY = 'fixture-key'; config.SKILL_AVATAR_MODEL_READS = 'legacy'
    expect(publicServiceInfo('ready').features.localAiAvatarDrafts).toBe(false)
    config.SKILLHUB_PROFILE = 'yitan-official'; config.SKILL_AVATAR_MODEL_READS = 'variants'
    expect(publicServiceInfo('ready').features.localAiAvatarDrafts).toBeUndefined()
  })
  it('exposes only the loaded instance ID and raw public key', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    const instance = { id: randomUUID(), publicKey: publicKey.export({ format: 'jwk' }).x!, privateKey }
    vi.mocked(getInstanceIdentity).mockReturnValueOnce(instance)
    const info = publicServiceInfo('ready')
    expect(info.instance).toEqual({ id: instance.id, publicKey: instance.publicKey })
    expect(Object.keys(info.instance!)).toEqual(['id', 'publicKey'])
    expect(Buffer.from(info.instance!.publicKey, 'base64url')).toHaveLength(32)
    expect(publicServiceInfo('ready')).not.toHaveProperty('instance')
  })

  it('omits only marketplace and web-admin capabilities from selfhost payloads', () => {
    const previousProfile = config.SKILLHUB_PROFILE
    config.SKILLHUB_PROFILE = 'selfhost'
    try {
      const capabilities = publicServiceInfo('ready').capabilities
      expect(capabilities).toEqual(SERVER_CAPABILITIES.filter((item) => !item.startsWith('marketplace.') && !item.startsWith('web-admin.')))
      expect(Object.isFrozen(capabilities)).toBe(true)
    } finally {
      config.SKILLHUB_PROFILE = previousProfile
    }
  })
  it('uses the checked-in server package version in public status payloads', () => {
    const now = new Date('2026-08-03T00:00:00.000Z')

    expect(SERVER_VERSION).toBe('0.32.1')
    expect(publicServiceInfo('ready', now, releaseMetadata)).toEqual({
      profile: 'yitan-official',
      auth: { password: true, yitanOidc: false, registration: 'open' },
      media: { allowedImageHosts: ['picem-media.whatonearth.work'] },
      features: { marketplace: true, ai: false, avatars: false },
      minClientVersion: null,
      status: 'ready',
      version: '0.32.1',
      buildId: releaseMetadata.buildId,
      migrationMarker: releaseMetadata.migrationMarker,
      capabilities: [
        'auth.password.v1',
        'auth.yitan-oidc.v1',
        'auth.yitan-backchannel-logout.v1',
        'teams.management.v1',
        'teams.owner-invites.v1',
        'skills.packages.v1',
        'skills.source-url.v1',
        'skills.version-mutation-digest.v1',
        'runtime.env.v1',
        'marketplace.public.v1',
        'marketplace.moderation.v1',
        'marketplace.discovery.v2',
        'marketplace.discussion.v1',
        'marketplace.metrics.v1',
        'web-admin.session.v1',
        'web-admin.yitan-oidc.v1',
        'feedback.intake.v1',
        'media.picem.v1',
        'skills.avatars.v1',
        'skills.library-sync.v1',
        'skills.library-organizer.v1',
        'skills.version-policy.v1',
        'app-updates.manifest.v1',
      ],
      timestamp: now.toISOString(),
    })
  })

  it('publishes an immutable, duplicate-free capability contract', () => {
    expect(Object.isFrozen(SERVER_CAPABILITIES)).toBe(true)
    expect(new Set(SERVER_CAPABILITIES).size).toBe(SERVER_CAPABILITIES.length)
    expect(SERVER_CAPABILITIES).toEqual(expect.arrayContaining(REQUIRED_PRODUCTION_CAPABILITIES))
    expect(SERVER_CAPABILITIES).not.toContain('credentials.device-proof.v1')
    expect(SERVER_CAPABILITIES).not.toContain('credentials.native-consent.v1')
  })

  it('uses the catalog token migration as the current readiness marker', () => {
    expect(SERVER_MIGRATION_MARKER).toBe('20261021130000_catalog_tokens')
  })

  it('rejects malformed or unrelated package manifests', () => {
    expect(() => serverVersionFromManifest(null)).toThrow('must be an object')
    expect(() => serverVersionFromManifest({ name: 'another-package', version: '0.4.0' }))
      .toThrow('manifest name')
    expect(() => serverVersionFromManifest({ name: '@skillhub/server', version: 'latest' }))
      .toThrow('strict SemVer')
    expect(() => serverVersionFromManifest({ name: '@skillhub/server', version: '0.4.0-01' }))
      .toThrow('strict SemVer')
  })

  it('accepts only immutable release metadata', () => {
    expect(serverReleaseMetadataFromJson(releaseMetadata)).toEqual(releaseMetadata)
    expect(() => serverReleaseMetadataFromJson(null)).toThrow('must be an object')
    expect(() => serverReleaseMetadataFromJson({ ...releaseMetadata, schemaVersion: 2 }))
      .toThrow('schemaVersion must be 1')
    expect(() => serverReleaseMetadataFromJson({ ...releaseMetadata, buildId: 'development' }))
      .toThrow('lowercase SHA-256')
    expect(() => serverReleaseMetadataFromJson({ ...releaseMetadata, migrationMarker: 'latest' }))
      .toThrow('canonical migration name')
  })

  it('recognizes only one explicitly applied migration row', () => {
    expect(hasAppliedMigrationMarker([{ applied: true }])).toBe(true)
    expect(hasAppliedMigrationMarker([])).toBe(false)
    expect(hasAppliedMigrationMarker([{ applied: false }])).toBe(false)
    expect(hasAppliedMigrationMarker([{ applied: true }, { applied: true }])).toBe(false)
  })
})
