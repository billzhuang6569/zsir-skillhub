import { describe, expect, it } from 'vitest'
import { decodeDiagnosticCursor, encodeDiagnosticCursor } from './admin-diagnostic-cursor.js'

const position = {
  keyId: '11111111-1111-4111-8111-111111111111',
  from: '2026-10-04T12:00:00.000Z',
  until: '2026-10-04T12:15:00.000Z',
  status: 503,
  limit: 100,
  createdAt: '2026-10-04T12:05:00.000Z',
  id: '22222222-2222-4222-8222-222222222222',
}

describe('Admin diagnostic cursor', () => {
  it('binds position, filters and Key with integrity protection', () => {
    const cursor = encodeDiagnosticCursor(position, 'unit-test-secret')
    expect(decodeDiagnosticCursor(cursor, position.keyId, 'unit-test-secret')).toEqual(position)
    expect(decodeDiagnosticCursor(cursor, '33333333-3333-4333-8333-333333333333', 'unit-test-secret')).toBeNull()
    expect(decodeDiagnosticCursor(cursor.slice(0, -1) + 'A', position.keyId, 'unit-test-secret')).toBeNull()
    expect(decodeDiagnosticCursor(cursor, position.keyId, 'different-secret')).toBeNull()
  })
})
