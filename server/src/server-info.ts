import serverPackageManifest from '../package.json' with { type: 'json' }
import { readFileSync, readdirSync } from 'node:fs'
import { config, type Config } from './config.js'
import { avatarGenerationEnabled } from './lib/avatar-generation.js'
import { getInstanceIdentity } from './lib/instance-identity.js'
import { getSettingValue, hasSettingSecret } from './lib/server-settings.js'
import { registrationMode } from './lib/instance-overview.js'
import { isStrictSemver } from './lib/semver.js'

const SERVER_PACKAGE_NAME = '@skillhub/server'
const RELEASE_BUILD_ID = /^[a-f0-9]{64}$/
const MIGRATION_MARKER = /^\d{14}_[a-z0-9_]+$/

type PublicServiceStatus = 'ok' | 'ready' | 'unavailable'

export const SERVER_CAPABILITIES = Object.freeze([
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
] as const)

export function serverCapabilities(profile: Config['SKILLHUB_PROFILE']): readonly string[] {
  return profile === 'yitan-official' ? SERVER_CAPABILITIES : Object.freeze(
    SERVER_CAPABILITIES.filter((capability) => !capability.startsWith('marketplace.') && !capability.startsWith('web-admin.'))
  )
}

export type PublicServiceInfo = {
  profile: Config['SKILLHUB_PROFILE']
  auth: { password: boolean; yitanOidc: boolean; registration: 'open' | 'invite' | 'closed' }
  media: { allowedImageHosts: string[] }
  features: { marketplace: boolean; ai: boolean; avatars: boolean; localAiLeases?: true; catalogInstall?: true }
  minClientVersion: string | null
  instance?: { id: string; publicKey: string }
  status: PublicServiceStatus
  version: string
  buildId: string
  migrationMarker: string
  capabilities: readonly string[]
  timestamp: string
}

export type ServerReleaseMetadata = {
  schemaVersion: 1
  buildId: string
  migrationMarker: string
}

export function serverVersionFromManifest(manifest: unknown): string {
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
    throw new Error('Server package manifest must be an object')
  }
  const record = manifest as Record<string, unknown>
  if (record.name !== SERVER_PACKAGE_NAME) {
    throw new Error(`Server package manifest name must be ${SERVER_PACKAGE_NAME}`)
  }
  if (typeof record.version !== 'string' || !isStrictSemver(record.version)) {
    throw new Error('Server package manifest version must be strict SemVer')
  }
  return record.version
}

export const SERVER_VERSION = serverVersionFromManifest(serverPackageManifest)

export function serverReleaseMetadataFromJson(value: unknown): ServerReleaseMetadata {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Server release metadata must be an object')
  }
  const record = value as Record<string, unknown>
  if (record.schemaVersion !== 1) {
    throw new Error('Server release metadata schemaVersion must be 1')
  }
  if (typeof record.buildId !== 'string' || !RELEASE_BUILD_ID.test(record.buildId)) {
    throw new Error('Server release metadata buildId must be a lowercase SHA-256 digest')
  }
  if (typeof record.migrationMarker !== 'string' || !MIGRATION_MARKER.test(record.migrationMarker)) {
    throw new Error('Server release metadata migrationMarker must be a canonical migration name')
  }
  return Object.freeze({
    schemaVersion: 1,
    buildId: record.buildId,
    migrationMarker: record.migrationMarker,
  })
}

function developmentReleaseMetadata(): ServerReleaseMetadata {
  const migrationNames = readdirSync(new URL('../prisma/migrations/', import.meta.url), {
    withFileTypes: true,
  })
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && MIGRATION_MARKER.test(entry.name))
    .map((entry) => entry.name)
    .sort()
  const migrationMarker = migrationNames.at(-1)
  if (!migrationMarker) throw new Error('No canonical Prisma migration marker was found')
  return Object.freeze({
    schemaVersion: 1,
    buildId: 'development',
    migrationMarker,
  })
}

function bundledReleaseMetadata(): ServerReleaseMetadata {
  try {
    const raw = readFileSync(new URL('./release-metadata.json', import.meta.url), 'utf8')
    return serverReleaseMetadataFromJson(JSON.parse(raw) as unknown)
  } catch (error: unknown) {
    if (process.env.NODE_ENV !== 'production') return developmentReleaseMetadata()
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`Production server release metadata is missing or invalid: ${detail}`)
  }
}

export const SERVER_RELEASE_METADATA = bundledReleaseMetadata()
export const SERVER_BUILD_ID = SERVER_RELEASE_METADATA.buildId
export const SERVER_MIGRATION_MARKER = SERVER_RELEASE_METADATA.migrationMarker

export function hasAppliedMigrationMarker(rows: unknown): boolean {
  return Array.isArray(rows)
    && rows.length === 1
    && typeof rows[0] === 'object'
    && rows[0] !== null
    && !Array.isArray(rows[0])
    && (rows[0] as Record<string, unknown>).applied === true
}

export function publicServiceInfo(
  status: PublicServiceStatus,
  now: Date = new Date(),
  releaseMetadata: Pick<ServerReleaseMetadata, 'buildId' | 'migrationMarker'> = SERVER_RELEASE_METADATA
): PublicServiceInfo {
  const identity = getInstanceIdentity()
  const selfhost = config.SKILLHUB_PROFILE === 'selfhost'
  return {
    profile: config.SKILLHUB_PROFILE,
    auth: {
      password: selfhost || config.AUTH_MODE !== 'yitan',
      yitanOidc: config.AUTH_MODE !== 'legacy',
      registration: selfhost ? registrationMode() : !config.LOCAL_REGISTRATION_ENABLED
        || (config.REGISTRATION_MODE === 'invite' && !config.REGISTRATION_INVITE_CODE?.trim())
        ? 'closed' : config.REGISTRATION_MODE,
    },
    media: { allowedImageHosts: [...new Set([
      ...config.TOPIC_IMAGE_HOSTS,
      ...(selfhost ? [new URL(config.PUBLIC_BASE_URL).hostname] : []),
    ])] },
    features: {
      ...(selfhost ? { catalogInstall: true as const, localAiLeases: true as const, localAiAvatarDrafts: config.SKILL_AVATAR_MODEL_READS === 'variants' && avatarGenerationEnabled() } : {}),
      marketplace: !selfhost,
      ai: getSettingValue('ai') !== null && hasSettingSecret('ai'),
      // Selfhost avatars can use direct prompts; AI is not required when a fal key exists.
      avatars: avatarGenerationEnabled(),
    },
    minClientVersion: config.MIN_CLIENT_VERSION ?? null,
    ...(identity ? { instance: { id: identity.id, publicKey: identity.publicKey } } : {}),
    status,
    version: SERVER_VERSION,
    buildId: releaseMetadata.buildId,
    migrationMarker: releaseMetadata.migrationMarker,
    capabilities: serverCapabilities(config.SKILLHUB_PROFILE),
    timestamp: now.toISOString(),
  }
}
