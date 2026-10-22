import { describe, expect, it } from 'vitest'
import { imageSize, jpegSize, pngSize, webpSize } from './image-dimensions.js'

/** Minimal headers of each format with the given size (enough for header parsing). */
function pngHeader(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0)
  bytes.writeUInt32BE(13, 8); bytes.write('IHDR', 12, 'ascii')
  bytes.writeUInt32BE(width, 16); bytes.writeUInt32BE(height, 20)
  return bytes
}
function jpegHeader(width: number, height: number, marker = 0xc0): Buffer {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x04, 0x00, 0x00])
  const sof = Buffer.alloc(19)
  sof[0] = 0xff; sof[1] = marker; sof.writeUInt16BE(17, 2); sof[4] = 8
  sof.writeUInt16BE(height, 5); sof.writeUInt16BE(width, 7)
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9])])
}
function riff(chunk: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(20)
  header.write('RIFF', 0, 'ascii'); header.writeUInt32LE(12 + payload.length, 4); header.write('WEBP', 8, 'ascii')
  header.write(chunk, 12, 'ascii'); header.writeUInt32LE(payload.length, 16)
  return Buffer.concat([header, payload, Buffer.alloc(16)])
}
function webpLossy(width: number, height: number): Buffer {
  const payload = Buffer.alloc(10)
  payload[3] = 0x9d; payload[4] = 0x01; payload[5] = 0x2a
  payload.writeUInt16LE(width, 6); payload.writeUInt16LE(height, 8)
  return riff('VP8 ', payload)
}
function webpLossless(width: number, height: number): Buffer {
  const payload = Buffer.alloc(5)
  payload[0] = 0x2f
  payload.writeUInt32LE(((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14), 1)
  return riff('VP8L', payload)
}
function webpExtended(width: number, height: number): Buffer {
  const payload = Buffer.alloc(10)
  payload.writeUIntLE(width - 1, 4, 3); payload.writeUIntLE(height - 1, 7, 3)
  return riff('VP8X', payload)
}

describe('header-only image dimensions', () => {
  it('reads PNG IHDR', () => {
    expect(pngSize(pngHeader(512, 512))).toEqual({ width: 512, height: 512 })
    expect(pngSize(pngHeader(300, 200))).toEqual({ width: 300, height: 200 })
    expect(pngSize(Buffer.from('not a png at all, definitely not one'))).toBeNull()
  })
  it('reads the JPEG frame header for baseline and progressive frames, skipping other segments', () => {
    expect(jpegSize(jpegHeader(512, 512))).toEqual({ width: 512, height: 512 })
    expect(jpegSize(jpegHeader(800, 600, 0xc2))).toEqual({ width: 800, height: 600 })
    expect(jpegSize(Buffer.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02]))).toBeNull()
    expect(jpegSize(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x40]))).toBeNull() // truncated segment
  })
  it('reads WebP lossy, lossless and extended headers', () => {
    expect(webpSize(webpLossy(512, 512))).toEqual({ width: 512, height: 512 })
    expect(webpSize(webpLossless(1024, 768))).toEqual({ width: 1024, height: 768 })
    expect(webpSize(webpExtended(256, 256))).toEqual({ width: 256, height: 256 })
    const broken = webpLossy(512, 512); broken[23] = 0
    expect(webpSize(broken)).toBeNull()
  })
  it('dispatches by declared type, so a mismatched type never parses', () => {
    expect(imageSize(pngHeader(512, 512), 'image/png')).toEqual({ width: 512, height: 512 })
    expect(imageSize(pngHeader(512, 512), 'image/jpeg')).toBeNull()
    expect(imageSize(webpLossy(512, 512), 'image/png')).toBeNull()
  })
})
