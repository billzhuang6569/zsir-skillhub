import { config } from '../config.js'
import * as builtin from '../providers/builtin-media.js'
import * as picem from '../providers/picem-media.js'

export class MediaError extends Error {
  constructor(public readonly statusCode: number, message: string) { super(message); this.name = 'MediaError' }
}

export type MediaUploadOptions = {
  purpose: 'avatar' | 'image'
  visibility: 'public' | 'private'
  ownerRef: string
  userId?: string
}

export type MediaService = {
  uploadMedia: (bytes: Buffer, mimeType: string, name: string, options: MediaUploadOptions) => Promise<{ assetId: string; url: string | null }>
  removeMedia: (ownerRef: string) => Promise<void>
  readPrivateMedia: (assetId: string, ownerRef: string, maxBytes: number) => Promise<Buffer>
  authorizeMediaUrl: (value: string | null | undefined, userId: string, current?: string | null) => Promise<void>
  publicImageUrl: (value: string) => string
  isRetiredMedia: (value: string | null | undefined) => boolean
}

const media: MediaService = config.SKILLHUB_PROFILE === 'selfhost' ? builtin : picem
export const { uploadMedia, removeMedia, readPrivateMedia, authorizeMediaUrl, publicImageUrl, isRetiredMedia } = media
