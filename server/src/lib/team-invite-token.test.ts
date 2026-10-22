import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createTeamInviteToken, verifyTeamInviteToken } from './team-invite-token.js'

const secret = 'test-team-invite-secret-value'
const teamId = '11111111-1111-4111-8111-111111111111'
const invitedBy = '22222222-2222-4222-8222-222222222222'
const binding = { instanceId: 'instance-a', publicBaseUrl: 'https://skills.example.test/base' }

function legacyToken(expiresAt: number): string {
  const bytes = Buffer.alloc(40)
  Buffer.from(teamId.replaceAll('-', ''), 'hex').copy(bytes, 0)
  Buffer.from(invitedBy.replaceAll('-', ''), 'hex').copy(bytes, 16)
  bytes.writeBigUInt64BE(BigInt(expiresAt), 32)
  const message = `shti1.${bytes.toString('base64url')}`
  const signature = createHmac('sha256', secret).update(message).digest().subarray(0, 20)
  return `${message}.${signature.toString('base64url')}`
}

describe('team invite tokens', () => {
  it.each(['yitan-official', 'selfhost'] as const)('round-trips signed claims and rejects tampering in %s', profile => {
    const expiresAt = Date.now() + 60_000
    const token = createTeamInviteToken({ teamId, invitedBy, expiresAt, secret, binding })

    expect(verifyTeamInviteToken(token, secret, binding, profile)).toEqual({
      version: 1,
      teamId,
      invitedBy,
      expiresAt,
    })
    expect(verifyTeamInviteToken(`${token}x`, secret, binding, profile)).toBeNull()
    const tampered = `${token.slice(0, -1)}${token.endsWith('a') ? 'b' : 'a'}`
    expect(verifyTeamInviteToken(tampered, secret, binding, profile)).toBeNull()
    expect(verifyTeamInviteToken(token, secret, { ...binding, instanceId: 'instance-b' }, profile)).toBeNull()
    expect(verifyTeamInviteToken(token, secret, { ...binding, publicBaseUrl: 'https://moved.example.test' }, profile)).toBeNull()
  })

  it.each(['yitan-official', 'selfhost'] as const)('rejects expired tokens in %s', profile => {
    const expiresAt = Date.now() - 1
    const token = createTeamInviteToken({ teamId, invitedBy, expiresAt, secret, binding })
    expect(verifyTeamInviteToken(token, secret, binding, profile)).toBeNull()
  })

  it('accepts unexpired legacy tokens only in the official profile', () => {
    const now = 1_800_000_000_000
    const expiresAt = now + 60_000
    const token = legacyToken(expiresAt)
    expect(verifyTeamInviteToken(token, secret, binding, 'yitan-official', now)).toEqual({ version: 1, teamId, invitedBy, expiresAt })
    expect(verifyTeamInviteToken(token, secret, binding, 'selfhost', now)).toBeNull()
  })

  it('rejects expired legacy tokens in the official profile, including the expiry boundary', () => {
    const now = 1_800_000_000_000
    for (const expiresAt of [now - 1, now]) {
      expect(verifyTeamInviteToken(legacyToken(expiresAt), secret, binding, 'yitan-official', now)).toBeNull()
    }
  })

  it('rejects invalid legacy signatures in the official profile', () => {
    const now = 1_800_000_000_000
    const token = legacyToken(now + 60_000)
    const message = token.slice(0, token.lastIndexOf('.'))
    for (const size of [19, 20, 21]) {
      expect(verifyTeamInviteToken(`${message}.${Buffer.alloc(size).toString('base64url')}`, secret, binding, 'yitan-official', now)).toBeNull()
    }
    expect(verifyTeamInviteToken(token, 'wrong-secret', binding, 'yitan-official', now)).toBeNull()
  })
})
