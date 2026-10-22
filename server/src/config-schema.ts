import { z } from 'zod'
import { isIP } from 'node:net'
import { isStrictSemver } from './lib/semver.js'
import { normalizeS3Endpoint } from './providers/s3-object-storage.js'
import { assertObjectStorageKey } from './providers/object-storage.js'

export const publicBaseUrlSchema = z.string().url().transform((value, context): string => {
  const url = new URL(value)
  const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(url.hostname)
  if (
    (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:'))
    || value.includes('?') || value.includes('#')
    || url.username || url.password || value.split('/')[2]?.includes('@')
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'PUBLIC_BASE_URL must use HTTPS (HTTP is allowed only for loopback hosts), without query, fragment or credentials',
    })
    return z.NEVER
  }
  return url.href.replace(/\/+$/, '')
})

const envBoolean = z.preprocess((value) => {
  if (typeof value !== 'string') return value
  const normalized = value.trim().toLowerCase()
  if (normalized === 'true' || normalized === '1') return true
  if (normalized === 'false' || normalized === '0') return false
  return value
}, z.boolean())

const trustedProxies = z.string()
  .transform(value => value.split(',').map(entry => entry.trim()))
  .pipe(z.array(z.string().refine((entry): boolean => {
    const [address, prefix, ...extra] = entry.split('/')
    const family = isIP(address)
    return family !== 0 && !address.includes('%') && extra.length === 0
      && (prefix === undefined || (/^[1-9][0-9]*$/.test(prefix) && Number(prefix) <= (family === 4 ? 32 : 128)))
  }, 'TRUSTED_PROXIES entries must be IPv4/IPv6 addresses or CIDRs with prefixes 1–32/1–128')))

const commaSeparatedValues = z.string().transform((value, context): string[] => {
  const entries = value
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0)
  if (new Set(entries).size !== entries.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Comma-separated values must be unique',
    })
    return z.NEVER
  }
  return entries
})

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const migrationUserIds = commaSeparatedValues.refine(
  (entries) => Array.isArray(entries) && entries.every((entry) => UUID_PATTERN.test(entry)),
  'AUTH_LEGACY_MIGRATION_ALLOWLIST must contain only local User UUIDs'
)

const YITAN_PRODUCTION_ISSUER = 'https://account.whatonearth.work/realms/yitan'
const YITAN_PRODUCTION_JWKS_URL = `${YITAN_PRODUCTION_ISSUER}/protocol/openid-connect/certs`
const YITAN_PRODUCTION_AUDIENCE = 'skillhub-api'
const YITAN_PRODUCTION_CLIENTS = ['skillhub-desktop', 'skillhub-web'] as const
const YITAN_PRODUCTION_BACKCHANNEL_AUDIENCES = ['skillhub-desktop', 'skillhub-web'] as const
const YITAN_TEST_ISSUER = 'https://account.whatonearth.work/realms/yitan-test'
const YITAN_TEST_JWKS_URL = `${YITAN_TEST_ISSUER}/protocol/openid-connect/certs`
const YITAN_TEST_BACKCHANNEL_AUDIENCES = ['skillhub-desktop-test'] as const
const YITAN_WEB_CLIENT_ID = 'skillhub-web'
const YITAN_WEB_REDIRECT_URI = 'https://sk.woe.show/api/web-admin/yitan/callback'
const YITAN_WEB_POST_LOGOUT_REDIRECT_URI = 'https://sk.woe.show/admin/?loggedOut=1'
const YITAN_WEB_SUCCESS_URL = 'https://sk.woe.show/admin/'

const CredentialKekSchema = z.string().regex(
  /^[A-Za-z0-9+/]{43}=$/,
  'CREDENTIAL_KEK_BASE64 must be canonical base64 for exactly 32 bytes'
).refine(
  (value) => Buffer.from(value, 'base64').length === 32,
  'CREDENTIAL_KEK_BASE64 must decode to exactly 32 bytes'
)

const CredentialKekVersionSchema = z.preprocess((value) => {
  if (typeof value === 'string' && /^[1-9][0-9]*$/.test(value)) return Number(value)
  return value
}, z.number().int().min(1).max(1_000_000))

const CredentialKekKeyringJsonSchema = z.string().transform((value, context): Record<string, string> => {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'CREDENTIAL_KEK_KEYRING_JSON must be valid JSON',
    })
    return z.NEVER
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'CREDENTIAL_KEK_KEYRING_JSON must be a JSON object',
    })
    return z.NEVER
  }

  const declaredVersions = Array.from(value.matchAll(/"([1-9][0-9]*)"\s*:/g), (match) => match[1])
  if (
    declaredVersions.length !== Object.keys(parsed).length
    || new Set(declaredVersions).size !== declaredVersions.length
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'CREDENTIAL_KEK_KEYRING_JSON versions must be unique canonical decimal property names',
    })
    return z.NEVER
  }

  const keyring: Record<string, string> = {}
  for (const [version, encodedKey] of Object.entries(parsed)) {
    if (!/^[1-9][0-9]*$/.test(version)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'CREDENTIAL_KEK_KEYRING_JSON contains an invalid KEK version',
      })
      continue
    }
    const numericVersion = Number(version)
    if (!Number.isSafeInteger(numericVersion) || numericVersion > 1_000_000) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'CREDENTIAL_KEK_KEYRING_JSON contains an out-of-range KEK version',
      })
      continue
    }
    const keyResult = CredentialKekSchema.safeParse(encodedKey)
    if (!keyResult.success) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `CREDENTIAL_KEK_KEYRING_JSON version ${version} must be canonical base64 for exactly 32 bytes`,
      })
      continue
    }
    keyring[version] = keyResult.data
  }
  return keyring
}).default('{}')

function isLowEntropyCredentialKek(encodedKey: string): boolean {
  return new Set(Buffer.from(encodedKey, 'base64')).size < 8
}

export const configSchema = z.object({
  MIN_CLIENT_VERSION: z.preprocess(value => value === '' ? undefined : value,
    z.string().refine(isStrictSemver, 'MIN_CLIENT_VERSION must be strict SemVer').optional()),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 chars'),
  JWT_EXPIRES_IN_SECONDS: z.coerce.number().int().min(300).max(63_072_000).default(604_800),
  CATALOG_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
  AUTH_MODE: z.enum(['legacy', 'dual', 'yitan']).default('legacy'),
  LOCAL_REGISTRATION_ENABLED: envBoolean.default(true),
  AUTH_LEGACY_MIGRATION_ALLOWLIST: migrationUserIds.default(''),
  AUTH_LEGACY_MIGRATION_SESSION_SECONDS: z.coerce.number().int().min(60).max(900).default(600),
  AUTH_LOGIN_ATTEMPTS_PER_15_MIN: z.coerce.number().int().min(1).max(1_000).default(10),
  AUTH_LOGIN_IP_ATTEMPTS_PER_15_MIN: z.coerce.number().int().min(10).max(10_000).default(100),
  AUTH_REGISTER_ATTEMPTS_PER_HOUR: z.coerce.number().int().min(1).max(1_000).default(5),
  AUTH_YITAN_EXCHANGE_ATTEMPTS_PER_15_MIN: z.coerce.number().int().min(1).max(1_000).default(30),
  AUTH_YITAN_BACKCHANNEL_ATTEMPTS_PER_MINUTE: z.coerce.number().int().min(10).max(10_000).default(300),
  YITAN_OIDC_ISSUER: z.string().url().refine((value) => !value.endsWith('/'), 'YITAN_OIDC_ISSUER must not end with /').default(YITAN_PRODUCTION_ISSUER),
  YITAN_OIDC_JWKS_URL: z.string().url().default(YITAN_PRODUCTION_JWKS_URL),
  YITAN_OIDC_AUDIENCE: z.string().trim().min(1).max(255).default(YITAN_PRODUCTION_AUDIENCE),
  YITAN_OIDC_ALLOWED_AZP: commaSeparatedValues.refine((entries) => entries.length > 0, 'At least one OIDC client is required').default(YITAN_PRODUCTION_CLIENTS.join(',')),
  YITAN_OIDC_CLOCK_TOLERANCE_SECONDS: z.coerce.number().int().min(0).max(60).default(5),
  YITAN_OIDC_MAX_TOKEN_AGE_SECONDS: z.coerce.number().int().min(300).max(900).default(600),
  YITAN_OIDC_LINK_MAX_AUTH_AGE_SECONDS: z.coerce.number().int().min(60).max(900).default(600),
  YITAN_OIDC_BACKCHANNEL_LOGOUT_AUDIENCE: commaSeparatedValues
    .refine((entries) => entries.length > 0, 'At least one back-channel logout audience is required')
    .default(YITAN_PRODUCTION_BACKCHANNEL_AUDIENCES.join(',')),
  YITAN_OIDC_LOGOUT_MAX_TOKEN_AGE_SECONDS: z.coerce.number().int().min(30).max(300).default(120),
  YITAN_TEST_BACKCHANNEL_ENABLED: envBoolean.default(false),
  YITAN_TEST_OIDC_ISSUER: z.string().url().refine((value) => !value.endsWith('/'), 'YITAN_TEST_OIDC_ISSUER must not end with /').default(YITAN_TEST_ISSUER),
  YITAN_TEST_OIDC_JWKS_URL: z.string().url().default(YITAN_TEST_JWKS_URL),
  YITAN_TEST_OIDC_BACKCHANNEL_LOGOUT_AUDIENCE: commaSeparatedValues
    .refine((entries) => entries.length > 0, 'At least one test back-channel logout audience is required')
    .default(YITAN_TEST_BACKCHANNEL_AUDIENCES.join(',')),
  WEB_ADMIN_EMERGENCY_PASSWORD_LOGIN_ENABLED: envBoolean.default(false),
  YITAN_WEB_CLIENT_ID: z.string().trim().min(1).max(255).default(YITAN_WEB_CLIENT_ID),
  YITAN_WEB_CLIENT_SECRET: z.string().min(16).max(512).optional(),
  YITAN_WEB_REDIRECT_URI: z.string().url().default(YITAN_WEB_REDIRECT_URI),
  YITAN_WEB_POST_LOGOUT_REDIRECT_URI: z.string().url().default(YITAN_WEB_POST_LOGOUT_REDIRECT_URI),
  YITAN_WEB_SUCCESS_URL: z.string().url().default(YITAN_WEB_SUCCESS_URL),
  YITAN_WEB_OIDC_TRANSACTION_SECONDS: z.coerce.number().int().min(120).max(600).default(300),
  YITAN_WEB_OIDC_TOKEN_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(15_000).default(5_000),
  FEEDBACK_ATTEMPTS_PER_HOUR: z.coerce.number().int().min(1).max(1_000).default(10),
  PICEM_BASE_URL: z.literal('https://picem.whatonearth.work').default('https://picem.whatonearth.work'),
  PICEM_API_KEY: z.preprocess(value => value === '' ? undefined : value, z.string().min(32).optional()),
  /** Image hosts a topic article may embed (`![alt](https://host/...)`); others only block publishing. */
  TOPIC_IMAGE_HOSTS: commaSeparatedValues.refine(
    (entries) => Array.isArray(entries) && entries.length > 0 && entries.every((entry) => /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(entry)),
    'TOPIC_IMAGE_HOSTS must list one or more bare host names',
  ).default('picem-media.whatonearth.work'),
  SKILL_AVATARS_ENABLED: envBoolean.default(false),
  SKILL_AVATAR_MODEL_READS: z.enum(['legacy', 'variants']).optional(),
  FAL_KEY: z.preprocess(value => value === '' ? undefined : value, z.string().trim().min(16).max(512).optional()),
  SKILL_AVATAR_DAILY_LIMIT: z.coerce.number().int().min(1).max(10_000).default(200),
  /** Avatar worker steps running at once (#235); queued tasks wait for a free slot. */
  SKILL_AVATAR_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),
  /**
   * Of those, at most this many in the paid LLM prompt + FAL submit stage. Avatar prompts are
   * background AI work: they share AI_MAX_CONCURRENT with user requests and must leave at least
   * one slot free, so this may not exceed AI_MAX_CONCURRENT - 1 (#238).
   */
  SKILL_AVATAR_GENERATE_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(1),
  APP_UPDATE_MANIFEST_PATH: z.string().trim().min(1).default('app-update-manifest.json'),
  ADMIN_AGENT_RELEASE_SUMMARY_PATH: z.string().trim().min(1).refine((value) => value.startsWith('/'), 'ADMIN_AGENT_RELEASE_SUMMARY_PATH must be an absolute path').default('/opt/skillhub/data/admin-agent-release-summary.json'),
  ADMIN_GATEWAY_LOG_PATH: z.string().trim().min(1).refine((value) => value.startsWith('/'), 'ADMIN_GATEWAY_LOG_PATH must be an absolute path').default('/var/log/skillhub/gateway-access.jsonl'),
  REGISTRATION_MODE: z.enum(['open', 'invite']).optional(),
  REGISTRATION_INVITE_CODE: z.string().trim().max(512).optional(),
  SKILL_MAX_PER_USER: z.coerce.number().int().min(1).max(10_000).default(50),
  SKILL_MAX_VERSIONS_PER_SKILL: z.coerce.number().int().min(1).max(1_000).default(30),
  SKILL_MAX_STORAGE_BYTES_PER_USER: z.coerce.number().int().min(20 * 1024 * 1024).max(100 * 1024 * 1024 * 1024).default(250 * 1024 * 1024),
  SKILL_VERSION_WRITES_PER_HOUR: z.coerce.number().int().min(1).max(1_000).default(30),
  MIGRATION_WRITES_PER_HOUR: z.coerce.number().int().min(1).max(100_000).default(1200),
  SKILL_CARD_STORAGE_DIR: z.string().trim().min(1).refine((value) => value.startsWith('/'), 'SKILL_CARD_STORAGE_DIR must be an absolute path').default('/opt/skillhub/data/skill-cards'),
  MEDIA_STORAGE_DIR: z.string().trim().min(1).refine((value) => value.startsWith('/'), 'MEDIA_STORAGE_DIR must be an absolute path').default('/opt/skillhub/data/media'),
  STORAGE_DEFAULT: z.enum(['filesystem', 's3']).default('filesystem'),
  S3_ENDPOINT: z.preprocess(value => value === '' ? undefined : value, z.string().transform((value, context) => {
    try { return normalizeS3Endpoint(value) } catch {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'S3_ENDPOINT requires HTTPS, or HTTP on loopback / a trusted Compose service name; no path, credentials, query or fragment' })
      return z.NEVER
    }
  }).optional()),
  S3_REGION: z.preprocess(value => value === '' ? undefined : value, z.string().regex(/^[a-z0-9-]+$/).optional()),
  S3_BUCKET: z.preprocess(value => value === '' ? undefined : value, z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/).optional()),
  S3_PREFIX: z.string().refine(value => {
    try { if (value) assertObjectStorageKey(value); return true } catch { return false }
  }, 'S3_PREFIX must be a relative object key without trailing slash').default(''),
  S3_ACCESS_KEY_ID: z.preprocess(value => value === '' ? undefined : value, z.string().min(1).optional()),
  S3_SECRET_ACCESS_KEY: z.preprocess(value => value === '' ? undefined : value, z.string().min(1).optional()),
  S3_FORCE_PATH_STYLE: envBoolean.default(false),
  LIBRARY_CARD_UPLOADS_PER_HOUR: z.coerce.number().int().min(1).max(10_000).default(240),
  LIBRARY_CARD_DOWNLOADS_PER_MINUTE: z.coerce.number().int().min(1).max(10_000).default(120),
  MARKETPLACE_DOWNLOADS_PER_MINUTE: z.coerce.number().int().min(1).max(1_000).default(60),
  PORT: z.coerce.number().default(3001),
  HOST: z.string().ip({ version: 'v4' }).default('127.0.0.1'),
  TRUSTED_PROXIES: trustedProxies.default('127.0.0.1'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  SKILLHUB_PROFILE: z.enum(['selfhost', 'yitan-official']).optional(),
  PUBLIC_BASE_URL: publicBaseUrlSchema.optional(),
  AVATAR_STYLE_ORIGIN: publicBaseUrlSchema.default('https://bill-api.whatonearth.work/skillhub'),
  CATALOG_ORIGIN: publicBaseUrlSchema.default('https://bill-api.whatonearth.work/skillhub'),
  INSTANCE_ADDITIONAL_BASE_URLS: z.string()
    .transform((value) => value.trim() === '' ? [] : value.split(',').map((entry) => entry.trim()))
    .pipe(z.array(publicBaseUrlSchema))
    .refine((entries) => new Set(entries).size === entries.length, 'INSTANCE_ADDITIONAL_BASE_URLS must be unique')
    .default(''),
  CORS_ORIGIN: z.string().default('http://localhost:1420,tauri://localhost'),
  CREDENTIAL_KEK_BASE64: CredentialKekSchema.optional(),
  CREDENTIAL_KEK_VERSION: CredentialKekVersionSchema.default(1),
  CREDENTIAL_KEK_KEYRING_JSON: CredentialKekKeyringJsonSchema,
  CREDENTIAL_WRITES_PER_HOUR: z.coerce.number().int().min(1).max(1_000).default(30),
  RUNTIME_ENV_FETCHES_PER_MINUTE: z.coerce.number().int().min(1).max(1_000).default(60),
  CREDENTIAL_MAX_VALUE_BYTES: z.coerce.number().int().min(1).max(65_536).default(16_384),
  AI_API_BASE_URL: z.string().url().optional(),
  AI_API_KEY: z.string().optional(),
  AI_MODEL: z.string().default('kimi-k3'),
  AI_PROTOCOL: z.enum(['openai', 'anthropic', 'openai-responses']).default('openai-responses'),
  AI_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().max(60).default(6),
  AI_GLOBAL_DAILY_LIMIT: z.coerce.number().int().positive().max(100_000).default(200),
  AI_PER_USER_DAILY_LIMIT: z.coerce.number().int().positive().max(100_000).default(50),
  AI_MAX_CONCURRENT: z.coerce.number().int().positive().max(20).default(2),
  AI_MAX_TOKENS: z.coerce.number().int().min(512).max(8_192).default(4_096),
  AI_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(30_000),
}).transform((value, context) => {
  const s3Fields = ['S3_ENDPOINT', 'S3_REGION', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'] as const
  if (value.STORAGE_DEFAULT === 's3' || s3Fields.some(field => value[field] !== undefined)) {
    for (const field of s3Fields) {
      if (!value[field]) context.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: `${field} is required for S3 storage` })
    }
  }
  const profile = value.SKILLHUB_PROFILE ?? 'selfhost'
  const publicBaseUrl = value.PUBLIC_BASE_URL ?? 'http://127.0.0.1:3001'
  if (value.INSTANCE_ADDITIONAL_BASE_URLS.includes(publicBaseUrl)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['INSTANCE_ADDITIONAL_BASE_URLS'],
      message: 'INSTANCE_ADDITIONAL_BASE_URLS must not include PUBLIC_BASE_URL',
    })
  }
  const registrationMode = value.REGISTRATION_MODE ?? (profile === 'selfhost' ? 'invite' : 'open')
  if (value.NODE_ENV === 'production') {
    for (const field of ['SKILLHUB_PROFILE', 'PUBLIC_BASE_URL'] as const) {
      if (value[field] === undefined) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: `${field} must be set explicitly in production` })
      }
    }
  }
  if (value.SKILL_AVATARS_ENABLED && profile === 'yitan-official' && (!value.FAL_KEY || !value.PICEM_API_KEY || !value.AI_API_KEY || !value.AI_API_BASE_URL)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['SKILL_AVATARS_ENABLED'], message: 'FAL_KEY and configured AI are required for Skill avatars; yitan-official also requires PICEM_API_KEY' })
  }
  if (value.SKILL_AVATAR_GENERATE_CONCURRENCY > value.SKILL_AVATAR_WORKER_CONCURRENCY) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['SKILL_AVATAR_GENERATE_CONCURRENCY'], message: 'SKILL_AVATAR_GENERATE_CONCURRENCY cannot exceed SKILL_AVATAR_WORKER_CONCURRENCY' })
  }
  // Background avatar prompts must leave one AI slot for user requests (#238). With
  // AI_MAX_CONCURRENT = 1 the guard admits no background AI work at all (avatars wait), so
  // there is nothing to reject here.
  if (value.AI_MAX_CONCURRENT >= 2 && value.SKILL_AVATAR_GENERATE_CONCURRENCY > value.AI_MAX_CONCURRENT - 1) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['SKILL_AVATAR_GENERATE_CONCURRENCY'], message: 'SKILL_AVATAR_GENERATE_CONCURRENCY must leave one AI_MAX_CONCURRENT slot for user requests' })
  }
  if (value.AUTH_LOGIN_IP_ATTEMPTS_PER_15_MIN < value.AUTH_LOGIN_ATTEMPTS_PER_15_MIN) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['AUTH_LOGIN_IP_ATTEMPTS_PER_15_MIN'],
      message: 'The broad IP login limit must not be stricter than the account-and-IP limit',
    })
  }
  if (value.NODE_ENV === 'production' && value.SKILLHUB_PROFILE === 'yitan-official') {
    if (value.LOCAL_REGISTRATION_ENABLED) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['LOCAL_REGISTRATION_ENABLED'],
        message: 'Local registration must remain disabled in production',
      })
    }
    if (value.YITAN_OIDC_ISSUER !== YITAN_PRODUCTION_ISSUER) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['YITAN_OIDC_ISSUER'],
        message: `Production Yitan issuer must be ${YITAN_PRODUCTION_ISSUER}`,
      })
    }
    if (value.YITAN_OIDC_JWKS_URL !== YITAN_PRODUCTION_JWKS_URL) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['YITAN_OIDC_JWKS_URL'],
        message: `Production Yitan JWKS URL must be ${YITAN_PRODUCTION_JWKS_URL}`,
      })
    }
    if (value.YITAN_OIDC_AUDIENCE !== YITAN_PRODUCTION_AUDIENCE) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['YITAN_OIDC_AUDIENCE'],
        message: `Production Yitan audience must be ${YITAN_PRODUCTION_AUDIENCE}`,
      })
    }
    const productionClients = new Set<string>(YITAN_PRODUCTION_CLIENTS)
    if (
      value.YITAN_OIDC_ALLOWED_AZP.length !== productionClients.size
      || value.YITAN_OIDC_ALLOWED_AZP.some((clientId) => !productionClients.has(clientId))
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['YITAN_OIDC_ALLOWED_AZP'],
        message: 'Production Yitan clients must be exactly skillhub-desktop and skillhub-web',
      })
    }
    const productionLogoutAudiences = new Set<string>(YITAN_PRODUCTION_BACKCHANNEL_AUDIENCES)
    if (
      value.YITAN_OIDC_BACKCHANNEL_LOGOUT_AUDIENCE.length !== productionLogoutAudiences.size
      || value.YITAN_OIDC_BACKCHANNEL_LOGOUT_AUDIENCE.some(
        (audience) => !productionLogoutAudiences.has(audience)
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['YITAN_OIDC_BACKCHANNEL_LOGOUT_AUDIENCE'],
        message: 'Production Yitan logout audiences must be exactly skillhub-desktop and skillhub-web',
      })
    }
    if (value.YITAN_WEB_CLIENT_ID !== YITAN_WEB_CLIENT_ID) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['YITAN_WEB_CLIENT_ID'],
        message: `Production Yitan web client must be ${YITAN_WEB_CLIENT_ID}`,
      })
    }
    if (value.AUTH_MODE !== 'legacy' && !value.YITAN_WEB_CLIENT_SECRET) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['YITAN_WEB_CLIENT_SECRET'],
        message: 'YITAN_WEB_CLIENT_SECRET is required when production Yitan authentication is enabled',
      })
    }
    if (value.YITAN_WEB_REDIRECT_URI !== YITAN_WEB_REDIRECT_URI) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['YITAN_WEB_REDIRECT_URI'],
        message: `Production Yitan web redirect must be ${YITAN_WEB_REDIRECT_URI}`,
      })
    }
    if (value.YITAN_WEB_POST_LOGOUT_REDIRECT_URI !== YITAN_WEB_POST_LOGOUT_REDIRECT_URI) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['YITAN_WEB_POST_LOGOUT_REDIRECT_URI'],
        message: `Production Yitan web post-logout redirect must be ${YITAN_WEB_POST_LOGOUT_REDIRECT_URI}`,
      })
    }
    if (value.YITAN_WEB_SUCCESS_URL !== YITAN_WEB_SUCCESS_URL) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['YITAN_WEB_SUCCESS_URL'],
        message: `Production Yitan web success URL must be ${YITAN_WEB_SUCCESS_URL}`,
      })
    }
  }
  if (value.NODE_ENV === 'production' && value.SKILLHUB_PROFILE === 'yitan-official' && value.YITAN_TEST_BACKCHANNEL_ENABLED) {
    if (
      value.YITAN_TEST_OIDC_ISSUER !== YITAN_TEST_ISSUER
      || value.YITAN_TEST_OIDC_JWKS_URL !== YITAN_TEST_JWKS_URL
      || value.YITAN_TEST_OIDC_BACKCHANNEL_LOGOUT_AUDIENCE.length !== YITAN_TEST_BACKCHANNEL_AUDIENCES.length
      || value.YITAN_TEST_OIDC_BACKCHANNEL_LOGOUT_AUDIENCE.some(
        (audience) => !YITAN_TEST_BACKCHANNEL_AUDIENCES.includes(
          audience as (typeof YITAN_TEST_BACKCHANNEL_AUDIENCES)[number]
        )
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['YITAN_TEST_BACKCHANNEL_ENABLED'],
        message: 'Production test backchannel must use the fixed Yitan test realm contract',
      })
    }
  }
  if (value.NODE_ENV === 'production' && !value.CREDENTIAL_KEK_BASE64) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['CREDENTIAL_KEK_BASE64'],
      message: 'CREDENTIAL_KEK_BASE64 is required in production',
    })
  }
  if (value.NODE_ENV === 'production' && value.CREDENTIAL_KEK_BASE64) {
    if (isLowEntropyCredentialKek(value.CREDENTIAL_KEK_BASE64)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['CREDENTIAL_KEK_BASE64'],
        message: 'CREDENTIAL_KEK_BASE64 must be a high-entropy random key, not a placeholder',
      })
    }
  }
  const historicalKekEntries = Object.entries(value.CREDENTIAL_KEK_KEYRING_JSON)
  if (historicalKekEntries.length > 0 && !value.CREDENTIAL_KEK_BASE64) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['CREDENTIAL_KEK_KEYRING_JSON'],
      message: 'CREDENTIAL_KEK_BASE64 is required when a historical KEK keyring is configured',
    })
  }
  if (Object.hasOwn(value.CREDENTIAL_KEK_KEYRING_JSON, String(value.CREDENTIAL_KEK_VERSION))) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['CREDENTIAL_KEK_KEYRING_JSON'],
      message: 'CREDENTIAL_KEK_KEYRING_JSON must not redefine the current KEK version',
    })
  }
  if (value.NODE_ENV === 'production') {
    for (const [version, encodedKey] of historicalKekEntries) {
      if (isLowEntropyCredentialKek(encodedKey)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['CREDENTIAL_KEK_KEYRING_JSON'],
          message: `CREDENTIAL_KEK_KEYRING_JSON version ${version} must be a high-entropy random key`,
        })
      }
    }
  }
  if (profile === 'yitan-official' && (
    (registrationMode === 'invite' && !value.REGISTRATION_INVITE_CODE)
    || value.REGISTRATION_INVITE_CODE === ''
  )) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['REGISTRATION_INVITE_CODE'],
      message: 'REGISTRATION_INVITE_CODE is required when invitation mode is enabled',
    })
  }
  if (
    value.NODE_ENV === 'production'
    && registrationMode === 'invite'
    && value.REGISTRATION_INVITE_CODE
    && value.REGISTRATION_INVITE_CODE.length < 16
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['REGISTRATION_INVITE_CODE'],
      message: 'REGISTRATION_INVITE_CODE must be at least 16 chars in production',
    })
  }
  if (value.NODE_ENV === 'production' && value.JWT_SECRET.length < 32) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['JWT_SECRET'], message: 'JWT_SECRET must be at least 32 chars in production' })
  }
  if (value.NODE_ENV === 'production' && value.AI_API_BASE_URL && !value.AI_API_BASE_URL.startsWith('https://')) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['AI_API_BASE_URL'],
      message: 'AI_API_BASE_URL must use HTTPS in production',
    })
  }
  return {
    ...value,
    SKILLHUB_PROFILE: profile,
    SKILL_AVATAR_MODEL_READS: value.SKILL_AVATAR_MODEL_READS ?? (profile === 'selfhost' ? 'variants' : 'legacy'),
    REGISTRATION_MODE: registrationMode,
    REGISTRATION_ENV_OVERRIDE: value.REGISTRATION_MODE !== undefined || Boolean(value.REGISTRATION_INVITE_CODE),
    PUBLIC_BASE_URL: publicBaseUrl,
  }
})

export type Config = z.infer<typeof configSchema>
