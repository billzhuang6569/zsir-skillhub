import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'node:crypto'

const ALGORITHM = 'aes-256-gcm'
const IV_BYTES = 12
const TAG_BYTES = 16
const DEK_BYTES = 32
// AAD schema 2 binds a value to one team key: `(credentialId, teamId, envKey,
// revision)`. Schema 1 was the retired per-Skill binding scope and is only
// readable by the one-time team-credential migration (#254).
export const CREDENTIAL_AAD_VERSION = 2
export const LEGACY_BINDING_AAD_VERSION = 1
export const INSTANCE_SECRET_AAD_VERSION = 1

export type CredentialScope = {
  credentialId: string
  teamId: string
  envKey: string
  revision: number
}

/** Retired `(Skill, team, key)` binding scope; migration-only. */
export type LegacyBindingScope = {
  bindingId: string
  skillId: string
  teamId: string
  envKey: string
  revision: number
}

export type EncryptedCredentialPayload = {
  ciphertext: Buffer
  iv: Buffer
  tag: Buffer
  wrappedDek: Buffer
  wrapIv: Buffer
  wrapTag: Buffer
  kekVersion: number
  aadVersion: number
}

export type CredentialKekKeyring = ReadonlyMap<number, Buffer>

type AadContext = {
  aadVersion: number
  value: () => Buffer
  wrap: (kekVersion: number) => Buffer
}

function instanceSecretAad(scope: { name: string }): AadContext {
  return {
    aadVersion: INSTANCE_SECRET_AAD_VERSION,
    value: () => Buffer.from(JSON.stringify({
      schemaVersion: INSTANCE_SECRET_AAD_VERSION,
      purpose: 'instance-secret',
      name: scope.name,
    }), 'utf8'),
    wrap: (kekVersion) => Buffer.from(JSON.stringify({
      schemaVersion: INSTANCE_SECRET_AAD_VERSION,
      purpose: 'instance-secret-dek',
      kekVersion,
      name: scope.name,
    }), 'utf8'),
  }
}

function teamAad(scope: CredentialScope): AadContext {
  return {
    aadVersion: CREDENTIAL_AAD_VERSION,
    value: () => Buffer.from(JSON.stringify({
      schemaVersion: CREDENTIAL_AAD_VERSION,
      purpose: 'team-credential',
      credentialId: scope.credentialId,
      teamId: scope.teamId,
      envKey: scope.envKey,
      revision: scope.revision,
    }), 'utf8'),
    wrap: (kekVersion) => Buffer.from(JSON.stringify({
      schemaVersion: CREDENTIAL_AAD_VERSION,
      purpose: 'team-credential-dek',
      kekVersion,
      credentialId: scope.credentialId,
      teamId: scope.teamId,
      envKey: scope.envKey,
      revision: scope.revision,
    }), 'utf8'),
  }
}

function legacyBindingAad(scope: LegacyBindingScope): AadContext {
  return {
    aadVersion: LEGACY_BINDING_AAD_VERSION,
    value: () => Buffer.from(JSON.stringify({
      schemaVersion: LEGACY_BINDING_AAD_VERSION,
      bindingId: scope.bindingId,
      skillId: scope.skillId,
      teamId: scope.teamId,
      envKey: scope.envKey,
      revision: scope.revision,
    }), 'utf8'),
    wrap: (kekVersion) => Buffer.from(JSON.stringify({
      schemaVersion: LEGACY_BINDING_AAD_VERSION,
      purpose: 'credential-dek',
      kekVersion,
      bindingId: scope.bindingId,
      skillId: scope.skillId,
      teamId: scope.teamId,
      envKey: scope.envKey,
      revision: scope.revision,
    }), 'utf8'),
  }
}

function assertKey(key: Buffer, label: string): void {
  if (key.length !== DEK_BYTES) throw new Error(`${label} must be exactly 32 bytes`)
}

function assertKekVersion(kekVersion: number): void {
  if (!Number.isInteger(kekVersion) || kekVersion < 1 || kekVersion > 1_000_000) {
    throw new Error('Credential KEK version is invalid')
  }
}

function assertPayload(payload: EncryptedCredentialPayload, aadVersion: number): void {
  if (
    payload.aadVersion !== aadVersion
    || payload.iv.length !== IV_BYTES
    || payload.tag.length !== TAG_BYTES
    || payload.wrappedDek.length !== DEK_BYTES
    || payload.wrapIv.length !== IV_BYTES
    || payload.wrapTag.length !== TAG_BYTES
    || payload.ciphertext.length === 0
  ) {
    throw new Error('Invalid encrypted credential payload')
  }
}

export function decodeCredentialKek(encoded: string | undefined): Buffer {
  if (!encoded || !/^[A-Za-z0-9+/]{43}=$/.test(encoded)) {
    throw new Error('Credential encryption is not configured')
  }
  const key = Buffer.from(encoded, 'base64')
  assertKey(key, 'Credential KEK')
  return key
}

export function decodeCredentialKekKeyring(
  currentEncodedKek: string | undefined,
  currentKekVersion: number,
  historicalEncodedKeks: Readonly<Record<string, string>> = {}
): Map<number, Buffer> {
  assertKekVersion(currentKekVersion)
  const keyring = new Map<number, Buffer>()
  try {
    keyring.set(currentKekVersion, decodeCredentialKek(currentEncodedKek))
    for (const [encodedVersion, encodedKek] of Object.entries(historicalEncodedKeks)) {
      if (!/^[1-9][0-9]*$/.test(encodedVersion)) {
        throw new Error('Credential KEK keyring contains an invalid version')
      }
      const kekVersion = Number(encodedVersion)
      assertKekVersion(kekVersion)
      if (keyring.has(kekVersion)) {
        throw new Error('Credential KEK keyring contains a duplicate version')
      }
      keyring.set(kekVersion, decodeCredentialKek(encodedKek))
    }
    return keyring
  } catch (error) {
    destroyCredentialKekKeyring(keyring)
    throw error
  }
}

export function destroyCredentialKekKeyring(keyring: Map<number, Buffer>): void {
  for (const key of keyring.values()) key.fill(0)
  keyring.clear()
}

function credentialKekForVersion(keyring: CredentialKekKeyring, kekVersion: number): Buffer {
  assertKekVersion(kekVersion)
  const kek = keyring.get(kekVersion)
  if (!kek) throw new Error('Credential KEK version is unavailable')
  assertKey(kek, 'Credential KEK')
  return kek
}

function unwrapCredentialDek(
  payload: EncryptedCredentialPayload,
  aad: AadContext,
  keyring: CredentialKekKeyring
): Buffer {
  const kek = credentialKekForVersion(keyring, payload.kekVersion)
  const unwrapper = createDecipheriv(ALGORITHM, kek, payload.wrapIv)
  unwrapper.setAAD(aad.wrap(payload.kekVersion))
  unwrapper.setAuthTag(payload.wrapTag)
  const dek = Buffer.concat([unwrapper.update(payload.wrappedDek), unwrapper.final()])
  assertKey(dek, 'Credential DEK')
  return dek
}

function wrapCredentialDek(
  dek: Buffer,
  aad: AadContext,
  kek: Buffer,
  kekVersion: number
): Pick<EncryptedCredentialPayload, 'wrappedDek' | 'wrapIv' | 'wrapTag' | 'kekVersion'> {
  assertKey(dek, 'Credential DEK')
  assertKey(kek, 'Credential KEK')
  assertKekVersion(kekVersion)
  const wrapIv = randomBytes(IV_BYTES)
  const wrapper = createCipheriv(ALGORITHM, kek, wrapIv)
  wrapper.setAAD(aad.wrap(kekVersion))
  const wrappedDek = Buffer.concat([wrapper.update(dek), wrapper.final()])
  return {
    wrappedDek,
    wrapIv,
    wrapTag: wrapper.getAuthTag(),
    kekVersion,
  }
}

function encryptWithAad(
  value: string | Buffer,
  aad: AadContext,
  kek: Buffer,
  kekVersion: number
): EncryptedCredentialPayload {
  assertKey(kek, 'Credential KEK')
  assertKekVersion(kekVersion)
  const dek = randomBytes(DEK_BYTES)
  try {
    const iv = randomBytes(IV_BYTES)
    const cipher = createCipheriv(ALGORITHM, dek, iv)
    cipher.setAAD(aad.value())
    const ciphertext = Buffer.concat([
      typeof value === 'string' ? cipher.update(value, 'utf8') : cipher.update(value),
      cipher.final(),
    ])
    const tag = cipher.getAuthTag()

    const wrapped = wrapCredentialDek(dek, aad, kek, kekVersion)

    return {
      ciphertext,
      iv,
      tag,
      ...wrapped,
      aadVersion: aad.aadVersion,
    }
  } finally {
    dek.fill(0)
  }
}

export function encryptCredentialValue(
  value: string,
  scope: CredentialScope,
  kek: Buffer,
  kekVersion: number
): EncryptedCredentialPayload {
  return encryptWithAad(value, teamAad(scope), kek, kekVersion)
}

/** Seals a value under the retired binding scope. Migration fixtures only. */
export function encryptLegacyBindingValue(
  value: string,
  scope: LegacyBindingScope,
  kek: Buffer,
  kekVersion: number
): EncryptedCredentialPayload {
  return encryptWithAad(value, legacyBindingAad(scope), kek, kekVersion)
}

function decryptWithAad(
  payload: EncryptedCredentialPayload,
  aad: AadContext,
  keyring: CredentialKekKeyring
): Buffer {
  assertPayload(payload, aad.aadVersion)
  const dek = unwrapCredentialDek(payload, aad, keyring)

  try {
    const decipher = createDecipheriv(ALGORITHM, dek, payload.iv)
    decipher.setAAD(aad.value())
    decipher.setAuthTag(payload.tag)
    return Buffer.concat([decipher.update(payload.ciphertext), decipher.final()])
  } finally {
    dek.fill(0)
  }
}

export function decryptCredentialValue(
  payload: EncryptedCredentialPayload,
  scope: CredentialScope,
  keyring: CredentialKekKeyring
): string {
  const plaintext = decryptWithAad(payload, teamAad(scope), keyring)
  try {
    return plaintext.toString('utf8')
  } finally {
    plaintext.fill(0)
  }
}

/** Backup verification authenticates the DEK without materializing the credential value. */
export function verifyCredentialDek(payload: EncryptedCredentialPayload, scope: CredentialScope, keyring: CredentialKekKeyring): void {
  const aad = teamAad(scope)
  assertPayload(payload, aad.aadVersion)
  unwrapCredentialDek(payload, aad, keyring).fill(0)
}

/**
 * Reads a value sealed under the retired per-Skill binding scope. Only the
 * one-time team-credential migration calls this; it re-encrypts the result
 * under the team scope and never returns it elsewhere.
 */
export function decryptLegacyBindingValue(
  payload: EncryptedCredentialPayload,
  scope: LegacyBindingScope,
  keyring: CredentialKekKeyring
): string {
  const plaintext = decryptWithAad(payload, legacyBindingAad(scope), keyring)
  try {
    return plaintext.toString('utf8')
  } finally {
    plaintext.fill(0)
  }
}

export function encryptInstanceSecret(
  value: Buffer,
  scope: { name: string },
  kek: Buffer,
  kekVersion: number
): EncryptedCredentialPayload {
  return encryptWithAad(value, instanceSecretAad(scope), kek, kekVersion)
}

/** The caller must clear the returned plaintext buffer after use. */
export function decryptInstanceSecret(
  payload: EncryptedCredentialPayload,
  scope: { name: string },
  keyring: CredentialKekKeyring
): Buffer {
  return decryptWithAad(payload, instanceSecretAad(scope), keyring)
}

export function rewrapCredentialDek(
  payload: EncryptedCredentialPayload,
  scope: CredentialScope,
  sourceKeyring: CredentialKekKeyring,
  targetKek: Buffer,
  targetKekVersion: number
): EncryptedCredentialPayload {
  const aad = teamAad(scope)
  assertPayload(payload, aad.aadVersion)
  const dek = unwrapCredentialDek(payload, aad, sourceKeyring)
  try {
    return {
      ciphertext: Buffer.from(payload.ciphertext),
      iv: Buffer.from(payload.iv),
      tag: Buffer.from(payload.tag),
      ...wrapCredentialDek(dek, aad, targetKek, targetKekVersion),
      aadVersion: payload.aadVersion,
    }
  } finally {
    dek.fill(0)
  }
}
