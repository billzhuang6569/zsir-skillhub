import { Prisma, type ServerSetting } from '@prisma/client'
import { z } from 'zod'
import { config } from '../config.js'
import { db } from '../db.js'
import {
  decodeCredentialKekKeyring, decryptInstanceSecret, destroyCredentialKekKeyring,
  encryptInstanceSecret, type EncryptedCredentialPayload,
} from './credential-crypto.js'

export const SERVER_SETTING_DEFINITIONS = {
  ai: {
    value: z.object({
      protocol: z.enum(['openai', 'anthropic', 'openai-responses']),
      baseUrl: z.string().url(),
      model: z.string().min(1).max(200),
      lastTest: z.object({ ok: z.boolean(), at: z.string().datetime(), latencyMs: z.number().nonnegative() }).nullable().optional(),
    }).strict(),
    secret: true,
  },
  fal: { value: z.object({ lastTest: z.object({ ok: z.boolean(), at: z.string().datetime() }).optional() }).strict(), secret: true },
  'avatar.style': { value: z.object({ styleId: z.string().min(1).max(100) }).strict(), secret: false },
  'ai.policy': { value: z.object({
    limits: z.object({ instanceDaily: z.number().int().min(0).max(100_000), perUserDaily: z.number().int().min(0).max(100_000) }).strict(),
    allowedPrivateHosts: z.array(z.string().min(1).max(253)).max(100),
  }).strict(), secret: false },
  registration: { value: z.object({ mode: z.enum(['open', 'invite', 'closed']) }).strict(), secret: true },
} as const

export type ServerSettingKey = keyof typeof SERVER_SETTING_DEFINITIONS
export const SERVER_SETTING_KEYS = Object.keys(SERVER_SETTING_DEFINITIONS) as ServerSettingKey[]
const SettingWrite = z.object({
  value: z.record(z.unknown()).optional(),
  secret: z.string().min(1).max(1024).nullable().optional(),
}).strict().refine((body) => body.value !== undefined || body.secret !== undefined)

let cache = new Map<ServerSettingKey, ServerSetting>()
let refresh: Promise<void> = Promise.resolve()

async function serializeSettings(operation: () => Promise<void>): Promise<void> {
  const next = refresh.then(operation)
  refresh = next.catch(() => {})
  await next
}

export function isServerSettingKey(key: string): key is ServerSettingKey {
  return Object.hasOwn(SERVER_SETTING_DEFINITIONS, key)
}

export async function loadServerSettings(): Promise<void> {
  // Serialize reads so an older snapshot cannot overwrite a newer cache refresh.
  await serializeSettings(async (): Promise<void> => {
    const rows = await db.serverSetting.findMany({ where: { key: { in: SERVER_SETTING_KEYS } } })
    cache = new Map(rows.flatMap((row) => isServerSettingKey(row.key) ? [[row.key, row]] : []))
  })
}

export function effectiveSource(key: ServerSettingKey): 'env' | 'setting' | 'none' {
  if (key === 'ai' && config.AI_API_BASE_URL && config.AI_API_KEY) return 'env'
  if (key === 'fal' && config.FAL_KEY) return 'env'
  if (key === 'registration' && (config.REGISTRATION_ENV_OVERRIDE || config.REGISTRATION_INVITE_CODE)) return 'env'
  return cache.has(key) ? 'setting' : 'none'
}

export function getSettingValue<K extends ServerSettingKey>(key: K): z.infer<(typeof SERVER_SETTING_DEFINITIONS)[K]['value']> | null {
  const source = effectiveSource(key)
  const value = key === 'ai' && source === 'env'
    ? { protocol: config.AI_PROTOCOL, baseUrl: config.AI_API_BASE_URL, model: config.AI_MODEL }
    : key === 'fal' && source === 'env' ? {} : key === 'registration' && source === 'env'
      ? { mode: config.REGISTRATION_MODE } : cache.get(key)?.value
  // Environment values have already passed configSchema, which retains its existing limits.
  if (source === 'env') return value as z.infer<(typeof SERVER_SETTING_DEFINITIONS)[K]['value']>
  const parsed = SERVER_SETTING_DEFINITIONS[key].value.safeParse(value)
  return parsed.success ? parsed.data as z.infer<(typeof SERVER_SETTING_DEFINITIONS)[K]['value']> : null
}

function secretPayload(row: ServerSetting | undefined): EncryptedCredentialPayload | null {
  if (!row?.secretCiphertext || !row.secretIv || !row.secretTag || !row.secretWrappedDek
    || !row.secretWrapIv || !row.secretWrapTag || row.secretKekVersion === null || row.secretAadVersion === null) return null
  return {
    ciphertext: row.secretCiphertext, iv: row.secretIv, tag: row.secretTag,
    wrappedDek: row.secretWrappedDek, wrapIv: row.secretWrapIv, wrapTag: row.secretWrapTag,
    kekVersion: row.secretKekVersion, aadVersion: row.secretAadVersion,
  }
}

export function hasSettingSecret(key: ServerSettingKey): boolean {
  return SERVER_SETTING_DEFINITIONS[key].secret && (effectiveSource(key) === 'env' || secretPayload(cache.get(key)) !== null)
}

function settingKeyring(): Map<number, Buffer> {
  if (!config.CREDENTIAL_KEK_BASE64) throw new Error('Server setting secrets require CREDENTIAL_KEK_BASE64')
  return decodeCredentialKekKeyring(config.CREDENTIAL_KEK_BASE64, config.CREDENTIAL_KEK_VERSION, config.CREDENTIAL_KEK_KEYRING_JSON)
}

export async function getSettingSecret(key: ServerSettingKey): Promise<string | null> {
  if (effectiveSource(key) === 'env') return key === 'ai' ? config.AI_API_KEY! : key === 'registration' ? config.REGISTRATION_INVITE_CODE ?? null : config.FAL_KEY!
  const payload = secretPayload(cache.get(key))
  if (!payload || !SERVER_SETTING_DEFINITIONS[key].secret) return null
  const keyring = settingKeyring()
  try {
    const plaintext = decryptInstanceSecret(payload, { name: `server-setting:${key}` }, keyring)
    try { return plaintext.toString('utf8') }
    finally { plaintext.fill(0) }
  } finally { destroyCredentialKekKeyring(keyring) }
}

export function maskedSetting(key: ServerSettingKey): {
  key: ServerSettingKey; value: Prisma.JsonValue; secret?: { set: boolean; mask: string | null }
  version: number; updatedAt: string | null; source: 'env' | 'setting' | 'none'
} {
  const row = cache.get(key)
  const set = secretPayload(row) !== null
  return {
    key, value: row?.value ?? null,
    ...(SERVER_SETTING_DEFINITIONS[key].secret ? { secret: { set, mask: set ? `••••${row?.secretLast4 ?? ''}` : null } } : {}),
    version: row?.version ?? 0, updatedAt: row?.updatedAt.toISOString() ?? null, source: effectiveSource(key),
  }
}

export function parseSettingWrite(key: ServerSettingKey, input: unknown): z.infer<typeof SettingWrite> {
  const body = SettingWrite.parse(input)
  if (body.value !== undefined) body.value = SERVER_SETTING_DEFINITIONS[key].value.parse(body.value)
  if (body.secret !== undefined && !SERVER_SETTING_DEFINITIONS[key].secret) {
    throw new z.ZodError([{ code: 'custom', path: ['secret'], message: 'This setting does not allow a secret' }])
  }
  return body
}

export async function writeServerSetting(key: ServerSettingKey, input: unknown, updatedById: string): Promise<void> {
  const body = parseSettingWrite(key, input)
  if (config.SKILL_AVATAR_MODEL_READS === 'variants' && key === 'avatar.style' && body.value !== undefined) {
    const { latestAvatarStyle } = await import('./avatar-styles.js')
    const value = SERVER_SETTING_DEFINITIONS['avatar.style'].value.parse(body.value)
    if (!await latestAvatarStyle(value.styleId)) throw new z.ZodError([{ code: 'custom', path: ['value', 'styleId'], message: 'Avatar style unavailable' }])
  }
  let secretFields: Partial<Pick<ServerSetting,
    'secretCiphertext' | 'secretIv' | 'secretTag' | 'secretWrappedDek' | 'secretWrapIv'
    | 'secretWrapTag' | 'secretKekVersion' | 'secretAadVersion' | 'secretLast4'>> = {}
  if (body.secret === null) {
    secretFields = {
      secretCiphertext: null, secretIv: null, secretTag: null, secretWrappedDek: null,
      secretWrapIv: null, secretWrapTag: null, secretKekVersion: null, secretAadVersion: null, secretLast4: null,
    }
  } else if (body.secret !== undefined) {
    const keyring = settingKeyring()
    const plaintext = Buffer.from(body.secret, 'utf8')
    try {
      const kek = keyring.get(config.CREDENTIAL_KEK_VERSION)
      if (!kek) throw new Error('Server setting KEK is unavailable')
      const encrypted = encryptInstanceSecret(plaintext, { name: `server-setting:${key}` }, kek, config.CREDENTIAL_KEK_VERSION)
      secretFields = {
        secretCiphertext: encrypted.ciphertext, secretIv: encrypted.iv, secretTag: encrypted.tag,
        secretWrappedDek: encrypted.wrappedDek, secretWrapIv: encrypted.wrapIv, secretWrapTag: encrypted.wrapTag,
        secretKekVersion: encrypted.kekVersion, secretAadVersion: encrypted.aadVersion,
        secretLast4: Array.from(body.secret).length > 4 ? Array.from(body.secret).slice(-4).join('') : '',
      }
    } finally {
      plaintext.fill(0)
      destroyCredentialKekKeyring(keyring)
    }
  }
  const value = body.value as Prisma.InputJsonObject | undefined
  await serializeSettings(async (): Promise<void> => {
    // A single SQL upsert atomically replaces both value and envelope. Publish its
    // returned row, so a subsequent read outage cannot turn a committed save into failure.
    const row = await db.serverSetting.upsert({
      where: { key },
      create: { key, value: value ?? Prisma.JsonNull, updatedById, ...secretFields },
      update: { updatedById, ...(value === undefined ? {} : { value }), ...secretFields, version: { increment: 1 } },
    })
    cache.set(key, row)
  })
}

export async function deleteServerSetting(key: ServerSettingKey): Promise<void> {
  await serializeSettings(async (): Promise<void> => {
    await db.serverSetting.deleteMany({ where: { key } })
    cache.delete(key)
  })
}
