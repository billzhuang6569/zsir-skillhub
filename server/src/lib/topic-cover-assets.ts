import { randomUUID } from 'node:crypto'
import { uploadMedia } from './media.js'

export const MAX_TOPIC_COVER_BYTES = 5 * 1024 * 1024

const TOPIC_COVER_MIME_TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
} as const

export type TopicCoverMimeType = keyof typeof TOPIC_COVER_MIME_TYPES

export type IncomingTopicCover = {
  mimeType: TopicCoverMimeType
  dataBase64: string
}

function hasImageSignature(bytes: Buffer, mimeType: TopicCoverMimeType): boolean {
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

export function prepareTopicCover(input: IncomingTopicCover): { storageName: string; bytes: Buffer } {
  if (input.dataBase64.length > Math.ceil(MAX_TOPIC_COVER_BYTES / 3) * 4 + 4) {
    throw new Error('Topic cover must be between 1 byte and 5 MB')
  }
  const bytes = Buffer.from(input.dataBase64, 'base64')
  if (bytes.length === 0 || bytes.length > MAX_TOPIC_COVER_BYTES) {
    throw new Error('Topic cover must be between 1 byte and 5 MB')
  }
  if (bytes.toString('base64') !== input.dataBase64 || !hasImageSignature(bytes, input.mimeType)) {
    throw new Error('Topic cover content does not match its image type')
  }
  return { storageName: `${randomUUID()}.${TOPIC_COVER_MIME_TYPES[input.mimeType]}`, bytes }
}

export async function storeTopicCover(userId: string, input: IncomingTopicCover): Promise<string> {
  const prepared = prepareTopicCover(input)
  const asset = await uploadMedia(prepared.bytes, input.mimeType, prepared.storageName, {
    purpose: 'image', visibility: 'public', ownerRef: `covers:${userId}`, userId,
  })
  if (!asset.url) throw new Error('Cover is not public')
  return asset.url
}
