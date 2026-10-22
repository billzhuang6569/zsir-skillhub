import { describe, expect, it } from 'vitest'
import {
  decodeCredentialKekKeyring,
  decryptCredentialValue,
  decryptInstanceSecret,
  destroyCredentialKekKeyring,
  encryptCredentialValue,
  encryptInstanceSecret,
  rewrapCredentialDek,
  decryptLegacyBindingValue,
  encryptLegacyBindingValue,
  CREDENTIAL_AAD_VERSION,
  LEGACY_BINDING_AAD_VERSION,
  type CredentialScope,
  type LegacyBindingScope,
} from './credential-crypto.js'

const kek = Buffer.alloc(32, 0x42)
const keyring = new Map([[7, kek]])
const scope: CredentialScope = {
  credentialId: '11111111-1111-4111-8111-111111111111',
  teamId: '33333333-3333-4333-8333-333333333333',
  envKey: 'SERVICE_API_KEY',
  revision: 1,
}

describe('credential envelope encryption', () => {
  it('round-trips binary instance secrets and rejects a different name, KEK or purpose', () => {
    const value = Buffer.from([0, 255, 128, 1, 192, 42])
    const instanceScope = { name: 'instance-identity-key' }
    const payload = encryptInstanceSecret(value, instanceScope, kek, 7)
    expect(decryptInstanceSecret(payload, instanceScope, keyring)).toEqual(value)
    expect(payload.ciphertext).not.toEqual(value)
    expect(() => decryptInstanceSecret(payload, { name: 'other-setting' }, keyring)).toThrow()
    expect(() => decryptInstanceSecret(payload, instanceScope, new Map([[7, Buffer.alloc(32, 0x43)]]))).toThrow()
    expect(() => decryptCredentialValue(payload, scope, keyring)).toThrow()
    const teamPayload = encryptCredentialValue('team-secret', scope, kek, 7)
    expect(() => decryptInstanceSecret(teamPayload, instanceScope, keyring)).toThrow()
  })

  it('round-trips a value without storing plaintext in either ciphertext', () => {
    const plaintext = 'super-secret-value-for-runtime-only'
    const encrypted = encryptCredentialValue(plaintext, scope, kek, 7)

    expect(encrypted.ciphertext.toString('utf8')).not.toContain(plaintext)
    expect(encrypted.wrappedDek.toString('utf8')).not.toContain(plaintext)
    expect(decryptCredentialValue(encrypted, scope, keyring)).toBe(plaintext)
  })

  it('rejects a credential moved to a different AAD scope', () => {
    const encrypted = encryptCredentialValue('secret', scope, kek, 7)

    expect(() => decryptCredentialValue(
      encrypted,
      { ...scope, teamId: '44444444-4444-4444-8444-444444444444' },
      keyring
    )).toThrow()
  })

  it('rejects damaged GCM authentication tags', () => {
    const encrypted = encryptCredentialValue('secret', scope, kek, 7)
    const damagedTag = Buffer.from(encrypted.tag)
    damagedTag[0] ^= 0xff

    expect(() => decryptCredentialValue(
      { ...encrypted, tag: damagedTag },
      scope,
      keyring
    )).toThrow()
  })

  it('selects historical KEKs by the version stored with each ciphertext', () => {
    const historicalKek = Buffer.alloc(32, 0x43)
    const encrypted = encryptCredentialValue('historical-secret', scope, historicalKek, 6)

    expect(decryptCredentialValue(encrypted, scope, new Map([
      [7, kek],
      [6, historicalKek],
    ]))).toBe('historical-secret')
    expect(() => decryptCredentialValue(encrypted, scope, keyring)).toThrow(
      'Credential KEK version is unavailable'
    )
  })

  it('rewraps only the DEK for a new KEK version', () => {
    const historicalKek = Buffer.alloc(32, 0x43)
    const currentKek = Buffer.alloc(32, 0x44)
    const encrypted = encryptCredentialValue('rotation-secret', scope, historicalKek, 6)
    const rotated = rewrapCredentialDek(
      encrypted,
      scope,
      new Map([[6, historicalKek]]),
      currentKek,
      7
    )

    expect(rotated.kekVersion).toBe(7)
    expect(rotated.ciphertext).toEqual(encrypted.ciphertext)
    expect(rotated.iv).toEqual(encrypted.iv)
    expect(rotated.tag).toEqual(encrypted.tag)
    expect(rotated.wrappedDek).not.toEqual(encrypted.wrappedDek)
    expect(decryptCredentialValue(rotated, scope, new Map([[7, currentKek]]))).toBe('rotation-secret')
    expect(() => decryptCredentialValue(rotated, scope, new Map([[6, historicalKek]]))).toThrow(
      'Credential KEK version is unavailable'
    )
  })

  it('builds and destroys a versioned KEK keyring without exposing key material', () => {
    const currentEncoded = Buffer.alloc(32, 0x42).toString('base64')
    const historicalEncoded = Buffer.alloc(32, 0x43).toString('base64')
    const decoded = decodeCredentialKekKeyring(currentEncoded, 7, { '6': historicalEncoded })
    const decodedCurrent = decoded.get(7)
    const decodedHistorical = decoded.get(6)

    expect(decodedCurrent).toEqual(Buffer.alloc(32, 0x42))
    expect(decodedHistorical).toEqual(Buffer.alloc(32, 0x43))
    expect(() => decodeCredentialKekKeyring(currentEncoded, 7, { '7': historicalEncoded })).toThrow(
      'Credential KEK keyring contains a duplicate version'
    )

    destroyCredentialKekKeyring(decoded)
    expect(decoded.size).toBe(0)
    expect(decodedCurrent).toEqual(Buffer.alloc(32))
    expect(decodedHistorical).toEqual(Buffer.alloc(32))
  })

  it('binds team values to credential, team, key and revision', () => {
    const encrypted = encryptCredentialValue('team-secret', scope, kek, 7)
    expect(encrypted.aadVersion).toBe(CREDENTIAL_AAD_VERSION)
    for (const moved of [
      { ...scope, credentialId: '55555555-5555-4555-8555-555555555555' },
      { ...scope, envKey: 'OTHER_KEY' },
      { ...scope, revision: 2 },
    ]) {
      expect(() => decryptCredentialValue(encrypted, moved, keyring)).toThrow()
    }
  })

  it('reads retired binding values only through the legacy scope', () => {
    const legacy: LegacyBindingScope = {
      bindingId: '11111111-1111-4111-8111-111111111111',
      skillId: '22222222-2222-4222-8222-222222222222',
      teamId: scope.teamId,
      envKey: scope.envKey,
      revision: 3,
    }
    const encrypted = encryptLegacyBindingValue('legacy-secret', legacy, kek, 7)
    expect(encrypted.aadVersion).toBe(LEGACY_BINDING_AAD_VERSION)
    expect(decryptLegacyBindingValue(encrypted, legacy, keyring)).toBe('legacy-secret')
    expect(() => decryptCredentialValue(encrypted, { ...scope, revision: 3 }, keyring)).toThrow(
      'Invalid encrypted credential payload'
    )
    expect(() => decryptLegacyBindingValue(encrypted, { ...legacy, skillId: scope.teamId }, keyring)).toThrow()
  })
})
