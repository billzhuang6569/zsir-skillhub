import { randomUUID } from 'node:crypto'
import { uploadMedia, removeMedia, readPrivateMedia } from './media.js'

export const MAX_FEEDBACK_ATTACHMENTS = 3
export const MAX_FEEDBACK_ATTACHMENT_BYTES = 5 * 1024 * 1024
export const MAX_FEEDBACK_REQUEST_BYTES = 22 * 1024 * 1024

const ATTACHMENT_MIME_TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
} as const

export type FeedbackAttachmentMimeType = keyof typeof ATTACHMENT_MIME_TYPES

export type IncomingFeedbackAttachment = {
  fileName: string
  mimeType: FeedbackAttachmentMimeType
  dataBase64: string
}

export type StoredFeedbackAttachment = {
  id: string
  fileName: string
  mimeType: FeedbackAttachmentMimeType
  size: number
  assetId: string
}

type PreparedFeedbackAttachment = {
  metadata: StoredFeedbackAttachment
  bytes: Buffer
}

function hasImageSignature(bytes: Buffer, mimeType: FeedbackAttachmentMimeType): boolean {
  if (mimeType === 'image/png') {
    return bytes.length >= 8
      && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  }
  if (mimeType === 'image/jpeg') {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  }
  return bytes.length >= 12
    && bytes.subarray(0, 4).toString('ascii') === 'RIFF'
    && bytes.subarray(8, 12).toString('ascii') === 'WEBP'
}

function normalizedFileName(value: string, mimeType: FeedbackAttachmentMimeType): string {
  const fallback = `feedback.${ATTACHMENT_MIME_TYPES[mimeType]}`
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/]/g, '-')
    .trim()
    .slice(0, 160)
  return normalized || fallback
}

export function prepareFeedbackAttachment(input: IncomingFeedbackAttachment): PreparedFeedbackAttachment {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.dataBase64)) {
    throw new Error('Feedback attachment encoding is invalid')
  }
  const bytes = Buffer.from(input.dataBase64, 'base64')
  if (bytes.length === 0 || bytes.length > MAX_FEEDBACK_ATTACHMENT_BYTES) {
    throw new Error('Feedback attachment must be between 1 byte and 5 MB')
  }
  if (bytes.toString('base64') !== input.dataBase64 || !hasImageSignature(bytes, input.mimeType)) {
    throw new Error('Feedback attachment content does not match its image type')
  }

  const id = randomUUID()
  return {
    metadata: {
      id,
      fileName: normalizedFileName(input.fileName, input.mimeType),
      mimeType: input.mimeType,
      size: bytes.length,
      assetId: '',
    },
    bytes,
  }
}

export async function storeFeedbackAttachments(
  feedbackId: string,
  attachments: IncomingFeedbackAttachment[]
): Promise<StoredFeedbackAttachment[]> {
  if (attachments.length > MAX_FEEDBACK_ATTACHMENTS) throw new Error('Too many feedback attachments')
  if (attachments.length === 0) return []
  const prepared = attachments.map(prepareFeedbackAttachment)
  try {
    for (const attachment of prepared) {
      const asset = await uploadMedia(attachment.bytes, attachment.metadata.mimeType, attachment.metadata.fileName, {
        purpose: 'image', visibility: 'private', ownerRef: `feedback:${feedbackId}`,
      })
      attachment.metadata.assetId = asset.assetId
    }
  } catch (error: unknown) {
    // Accepted/unknown requests remain registered and resume under the same logical operation.
    throw error
  }
  return prepared.map((attachment) => attachment.metadata)
}

export async function removeFeedbackAttachments(feedbackId: string): Promise<void> {
  await removeMedia(`feedback:${feedbackId}`)
}

export function parseStoredFeedbackAttachments(value: unknown): StoredFeedbackAttachment[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return []
    const record = item as Record<string, unknown>
    if (
      typeof record.id !== 'string'
      || typeof record.fileName !== 'string'
      || typeof record.mimeType !== 'string'
      || !(record.mimeType in ATTACHMENT_MIME_TYPES)
      || typeof record.size !== 'number'
      || !Number.isSafeInteger(record.size)
      || record.size < 1
      || typeof record.assetId !== 'string'
      || !/^(?:ast_[a-zA-Z0-9_-]+|[a-f0-9]{64})$/.test(record.assetId)
    ) return []
    return [{
      id: record.id,
      fileName: record.fileName,
      mimeType: record.mimeType as FeedbackAttachmentMimeType,
      size: record.size,
      assetId: record.assetId,
    }]
  })
}

export async function readFeedbackAttachment(
  feedbackId: string,
  attachment: StoredFeedbackAttachment
): Promise<Buffer> {
  return readPrivateMedia(attachment.assetId, `feedback:${feedbackId}`, MAX_FEEDBACK_ATTACHMENT_BYTES)
}
