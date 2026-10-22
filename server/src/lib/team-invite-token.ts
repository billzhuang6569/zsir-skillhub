import { createHmac, timingSafeEqual } from 'node:crypto'
import type { Config } from '../config.js'

const TOKEN_PREFIX = 'shti1'
const PAYLOAD_BYTES = 40
const SIGNATURE_BYTES = 20
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export type TeamInviteClaims = {
  version: 1
  teamId: string
  invitedBy: string
  expiresAt: number
}

export type InviteBinding = { instanceId: string; publicBaseUrl: string }

function signatureFor(payload: string, secret: string, binding: InviteBinding): Buffer {
  return createHmac('sha256', secret)
    .update(JSON.stringify([TOKEN_PREFIX, payload, binding.instanceId, binding.publicBaseUrl]))
    .digest()
    .subarray(0, SIGNATURE_BYTES)
}

function uuidBytes(value: string): Buffer | null {
  if (!UUID_PATTERN.test(value)) return null
  return Buffer.from(value.replaceAll('-', ''), 'hex')
}

function bytesUuid(value: Buffer): string {
  const hex = value.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function createTeamInviteToken(input: {
  teamId: string
  invitedBy: string
  secret: string
  expiresAt: number
  binding: InviteBinding
}): string {
  const teamBytes = uuidBytes(input.teamId)
  const inviterBytes = uuidBytes(input.invitedBy)
  if (!teamBytes || !inviterBytes || !Number.isSafeInteger(input.expiresAt) || input.expiresAt <= 0) {
    throw new Error('Team invite claims are invalid')
  }
  const payloadBytes = Buffer.alloc(PAYLOAD_BYTES)
  teamBytes.copy(payloadBytes, 0)
  inviterBytes.copy(payloadBytes, 16)
  payloadBytes.writeBigUInt64BE(BigInt(input.expiresAt), 32)
  const payload = payloadBytes.toString('base64url')
  return `${TOKEN_PREFIX}.${payload}.${signatureFor(payload, input.secret, input.binding).toString('base64url')}`
}

export function verifyTeamInviteToken(
  token: string,
  secret: string,
  binding: InviteBinding,
  profile: Config['SKILLHUB_PROFILE'],
  now = Date.now()
): TeamInviteClaims | null {
  if (!token || token.length > 100) return null
  const [prefix, payload, encodedSignature, extra] = token.split('.')
  if (prefix !== TOKEN_PREFIX || !payload || !encodedSignature || extra !== undefined) return null

  let actualSignature: Buffer
  try {
    actualSignature = Buffer.from(encodedSignature, 'base64url')
  } catch {
    return null
  }
  if (actualSignature.toString('base64url') !== encodedSignature) return null
  const expectedSignature = signatureFor(payload, secret, binding)
  if (actualSignature.length !== expectedSignature.length) return null
  if (!timingSafeEqual(actualSignature, expectedSignature)) {
    if (profile !== 'yitan-official') return null
    // v0.32.0 release transition: legacy invites expire within 7 days; remove this fallback after the transition.
    const legacySignature = createHmac('sha256', secret)
      .update(`${TOKEN_PREFIX}.${payload}`)
      .digest()
      .subarray(0, SIGNATURE_BYTES)
    if (!timingSafeEqual(actualSignature, legacySignature)) return null
  }

  let payloadBytes: Buffer
  try {
    payloadBytes = Buffer.from(payload, 'base64url')
  } catch {
    return null
  }
  if (payloadBytes.length !== PAYLOAD_BYTES || payloadBytes.toString('base64url') !== payload) return null
  const teamId = bytesUuid(payloadBytes.subarray(0, 16))
  const invitedBy = bytesUuid(payloadBytes.subarray(16, 32))
  const expiresAtBigInt = payloadBytes.readBigUInt64BE(32)
  if (expiresAtBigInt > BigInt(Number.MAX_SAFE_INTEGER)) return null
  const expiresAt = Number(expiresAtBigInt)
  if (!UUID_PATTERN.test(teamId) || !UUID_PATTERN.test(invitedBy) || expiresAt <= now) return null
  return {
    version: 1,
    teamId,
    invitedBy,
    expiresAt,
  }
}
