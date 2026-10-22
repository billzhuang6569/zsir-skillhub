// Header-only image dimension parsing (no image library on the Server). Each parser
// reads only the fixed header fields of its format and returns null when the bytes
// are not a well-formed header of that format.

export type ImageMimeType = 'image/jpeg' | 'image/png' | 'image/webp'
export type ImageSize = { width: number; height: number }

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
/** Start-of-frame markers that carry the frame size (baseline, progressive, lossless, arithmetic). */
const JPEG_SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])

export function jpegSize(bytes: Buffer): ImageSize | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null
  for (let offset = 2; offset + 4 <= bytes.length;) {
    if (bytes[offset] !== 0xff) return null
    const marker = bytes[offset + 1]!
    if (marker === 0xff) { offset += 1; continue }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { offset += 2; continue }
    if (marker === 0xda || marker === 0xd9) return null
    const length = bytes.readUInt16BE(offset + 2)
    if (length < 2 || offset + 2 + length > bytes.length) return null
    if (JPEG_SOF.has(marker)) {
      if (length < 7) return null
      const height = bytes.readUInt16BE(offset + 5)
      const width = bytes.readUInt16BE(offset + 7)
      return width > 0 && height > 0 ? { width, height } : null
    }
    offset += 2 + length
  }
  return null
}

export function pngSize(bytes: Buffer): ImageSize | null {
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return null
  if (bytes.readUInt32BE(8) !== 13 || bytes.subarray(12, 16).toString('ascii') !== 'IHDR') return null
  const width = bytes.readUInt32BE(16)
  const height = bytes.readUInt32BE(20)
  return width > 0 && height > 0 ? { width, height } : null
}

export function webpSize(bytes: Buffer): ImageSize | null {
  if (bytes.length < 30 || bytes.subarray(0, 4).toString('ascii') !== 'RIFF' || bytes.subarray(8, 12).toString('ascii') !== 'WEBP') return null
  const chunk = bytes.subarray(12, 16).toString('ascii')
  if (chunk === 'VP8 ') {
    // Lossy key frame: 3-byte frame tag, start code 9d 01 2a, then 14-bit width / height.
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return null
    const width = bytes.readUInt16LE(26) & 0x3fff
    const height = bytes.readUInt16LE(28) & 0x3fff
    return width > 0 && height > 0 ? { width, height } : null
  }
  if (chunk === 'VP8L') {
    // Lossless: signature 0x2f, then 14-bit (width - 1) and 14-bit (height - 1).
    if (bytes[20] !== 0x2f) return null
    const bits = bytes.readUInt32LE(21)
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 }
  }
  if (chunk === 'VP8X') {
    // Extended (alpha / animation): 24-bit (canvas width - 1) and (canvas height - 1).
    return { width: bytes.readUIntLE(24, 3) + 1, height: bytes.readUIntLE(27, 3) + 1 }
  }
  return null
}

export function imageSize(bytes: Buffer, mimeType: ImageMimeType): ImageSize | null {
  if (mimeType === 'image/jpeg') return jpegSize(bytes)
  if (mimeType === 'image/png') return pngSize(bytes)
  return webpSize(bytes)
}
