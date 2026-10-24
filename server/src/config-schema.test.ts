import { describe, expect, it } from 'vitest'
import Fastify from 'fastify'
import { configSchema } from './config-schema.js'

const productionCredentialKek = Buffer.from(Array.from({ length: 32 }, (_value, index) => index + 1)).toString('base64')
const historicalCredentialKek = Buffer.from(Array.from({ length: 32 }, (_value, index) => index + 33)).toString('base64')
const placeholderCredentialKek = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='

const baseEnvironment = {
  DATABASE_URL: 'postgresql://localhost/skillhub_test',
  JWT_SECRET: 'test-secret-longer-than-sixteen-characters',
  CREDENTIAL_KEK_BASE64: productionCredentialKek,
}

const productionEnvironment = {
  ...baseEnvironment,
  NODE_ENV: 'production',
  SKILLHUB_PROFILE: 'yitan-official',
  PUBLIC_BASE_URL: 'https://bill-api.whatonearth.work/skillhub',
  LOCAL_REGISTRATION_ENABLED: 'false',
}

describe('server config schema', () => {
  it('defaults and bounds catalog token lifetime', () => {
    expect(configSchema.parse(baseEnvironment).CATALOG_TOKEN_TTL_DAYS).toBe(30)
    for (const value of ['1', '90']) expect(configSchema.parse({ ...baseEnvironment, CATALOG_TOKEN_TTL_DAYS: value }).CATALOG_TOKEN_TTL_DAYS).toBe(Number(value))
    for (const value of ['0', '91', '1.5', '', 'invalid']) expect(configSchema.safeParse({ ...baseEnvironment, CATALOG_TOKEN_TTL_DAYS: value }).success).toBe(false)
  })
  it('defaults and bounds the independent migration write budget', () => {
    expect(configSchema.parse(baseEnvironment).MIGRATION_WRITES_PER_HOUR).toBe(1200)
    for (const value of ['1', '100000']) {
      expect(configSchema.parse({ ...baseEnvironment, MIGRATION_WRITES_PER_HOUR: value }).MIGRATION_WRITES_PER_HOUR).toBe(Number(value))
    }
    for (const value of ['0', '-1', '100001', '1.5', 'invalid', '']) {
      expect(configSchema.safeParse({ ...baseEnvironment, MIGRATION_WRITES_PER_HOUR: value }).success).toBe(false)
    }
  })
  it('defaults only selfhost to variants and preserves an explicit read mode', () => {
    expect(configSchema.parse(baseEnvironment).SKILL_AVATAR_MODEL_READS).toBe('variants')
    expect(configSchema.parse({ ...baseEnvironment, SKILLHUB_PROFILE: 'yitan-official' }).SKILL_AVATAR_MODEL_READS).toBe('legacy')
    for (const SKILLHUB_PROFILE of ['selfhost', 'yitan-official']) {
      for (const SKILL_AVATAR_MODEL_READS of ['legacy', 'variants']) {
        expect(configSchema.parse({ ...baseEnvironment, SKILLHUB_PROFILE, SKILL_AVATAR_MODEL_READS }).SKILL_AVATAR_MODEL_READS).toBe(SKILL_AVATAR_MODEL_READS)
      }
    }
  })
  it('defaults trusted proxies to the existing loopback nginx and parses IP/CIDR lists', async (): Promise<void> => {
    expect(configSchema.parse(baseEnvironment).TRUSTED_PROXIES).toEqual(['127.0.0.1'])
    expect(configSchema.parse(productionEnvironment).TRUSTED_PROXIES).toEqual(['127.0.0.1'])
    expect(configSchema.parse({
      ...baseEnvironment,
      TRUSTED_PROXIES: ' 127.0.0.1, 172.30.41.0/24, ::1, fd00::/64, ::ffff:192.0.2.1/128 ',
    }).TRUSTED_PROXIES).toEqual(['127.0.0.1', '172.30.41.0/24', '::1', 'fd00::/64', '::ffff:192.0.2.1/128'])
    const config = configSchema.parse({ ...baseEnvironment, TRUSTED_PROXIES: '192.0.2.1/32,2001:db8::1/128,0.0.0.0/1,::/1' })
    await Fastify({ trustProxy: config.TRUSTED_PROXIES }).close()
  })

  it.each([
    '', ' ', 'localhost', 'true', '*', '999.0.0.1', '127.1', '01.2.3.4', '[::1]', '::::',
    '127.0.0.1:3001', '127.0.0.1/33', '::1/129', '127.0.0.1/-1', '::1/1.5',
    '127.0.0.1/', '127.0.0.1/24/1', '127.0.0.1/abc', '127.0.0.1/024',
    '127.0.0.1,', ',::1', '127.0.0.1,,::1', '127.0.0.1,invalid', 'fe80::1%eth0', '0.0.0.0/0', '::/0',
  ])('rejects invalid trusted proxy entries: %s', (TRUSTED_PROXIES) => {
    const result = configSchema.safeParse({ ...baseEnvironment, TRUSTED_PROXIES })
    expect(result.success).toBe(false)
    if (!result.success) expect(result.error.flatten().fieldErrors.TRUSTED_PROXIES).toBeDefined()
  })

  it.each([
    [undefined, '127.0.0.1', true], [undefined, '172.30.41.1', false],
    ['172.30.41.0/24', '172.30.41.1', true], ['172.30.41.0/24', '172.30.41.3', true],
    ['172.30.41.0/24', '::ffff:172.30.41.1', true], ['172.30.41.0/24', '172.30.42.1', false],
    ['fd00::/64', 'fd00::1', true], ['fd00::/64', 'fd01::1', false],
  ] as const)('uses forwarded client IPs only for trusted peers (%s, %s)', async (TRUSTED_PROXIES, remoteAddress, trusted) => {
    const config = configSchema.parse({ ...baseEnvironment, TRUSTED_PROXIES })
    const app = Fastify({ trustProxy: config.TRUSTED_PROXIES })
    app.get('/', async (request): Promise<{ ip: string; protocol: string }> => ({ ip: request.ip, protocol: request.protocol }))
    try {
      for (const client of ['198.51.100.10', '198.51.100.11']) {
        const response = await app.inject({
          method: 'GET', url: '/', remoteAddress,
          headers: { 'x-forwarded-for': `203.0.113.99, ${client}`, 'x-forwarded-proto': 'https' },
        })
        expect(response.json()).toEqual({ ip: trusted ? client : remoteAddress, protocol: trusted ? 'https' : 'http' })
      }
    } finally {
      await app.close()
    }
  })

  it.each(['AVATAR_STYLE_ORIGIN', 'CATALOG_ORIGIN'] as const)('defaults and normalizes %s using the public URL rules', (field) => {
    expect(configSchema.parse(baseEnvironment)[field]).toBe('https://bill-api.whatonearth.work/skillhub')
    for (const [input, expected] of [
      ['https://STYLES.example.test:443/Instance///', 'https://styles.example.test/Instance'],
      ['http://localhost:3001/', 'http://localhost:3001'],
      ['http://127.0.0.2:3001/', 'http://127.0.0.2:3001'],
      ['http://[::1]:3001/', 'http://[::1]:3001'],
    ]) expect(configSchema.parse({ ...baseEnvironment, [field]: input })[field]).toBe(expected)
  })

  it.each([
    '', 'not-a-url', 'http://styles.example.test', 'http://192.168.1.1:3001', 'ftp://localhost',
    'https://styles.example.test/?key=x', 'https://styles.example.test/#fragment',
    'https://styles.example.test/?', 'https://styles.example.test/#',
    'https://user:password@styles.example.test', 'https://@styles.example.test',
  ])('rejects an unsafe avatar style origin: %s', (AVATAR_STYLE_ORIGIN) => {
    const parsed = configSchema.safeParse({ ...baseEnvironment, AVATAR_STYLE_ORIGIN })
    expect(parsed.success).toBe(false)
    if (!parsed.success) expect(parsed.error.flatten().fieldErrors.AVATAR_STYLE_ORIGIN).toBeDefined()
    const catalog = configSchema.safeParse({ ...baseEnvironment, CATALOG_ORIGIN: AVATAR_STYLE_ORIGIN })
    expect(catalog.success).toBe(false)
    if (!catalog.success) expect(catalog.error.flatten().fieldErrors.CATALOG_ORIGIN).toBeDefined()
  })

  it('accepts only strict SemVer for an optional minimum client version', () => {
    expect(configSchema.parse(baseEnvironment).MIN_CLIENT_VERSION).toBeUndefined()
    expect(configSchema.parse({ ...baseEnvironment, MIN_CLIENT_VERSION: '' }).MIN_CLIENT_VERSION).toBeUndefined()
    for (const version of ['1.2.3', '0.32.0-rc.1+build.01']) {
      expect(configSchema.parse({ ...baseEnvironment, MIN_CLIENT_VERSION: version }).MIN_CLIENT_VERSION).toBe(version)
    }
    for (const version of ['v1.2.3', '1.2', '01.2.3', '1.2.3-01', '1.2.3-a..b', '1.2.3+', ' 1.2.3']) {
      expect(configSchema.safeParse({ ...baseEnvironment, MIN_CLIENT_VERSION: version }).success).toBe(false)
    }
  })
  it('normalizes additional instance URLs without lowercasing their paths', () => {
    expect(configSchema.parse(baseEnvironment).INSTANCE_ADDITIONAL_BASE_URLS).toEqual([])
    expect(configSchema.parse({ ...baseEnvironment, INSTANCE_ADDITIONAL_BASE_URLS: '' }).INSTANCE_ADDITIONAL_BASE_URLS).toEqual([])
    expect(configSchema.parse({
      ...baseEnvironment,
      INSTANCE_ADDITIONAL_BASE_URLS: ' https://SKILLS.example.com:443/Case///, http://localhost:3001/ , http://[::1]:3001/',
    }).INSTANCE_ADDITIONAL_BASE_URLS).toEqual(['https://skills.example.com/Case', 'http://localhost:3001', 'http://[::1]:3001'])
  })

  it.each([
    'https://skills.example.com,https://SKILLS.example.com:443/',
    'http://127.0.0.1:3001/',
    'http://skills.example.com', 'http://192.168.1.1:3001',
    'https://skills.example.com/?q=1', 'https://skills.example.com/#fragment',
    'https://skills.example.com/?', 'https://skills.example.com/#',
    'https://user:password@skills.example.com', 'https://@skills.example.com',
    'ftp://localhost', 'not-a-url', 'https://skills.example.com,',
  ])('rejects unsafe or duplicate additional base URLs: %s', (INSTANCE_ADDITIONAL_BASE_URLS) => {
    expect(configSchema.safeParse({ ...baseEnvironment, INSTANCE_ADDITIONAL_BASE_URLS }).success).toBe(false)
  })

  it('rejects an additional URL equal to the explicit normalized public URL', () => {
    expect(configSchema.safeParse({
      ...productionEnvironment,
      PUBLIC_BASE_URL: 'https://skills.example.com:443/instance///',
      INSTANCE_ADDITIONAL_BASE_URLS: 'https://skills.example.com/instance/',
    }).success).toBe(false)
  })

  it('defaults only non-production deployments to selfhost and loopback', () => {
    for (const NODE_ENV of ['development', 'test']) {
      expect(configSchema.parse({ ...baseEnvironment, NODE_ENV })).toMatchObject({
        SKILLHUB_PROFILE: 'selfhost', PUBLIC_BASE_URL: 'http://127.0.0.1:3001',
      })
    }
    for (const field of ['SKILLHUB_PROFILE', 'PUBLIC_BASE_URL'] as const) {
      const result = configSchema.safeParse({ ...productionEnvironment, [field]: undefined })
      expect(result.success).toBe(false)
      if (!result.success) expect(result.error.flatten().fieldErrors[field]).toContain(`${field} must be set explicitly in production`)
    }
    expect(configSchema.safeParse({ ...baseEnvironment, SKILLHUB_PROFILE: 'official' }).success).toBe(false)
  })

  it.each([
    ['http://127.0.0.1:3001', 'http://127.0.0.1:3001'],
    ['http://127.42.0.5:3001/', 'http://127.42.0.5:3001'],
    ['http://localhost:3001', 'http://localhost:3001'],
    ['http://[::1]:3001', 'http://[::1]:3001'],
    ['https://localhost:3001/', 'https://localhost:3001'],
    ['https://skills.example.com/', 'https://skills.example.com'],
    ['https://bill-api.whatonearth.work/skillhub///', 'https://bill-api.whatonearth.work/skillhub'],
  ])('accepts and normalizes public base URL %s in every environment', (PUBLIC_BASE_URL, expected) => {
    for (const NODE_ENV of ['development', 'test', 'production']) {
      expect(configSchema.parse({ ...productionEnvironment, NODE_ENV, PUBLIC_BASE_URL }).PUBLIC_BASE_URL).toBe(expected)
    }
  })

  it.each([
    'http://skills.example.com', 'http://192.168.1.10:3001', 'http://localhost.example.com',
    'https://skills.example.com/?q=1', 'https://skills.example.com/#fragment',
    'https://skills.example.com/?', 'https://skills.example.com/#',
    'https://user:password@skills.example.com', 'https://user@skills.example.com',
    'https://@skills.example.com', 'ftp://localhost', 'not-a-url', '',
  ])('rejects unsafe public base URL %s in every environment', (PUBLIC_BASE_URL) => {
    for (const NODE_ENV of ['development', 'test', 'production']) {
      expect(configSchema.safeParse({ ...productionEnvironment, NODE_ENV, PUBLIC_BASE_URL }).success).toBe(false)
    }
  })

  it.each([
    ['LOCAL_REGISTRATION_ENABLED', 'true'],
    ['YITAN_OIDC_ISSUER', 'https://identity.example.com/realm'],
    ['YITAN_OIDC_JWKS_URL', 'https://identity.example.com/certs'],
    ['YITAN_OIDC_AUDIENCE', 'custom-api'],
    ['YITAN_OIDC_ALLOWED_AZP', 'custom-desktop,custom-web'],
    ['YITAN_OIDC_BACKCHANNEL_LOGOUT_AUDIENCE', 'custom-web'],
    ['YITAN_WEB_CLIENT_ID', 'custom-web'],
    ['YITAN_WEB_CLIENT_SECRET', undefined],
    ['YITAN_WEB_REDIRECT_URI', 'https://skills.example.com/callback'],
    ['YITAN_WEB_POST_LOGOUT_REDIRECT_URI', 'https://skills.example.com/logout'],
    ['YITAN_WEB_SUCCESS_URL', 'https://skills.example.com/admin'],
    ['YITAN_TEST_OIDC_ISSUER', 'https://identity.example.com/test'],
    ['YITAN_TEST_OIDC_JWKS_URL', 'https://identity.example.com/test/certs'],
    ['YITAN_TEST_OIDC_BACKCHANNEL_LOGOUT_AUDIENCE', 'custom-test'],
  ])('keeps the official production contract for %s without imposing it on selfhost', (field, value) => {
    const environment = {
      ...productionEnvironment, AUTH_MODE: 'yitan',
      YITAN_WEB_CLIENT_SECRET: 'test-only-web-client-secret', YITAN_TEST_BACKCHANNEL_ENABLED: 'true',
      [field]: value,
    }
    const official = configSchema.safeParse(environment)
    expect(official.success).toBe(false)
    if (!official.success) expect(official.error.issues.some((issue) => issue.path[0] === (
      field.startsWith('YITAN_TEST_') ? 'YITAN_TEST_BACKCHANNEL_ENABLED' : field
    ))).toBe(true)
    expect(configSchema.safeParse({ ...environment, SKILLHUB_PROFILE: 'selfhost' }).success).toBe(true)
  })

  it('keeps production KEK and keyring safeguards for selfhost', () => {
    const environment = { ...baseEnvironment, NODE_ENV: 'production', SKILLHUB_PROFILE: 'selfhost', PUBLIC_BASE_URL: 'http://127.0.0.1:3001' }
    expect(configSchema.safeParse(environment).success).toBe(true)
    for (const override of [
      { CREDENTIAL_KEK_BASE64: undefined }, { CREDENTIAL_KEK_BASE64: placeholderCredentialKek },
      { CREDENTIAL_KEK_KEYRING_JSON: JSON.stringify({ '2': placeholderCredentialKek }) },
      { CREDENTIAL_KEK_KEYRING_JSON: JSON.stringify({ '1': historicalCredentialKek }) },
      { PUBLIC_BASE_URL: undefined },
    ]) expect(configSchema.safeParse({ ...environment, ...override }).success).toBe(false)
  })

  it('allows only the Picem permanent host in topic articles unless configured otherwise', () => {
    expect(configSchema.parse(baseEnvironment).TOPIC_IMAGE_HOSTS).toEqual(['picem-media.whatonearth.work'])
    expect(configSchema.parse({ ...baseEnvironment, TOPIC_IMAGE_HOSTS: 'picem-media.whatonearth.work, Images.Example.com' }).TOPIC_IMAGE_HOSTS)
      .toEqual(['picem-media.whatonearth.work', 'images.example.com'])
    for (const invalid of ['', 'https://picem-media.whatonearth.work', 'host/path', 'a.com,a.com', 'localhost']) {
      expect(configSchema.safeParse({ ...baseEnvironment, TOPIC_IMAGE_HOSTS: invalid }).success, invalid).toBe(false)
    }
  })

  it('requires all backend providers before enabling generated avatars', () => {
    expect(configSchema.parse(baseEnvironment).SKILL_AVATARS_ENABLED).toBe(false)
    const enabled = { ...baseEnvironment, SKILLHUB_PROFILE: 'yitan-official', SKILL_AVATARS_ENABLED: 'true' }
    expect(configSchema.safeParse(enabled).success).toBe(false)
    expect(configSchema.safeParse({ ...enabled, FAL_KEY: 'server-only-test-fal-key', PICEM_API_KEY: 'server-only-test-picem-key-at-least-32-characters',
      AI_API_KEY: 'server-only-test-ai-key', AI_API_BASE_URL: 'https://provider.example.invalid/v1' }).success).toBe(true)
  })
  it('allows runtime setting providers for selfhost avatars and keeps official env requirements', () => {
    const enabled = { ...baseEnvironment, SKILLHUB_PROFILE: 'selfhost', SKILL_AVATARS_ENABLED: 'true',
      FAL_KEY: 'server-only-test-fal-key', AI_API_KEY: 'server-only-test-ai-key', AI_API_BASE_URL: 'https://provider.example.invalid/v1' }
    expect(configSchema.safeParse(enabled).success).toBe(true)
    expect(configSchema.safeParse({ ...enabled, SKILLHUB_PROFILE: 'yitan-official' }).success).toBe(false)
    for (const field of ['FAL_KEY', 'AI_API_KEY', 'AI_API_BASE_URL']) {
      expect(configSchema.safeParse({ ...enabled, [field]: undefined }).success, field).toBe(true)
    }
  })

  it('requires an absolute media root and defaults to the deployment media directory', () => {
    expect(configSchema.parse(baseEnvironment).MEDIA_STORAGE_DIR).toBe('/opt/skillhub/data/media')
    expect(configSchema.parse({ ...baseEnvironment, MEDIA_STORAGE_DIR: '/srv/media' }).MEDIA_STORAGE_DIR).toBe('/srv/media')
    for (const value of ['', '   ', 'relative/media']) {
      expect(configSchema.safeParse({ ...baseEnvironment, MEDIA_STORAGE_DIR: value }).success).toBe(false)
    }
  })

  it('bounds the avatar worker with conservative defaults that need no .env change (#235)', () => {
    const defaults = configSchema.parse(baseEnvironment)
    expect(defaults.SKILL_AVATAR_WORKER_CONCURRENCY).toBe(4)
    // #238: one generate slot by default, leaving AI_MAX_CONCURRENT's second slot (default 2) for users.
    expect(defaults.SKILL_AVATAR_GENERATE_CONCURRENCY).toBe(1)
    expect(defaults.AI_MAX_CONCURRENT).toBe(2)
    expect(configSchema.parse({ ...baseEnvironment, SKILL_AVATAR_WORKER_CONCURRENCY: '8', SKILL_AVATAR_GENERATE_CONCURRENCY: '3', AI_MAX_CONCURRENT: '4' }))
      .toMatchObject({ SKILL_AVATAR_WORKER_CONCURRENCY: 8, SKILL_AVATAR_GENERATE_CONCURRENCY: 3 })
    // Production's explicit override from the #235 incident stays valid.
    expect(configSchema.safeParse({ ...baseEnvironment, SKILL_AVATAR_GENERATE_CONCURRENCY: '1' }).success).toBe(true)
    // AI_MAX_CONCURRENT = 1: background AI work yields entirely at runtime, so no generate value is rejected for it.
    expect(configSchema.safeParse({ ...baseEnvironment, AI_MAX_CONCURRENT: '1', SKILL_AVATAR_GENERATE_CONCURRENCY: '1' }).success).toBe(true)
    for (const invalid of [{ SKILL_AVATAR_WORKER_CONCURRENCY: '0' }, { SKILL_AVATAR_WORKER_CONCURRENCY: '33' }, { SKILL_AVATAR_GENERATE_CONCURRENCY: '0' },
      { SKILL_AVATAR_WORKER_CONCURRENCY: '2', SKILL_AVATAR_GENERATE_CONCURRENCY: '3', AI_MAX_CONCURRENT: '8' }, { SKILL_AVATAR_WORKER_CONCURRENCY: 'many' },
      // Background could take every AI slot: the #235 incident's default combination.
      { SKILL_AVATAR_GENERATE_CONCURRENCY: '2' }, { AI_MAX_CONCURRENT: '3', SKILL_AVATAR_GENERATE_CONCURRENCY: '3' }]) {
      expect(configSchema.safeParse({ ...baseEnvironment, ...invalid }).success, JSON.stringify(invalid)).toBe(false)
    }
  })
  it.each(['selfhost', 'yitan-official'])('%s reserves a user AI slot with the default background-analysis configuration', SKILLHUB_PROFILE => {
    const defaults = configSchema.parse({ ...baseEnvironment, SKILLHUB_PROFILE })
    expect(defaults.AI_MAX_CONCURRENT).toBe(2)
    expect(defaults.SKILL_AVATAR_GENERATE_CONCURRENCY).toBeLessThan(defaults.AI_MAX_CONCURRENT)
    expect(configSchema.parse({ ...baseEnvironment, SKILLHUB_PROFILE, AI_MAX_CONCURRENT: '1' }).AI_MAX_CONCURRENT).toBe(1)
  })
  it('uses production-oriented defaults without an authentication bypass', () => {
    const result = configSchema.parse(baseEnvironment)
    expect(result.REGISTRATION_MODE).toBe('invite')
    expect(result.REGISTRATION_INVITE_CODE).toBeUndefined()
    expect(result).not.toHaveProperty('ENABLE_LEGACY_ENV_SHARES')
    expect(result).not.toHaveProperty('ENV_SHARE_SECRET')
    expect(result.JWT_EXPIRES_IN_SECONDS).toBe(604_800)
    expect(result.AUTH_MODE).toBe('legacy')
    expect(result.LOCAL_REGISTRATION_ENABLED).toBe(true)
    expect(result.AUTH_LEGACY_MIGRATION_ALLOWLIST).toEqual([])
    expect(result.AUTH_LEGACY_MIGRATION_SESSION_SECONDS).toBe(600)
    expect(result.YITAN_OIDC_AUDIENCE).toBe('skillhub-api')
    expect(result.YITAN_OIDC_ALLOWED_AZP).toEqual(['skillhub-desktop', 'skillhub-web'])
    expect(result.YITAN_OIDC_BACKCHANNEL_LOGOUT_AUDIENCE).toEqual(['skillhub-desktop', 'skillhub-web'])
    expect(result.AUTH_YITAN_BACKCHANNEL_ATTEMPTS_PER_MINUTE).toBe(300)
    expect(result.YITAN_TEST_BACKCHANNEL_ENABLED).toBe(false)
    expect(result.WEB_ADMIN_EMERGENCY_PASSWORD_LOGIN_ENABLED).toBe(false)
    expect(result.AUTH_LOGIN_ATTEMPTS_PER_15_MIN).toBe(10)
    expect(result.AUTH_LOGIN_IP_ATTEMPTS_PER_15_MIN).toBe(100)
    expect(result.SKILL_MAX_STORAGE_BYTES_PER_USER).toBe(250 * 1024 * 1024)
    expect(result.MARKETPLACE_DOWNLOADS_PER_MINUTE).toBe(60)
    expect(result.SKILL_CARD_STORAGE_DIR).toBe('/opt/skillhub/data/skill-cards')
    expect(result.LIBRARY_CARD_UPLOADS_PER_HOUR).toBe(240)
    expect(result.LIBRARY_CARD_DOWNLOADS_PER_MINUTE).toBe(120)
    expect(result.RUNTIME_ENV_FETCHES_PER_MINUTE).toBe(60)
    expect(result.AI_MAX_TOKENS).toBe(4_096)
  })

  it('accepts only local User UUIDs in the temporary migration allowlist', () => {
    const first = '11111111-1111-4111-8111-111111111111'
    const second = '22222222-2222-4222-8222-222222222222'
    expect(configSchema.parse({
      ...baseEnvironment,
      AUTH_LEGACY_MIGRATION_ALLOWLIST: ` ${first.toUpperCase()},${second} `,
    }).AUTH_LEGACY_MIGRATION_ALLOWLIST).toEqual([first, second])
    expect(configSchema.safeParse({
      ...baseEnvironment,
      AUTH_LEGACY_MIGRATION_ALLOWLIST: 'user@example.com',
    }).success).toBe(false)
    expect(configSchema.safeParse({
      ...baseEnvironment,
      AUTH_LEGACY_MIGRATION_ALLOWLIST: `${first},${first}`,
    }).success).toBe(false)
  })

  it('pins the production Yitan issuer, audiences, clients, callbacks, and web secret', () => {
    const yitanProduction = {
      ...productionEnvironment,
      AUTH_MODE: 'yitan',
      YITAN_WEB_CLIENT_SECRET: 'production-web-client-secret-value',
    }
    expect(configSchema.safeParse(yitanProduction).success).toBe(true)
    expect(configSchema.safeParse({
      ...yitanProduction,
      YITAN_OIDC_ISSUER: 'https://evil.example/realms/yitan',
    }).success).toBe(false)
    expect(configSchema.safeParse({
      ...yitanProduction,
      YITAN_OIDC_AUDIENCE: 'another-api',
    }).success).toBe(false)
    expect(configSchema.safeParse({
      ...yitanProduction,
      YITAN_OIDC_ALLOWED_AZP: 'skillhub-desktop,unapproved-client',
    }).success).toBe(false)
    expect(configSchema.safeParse({
      ...yitanProduction,
      YITAN_OIDC_BACKCHANNEL_LOGOUT_AUDIENCE: 'skillhub-web',
    }).success).toBe(false)
    expect(configSchema.safeParse({
      ...yitanProduction,
      YITAN_OIDC_BACKCHANNEL_LOGOUT_AUDIENCE: 'skillhub-web,skillhub-desktop',
    }).success).toBe(true)
    expect(configSchema.safeParse({
      ...yitanProduction,
      YITAN_OIDC_BACKCHANNEL_LOGOUT_AUDIENCE: 'skillhub-desktop,skillhub-desktop',
    }).success).toBe(false)
    const { YITAN_WEB_CLIENT_SECRET: _secret, ...missingSecret } = yitanProduction
    expect(configSchema.safeParse(missingSecret).success).toBe(false)
    expect(configSchema.safeParse({
      ...yitanProduction,
      YITAN_WEB_REDIRECT_URI: 'https://attacker.example/callback',
    }).success).toBe(false)
  })

  it('registers the isolated test backchannel only through an explicit boolean flag', () => {
    expect(configSchema.parse({
      ...baseEnvironment,
      YITAN_TEST_BACKCHANNEL_ENABLED: 'true',
    }).YITAN_TEST_BACKCHANNEL_ENABLED).toBe(true)
    expect(configSchema.safeParse({
      ...productionEnvironment,
      YITAN_TEST_BACKCHANNEL_ENABLED: 'true',
      YITAN_TEST_OIDC_ISSUER: 'https://evil.example/realms/yitan-test',
    }).success).toBe(false)
  })

  it('keeps guest Marketplace package downloads convenient but bounded', () => {
    expect(configSchema.parse({
      ...baseEnvironment,
      MARKETPLACE_DOWNLOADS_PER_MINUTE: '120',
    }).MARKETPLACE_DOWNLOADS_PER_MINUTE).toBe(120)
    expect(configSchema.safeParse({ ...baseEnvironment, MARKETPLACE_DOWNLOADS_PER_MINUTE: '0' }).success).toBe(false)
    expect(configSchema.safeParse({ ...baseEnvironment, MARKETPLACE_DOWNLOADS_PER_MINUTE: '1001' }).success).toBe(false)
  })

  it('requires a bounded explicit JWT lifetime', () => {
    expect(configSchema.parse({ ...baseEnvironment, JWT_EXPIRES_IN_SECONDS: '63072000' }).JWT_EXPIRES_IN_SECONDS).toBe(63072000)
    expect(configSchema.safeParse({ ...baseEnvironment, JWT_EXPIRES_IN_SECONDS: '63072001' }).success).toBe(false)
    expect(configSchema.parse({ ...baseEnvironment, JWT_EXPIRES_IN_SECONDS: '3600' }).JWT_EXPIRES_IN_SECONDS).toBe(3600)
    expect(configSchema.safeParse({ ...baseEnvironment, JWT_EXPIRES_IN_SECONDS: '60' }).success).toBe(false)
  })

  it('keeps the broad IP login budget at least as wide as the account budget', () => {
    expect(configSchema.safeParse({
      ...baseEnvironment,
      AUTH_LOGIN_ATTEMPTS_PER_15_MIN: '20',
      AUTH_LOGIN_IP_ATTEMPTS_PER_15_MIN: '10',
    }).success).toBe(false)
    expect(configSchema.safeParse({
      ...baseEnvironment,
      AUTH_LOGIN_ATTEMPTS_PER_15_MIN: '20',
      AUTH_LOGIN_IP_ATTEMPTS_PER_15_MIN: '200',
    }).success).toBe(true)
  })

  it('binds to loopback by default and requires a stronger production JWT secret', () => {
    expect(configSchema.parse(baseEnvironment).HOST).toBe('127.0.0.1')
    const weakProduction = configSchema.safeParse({
      ...productionEnvironment,
      JWT_SECRET: 'only-sixteen-chars',
    })
    expect(weakProduction.success).toBe(false)
  })

  it('defaults selfhost to closed invite registration while preserving official defaults', () => {
    for (const SKILLHUB_PROFILE of [undefined, 'selfhost']) {
      for (const REGISTRATION_INVITE_CODE of [undefined, '', '   ']) {
        expect(configSchema.parse({ ...baseEnvironment, SKILLHUB_PROFILE, REGISTRATION_INVITE_CODE }).REGISTRATION_MODE).toBe('invite')
      }
      expect(configSchema.parse({ ...baseEnvironment, SKILLHUB_PROFILE, REGISTRATION_MODE: 'open' }).REGISTRATION_MODE).toBe('open')
    }
    expect(configSchema.parse(productionEnvironment).REGISTRATION_MODE).toBe('open')
    expect(configSchema.safeParse({ ...productionEnvironment, REGISTRATION_INVITE_CODE: '' }).success).toBe(false)
    expect(configSchema.safeParse({ ...productionEnvironment, SKILLHUB_PROFILE: 'selfhost', REGISTRATION_INVITE_CODE: 'short' }).success).toBe(false)
  })

  it('requires an explicit strong code only when official invitation mode is enabled', () => {
    const missingInviteCode = configSchema.safeParse({
      ...productionEnvironment,
      REGISTRATION_MODE: 'invite',
    })
    expect(missingInviteCode.success).toBe(false)

    const shortInviteCode = configSchema.safeParse({
      ...productionEnvironment,
      REGISTRATION_MODE: 'invite',
      REGISTRATION_INVITE_CODE: 'too-short',
    })
    expect(shortInviteCode.success).toBe(false)

    const protectedProduction = configSchema.safeParse({
      ...productionEnvironment,
      REGISTRATION_MODE: 'invite',
      REGISTRATION_INVITE_CODE: '1234567890abcdef',
    })
    expect(protectedProduction.success).toBe(true)
  })

  it('keeps local registration closed independently during legacy-auth rollback', () => {
    const rollbackProduction = configSchema.safeParse({
      ...productionEnvironment,
      AUTH_MODE: 'legacy',
      REGISTRATION_MODE: 'open',
    })
    expect(rollbackProduction.success).toBe(true)
    if (rollbackProduction.success) {
      expect(rollbackProduction.data.LOCAL_REGISTRATION_ENABLED).toBe(false)
    }
    expect(configSchema.safeParse({
      ...productionEnvironment,
      LOCAL_REGISTRATION_ENABLED: 'true',
      AUTH_MODE: 'legacy',
    }).success).toBe(false)
  })

  it('ignores retired legacy environment sharing settings left in an old .env', () => {
    const result = configSchema.parse({
      ...baseEnvironment,
      ENABLE_LEGACY_ENV_SHARES: 'true',
      ENV_SHARE_SECRET: 'test-env-secret-at-least-thirty-two-characters',
    })
    expect(result).not.toHaveProperty('ENABLE_LEGACY_ENV_SHARES')
    expect(result).not.toHaveProperty('ENV_SHARE_SECRET')
  })

  it('requires a canonical 32-byte credential KEK in production', () => {
    const productionBase = {
      ...productionEnvironment,
      CREDENTIAL_KEK_BASE64: productionCredentialKek,
      REGISTRATION_MODE: 'invite',
      REGISTRATION_INVITE_CODE: '1234567890abcdef',
    }
    const { CREDENTIAL_KEK_BASE64: _credentialKek, ...missingKek } = productionBase

    expect(configSchema.safeParse(missingKek).success).toBe(false)
    expect(configSchema.safeParse({ ...productionBase, CREDENTIAL_KEK_BASE64: 'not-base64' }).success).toBe(false)
    expect(configSchema.safeParse({ ...productionBase, CREDENTIAL_KEK_BASE64: placeholderCredentialKek }).success).toBe(false)
    expect(configSchema.safeParse(productionBase).success).toBe(true)
  })

  it('strictly validates historical credential KEK keyring configuration', () => {
    const valid = configSchema.parse({
      ...baseEnvironment,
      CREDENTIAL_KEK_VERSION: '7',
      CREDENTIAL_KEK_KEYRING_JSON: JSON.stringify({ '6': historicalCredentialKek }),
    })
    expect(valid.CREDENTIAL_KEK_VERSION).toBe(7)
    expect(valid.CREDENTIAL_KEK_KEYRING_JSON).toEqual({ '6': historicalCredentialKek })

    expect(configSchema.safeParse({
      ...baseEnvironment,
      CREDENTIAL_KEK_KEYRING_JSON: '{invalid',
    }).success).toBe(false)
    expect(configSchema.safeParse({
      ...baseEnvironment,
      CREDENTIAL_KEK_KEYRING_JSON: '[]',
    }).success).toBe(false)
    expect(configSchema.safeParse({
      ...baseEnvironment,
      CREDENTIAL_KEK_KEYRING_JSON: JSON.stringify({ '01': historicalCredentialKek }),
    }).success).toBe(false)
    expect(configSchema.safeParse({
      ...baseEnvironment,
      CREDENTIAL_KEK_KEYRING_JSON: JSON.stringify({ '1000001': historicalCredentialKek }),
    }).success).toBe(false)
    expect(configSchema.safeParse({
      ...baseEnvironment,
      CREDENTIAL_KEK_KEYRING_JSON: `{"6":"${historicalCredentialKek}","6":"${productionCredentialKek}"}`,
    }).success).toBe(false)
    const malformedKey = 'this-is-not-key-material'
    const malformedResult = configSchema.safeParse({
      ...baseEnvironment,
      CREDENTIAL_KEK_KEYRING_JSON: JSON.stringify({ '2': malformedKey }),
    })
    expect(malformedResult.success).toBe(false)
    if (!malformedResult.success) {
      expect(JSON.stringify(malformedResult.error.flatten())).not.toContain(malformedKey)
    }
  })

  it('rejects ambiguous or weak KEK rotation configuration', () => {
    expect(configSchema.safeParse({
      ...baseEnvironment,
      CREDENTIAL_KEK_VERSION: '01',
    }).success).toBe(false)
    expect(configSchema.safeParse({
      ...baseEnvironment,
      CREDENTIAL_KEK_VERSION: '7',
      CREDENTIAL_KEK_KEYRING_JSON: JSON.stringify({ '7': historicalCredentialKek }),
    }).success).toBe(false)
    expect(configSchema.safeParse({
      ...productionEnvironment,
      REGISTRATION_MODE: 'invite',
      REGISTRATION_INVITE_CODE: '1234567890abcdef',
      CREDENTIAL_KEK_VERSION: '7',
      CREDENTIAL_KEK_KEYRING_JSON: JSON.stringify({ '6': placeholderCredentialKek }),
    }).success).toBe(false)
  })

  it('bounds stored Team environment values', () => {
    expect(configSchema.parse({
      ...baseEnvironment,
      CREDENTIAL_MAX_VALUE_BYTES: '16384',
    })).toMatchObject({
      CREDENTIAL_MAX_VALUE_BYTES: 16_384,
    })
    expect(configSchema.safeParse({ ...baseEnvironment, CREDENTIAL_MAX_VALUE_BYTES: '0' }).success).toBe(false)
    expect(configSchema.safeParse({ ...baseEnvironment, CREDENTIAL_MAX_VALUE_BYTES: '65537' }).success).toBe(false)
  })

  it('keeps runtime environment fetches convenient but bounded', () => {
    expect(configSchema.parse({
      ...baseEnvironment,
      RUNTIME_ENV_FETCHES_PER_MINUTE: '120',
    }).RUNTIME_ENV_FETCHES_PER_MINUTE).toBe(120)
    expect(configSchema.safeParse({ ...baseEnvironment, RUNTIME_ENV_FETCHES_PER_MINUTE: '0' }).success).toBe(false)
    expect(configSchema.safeParse({ ...baseEnvironment, RUNTIME_ENV_FETCHES_PER_MINUTE: '1001' }).success).toBe(false)
  })

  it('does not publish removed device-proof or intent controls', () => {
    const parsed = configSchema.parse({
      ...baseEnvironment,
      CREDENTIAL_REQUIRE_DEVICE_PROOF: 'false',
      CREDENTIAL_DEVICE_REGISTRATIONS_PER_15_MIN: '5',
      CREDENTIAL_FETCH_TTL_SECONDS: '60',
      CREDENTIAL_INTENTS_PER_15_MIN: '10',
      CREDENTIAL_CONSUMES_PER_MINUTE: '5',
    })
    expect(parsed).not.toHaveProperty('CREDENTIAL_REQUIRE_DEVICE_PROOF')
    expect(parsed).not.toHaveProperty('CREDENTIAL_DEVICE_REGISTRATIONS_PER_15_MIN')
    expect(parsed).not.toHaveProperty('CREDENTIAL_FETCH_TTL_SECONDS')
    expect(parsed).not.toHaveProperty('CREDENTIAL_INTENTS_PER_15_MIN')
    expect(parsed).not.toHaveProperty('CREDENTIAL_CONSUMES_PER_MINUTE')
  })

  it('allows enough bounded output tokens for reasoning-model Profile JSON', () => {
    expect(configSchema.parse({ ...baseEnvironment, AI_MAX_TOKENS: '4096' }).AI_MAX_TOKENS).toBe(4_096)
    expect(configSchema.safeParse({ ...baseEnvironment, AI_MAX_TOKENS: '128' }).success).toBe(false)
    expect(configSchema.safeParse({ ...baseEnvironment, AI_MAX_TOKENS: '16384' }).success).toBe(false)
  })
})
