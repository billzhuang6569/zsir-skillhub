import { describe, expect, it } from 'vitest'
import { MAX_TOPIC_COVER_BYTES, prepareTopicCover } from './topic-cover-assets.js'

describe('topic cover assets', () => {
  it('accepts a canonical PNG signature and creates an opaque filename', () => {
    const result = prepareTopicCover({ mimeType: 'image/png', dataBase64: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64') })
    expect(result.storageName).toMatch(/^[0-9a-f-]{36}\.png$/)
    expect(result.bytes).toHaveLength(8)
  })

  it('rejects mismatched and oversized image content', () => {
    expect(() => prepareTopicCover({ mimeType: 'image/png', dataBase64: Buffer.from('not an image').toString('base64') })).toThrow(/does not match/)
    expect(() => prepareTopicCover({ mimeType: 'image/jpeg', dataBase64: Buffer.alloc(MAX_TOPIC_COVER_BYTES + 1).toString('base64') })).toThrow(/5 MB/)
  })
})
