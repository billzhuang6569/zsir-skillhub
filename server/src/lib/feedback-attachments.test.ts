import { describe, expect, it, vi } from 'vitest'
const media = vi.hoisted(() => ({ uploadMedia: vi.fn(), readPrivateMedia: vi.fn(), removeMedia: vi.fn() }))
vi.mock('./media.js', () => media)
import {
  prepareFeedbackAttachment,
  parseStoredFeedbackAttachments,
  readFeedbackAttachment,
  storeFeedbackAttachments,
} from './feedback-attachments.js'

describe('feedback attachments', () => {
  it.each(['ast_private', 'a'.repeat(64)])('stores, parses and reads private asset ID %s', async (assetId): Promise<void> => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
    media.uploadMedia.mockResolvedValue({ assetId, url: null })
    media.readPrivateMedia.mockResolvedValue(bytes)
    const [attachment] = await storeFeedbackAttachments('11111111-1111-4111-8111-111111111111', [{
      fileName: '../screen.png',
      mimeType: 'image/png',
      dataBase64: bytes.toString('base64'),
    }])
    expect(attachment?.fileName).toBe('..-screen.png')
    expect(attachment?.assetId).toBe(assetId)
    expect(media.uploadMedia.mock.calls[0]?.[3]).toEqual({ purpose: 'image', visibility: 'private', ownerRef: 'feedback:11111111-1111-4111-8111-111111111111' })
    const parsed = parseStoredFeedbackAttachments(JSON.parse(JSON.stringify([attachment])) as unknown)
    expect(parsed).toEqual([attachment])
    expect(await readFeedbackAttachment('11111111-1111-4111-8111-111111111111', parsed[0]!)).toEqual(bytes)
    expect(media.readPrivateMedia).toHaveBeenCalledWith(assetId, 'feedback:11111111-1111-4111-8111-111111111111', 5 * 1024 * 1024)
    expect(parseStoredFeedbackAttachments([{ ...attachment, assetId: '../private' }, { ...attachment, assetId: 'a'.repeat(63) }])).toEqual([])
  })

  it('rejects type spoofing and non-canonical base64', () => {
    expect(() => prepareFeedbackAttachment({
      fileName: 'fake.png',
      mimeType: 'image/png',
      dataBase64: Buffer.from('not an image').toString('base64'),
    })).toThrow(/does not match/)
    expect(() => prepareFeedbackAttachment({
      fileName: 'bad.png',
      mimeType: 'image/png',
      dataBase64: '%%%%',
    })).toThrow(/encoding is invalid/)
  })
})
