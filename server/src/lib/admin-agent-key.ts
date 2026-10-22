import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

export const AGENT_KEY_PREFIX = 'skh_agent_'
export const AGENT_SCOPES = ['ops:read', 'ops:logs:read', 'marketplace:publish', 'marketplace:review', 'marketplace:topics:write'] as const
export type AgentScope = (typeof AGENT_SCOPES)[number]

const KEY_PATTERN = /^skh_agent_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})_([A-Za-z0-9_-]{43})$/

export function secretHash(secret: string): string {
  return createHash('sha256').update(secret, 'ascii').digest('hex')
}

export function createAgentKey(id: string): { token: string; hash: string } {
  const secret = randomBytes(32).toString('base64url')
  return { token: `${AGENT_KEY_PREFIX}${id}_${secret}`, hash: secretHash(secret) }
}

export function parseAgentKey(value: string): { id: string; hash: string } | null {
  if (value.length > 120) return null
  const match = KEY_PATTERN.exec(value)
  if (!match) return null
  const secret = Buffer.from(match[2], 'base64url')
  if (secret.length !== 32 || secret.toString('base64url') !== match[2]) return null
  return { id: match[1], hash: secretHash(match[2]) }
}

export function equalHash(expected: string, actual: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(expected) || !/^[0-9a-f]{64}$/.test(actual)) return false
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(actual, 'hex'))
}
