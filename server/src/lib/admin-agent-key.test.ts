import { describe, expect, it } from 'vitest'
import { createAgentKey, equalHash, parseAgentKey } from './admin-agent-key.js'

describe('Admin Agent Key format', () => {
  it('creates a high-entropy secret and accepts only its canonical form', () => {
    const id = '11111111-1111-4111-8111-111111111111'
    const first = createAgentKey(id)
    const second = createAgentKey(id)
    expect(first.token).not.toBe(second.token)
    expect(parseAgentKey(first.token)).toEqual({ id, hash: first.hash })
    expect(equalHash(first.hash, second.hash)).toBe(false)
    expect(equalHash(first.hash, first.hash)).toBe(true)
    expect(parseAgentKey(`${first.token}=`)).toBeNull()
    expect(parseAgentKey(`Bearer ${first.token}`)).toBeNull()
    expect(parseAgentKey(first.token.replace(/.$/, '!'))).toBeNull()
  })
})
