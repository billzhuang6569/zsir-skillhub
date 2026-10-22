// Square cover crop for custom Skill avatars (#214). Pure geometry plus a canvas
// step that takes its canvas from the caller, so every rule is testable without a DOM.

/** On-screen square viewfinder, in CSS pixels. */
export const CROP_VIEWPORT = 320
/** Uploaded avatar size (the Server accepts 256–1024 px squares). */
export const CROP_OUTPUT = 512
/** Originals whose short side is below this cannot fill a sharp avatar. */
export const MIN_SOURCE_SIDE = 256
export const MIN_ZOOM = 1
export const MAX_ZOOM = 3
export const OUTPUT_QUALITY = 0.9

/**
 * Where the image sits inside the viewfinder: `scale` maps source pixels to viewport
 * pixels, `x / y` is the image's top-left corner in viewport pixels (≤ 0 when covering).
 */
export type CropTransform = { scale: number; x: number; y: number }

/** Cover: the short side fills the viewfinder and the image is centred. */
export function coverTransform(width: number, height: number, viewport = CROP_VIEWPORT): CropTransform {
  const scale = Math.max(viewport / width, viewport / height)
  return { scale, x: (viewport - width * scale) / 2, y: (viewport - height * scale) / 2 }
}

/** Keeps the viewfinder fully covered: the image never slides far enough to show the background. */
export function clampOffset(transform: CropTransform, width: number, height: number, viewport = CROP_VIEWPORT): CropTransform {
  const clamp = (value: number, size: number): number => Math.min(0, Math.max(viewport - size * transform.scale, value))
  return { scale: transform.scale, x: clamp(transform.x, width), y: clamp(transform.y, height) }
}

export function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Number.isFinite(zoom) ? zoom : MIN_ZOOM))
}

/**
 * Zoom (1×–3× of the cover scale) around a viewport point, keeping the source pixel
 * under that point in place, then clamping so the viewfinder stays covered.
 */
export function zoomTransform(transform: CropTransform, width: number, height: number, zoom: number,
  anchor: { x: number; y: number } = { x: CROP_VIEWPORT / 2, y: CROP_VIEWPORT / 2 }, viewport = CROP_VIEWPORT): CropTransform {
  const scale = coverTransform(width, height, viewport).scale * clampZoom(zoom)
  const sourceX = (anchor.x - transform.x) / transform.scale
  const sourceY = (anchor.y - transform.y) / transform.scale
  return clampOffset({ scale, x: anchor.x - sourceX * scale, y: anchor.y - sourceY * scale }, width, height, viewport)
}

/** Pans by a pointer or keyboard delta (arrow keys move 1px), clamped. */
export function panTransform(transform: CropTransform, width: number, height: number, dx: number, dy: number, viewport = CROP_VIEWPORT): CropTransform {
  return clampOffset({ ...transform, x: transform.x + dx, y: transform.y + dy }, width, height, viewport)
}

/** The source rectangle the viewfinder shows; always inside the image. */
export function cropRect(transform: CropTransform, width: number, height: number, viewport = CROP_VIEWPORT): { sx: number; sy: number; size: number } {
  const clamped = clampOffset(transform, width, height, viewport)
  const size = Math.min(viewport / clamped.scale, width, height)
  return {
    sx: Math.min(Math.max(0, -clamped.x / clamped.scale), width - size),
    sy: Math.min(Math.max(0, -clamped.y / clamped.scale), height - size),
    size,
  }
}

export function sourceTooSmall(width: number, height: number): boolean {
  return Math.min(width, height) < MIN_SOURCE_SIDE
}

type Context2D = {
  imageSmoothingEnabled: boolean
  imageSmoothingQuality: 'low' | 'medium' | 'high'
  drawImage: (image: never, sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, dw: number, dh: number) => void
}
export type CropCanvas = { width: number; height: number; getContext: (type: '2d') => Context2D | null }

/** Draws the viewfinder's source rectangle into a 512×512 canvas, filled edge to edge. */
export function cropToCanvas<C extends CropCanvas, I>(image: I, width: number, height: number, transform: CropTransform,
  createCanvas: () => C, output = CROP_OUTPUT, viewport = CROP_VIEWPORT): C {
  const canvas = createCanvas()
  canvas.width = output
  canvas.height = output
  const context = canvas.getContext('2d')
  if (!context) throw new Error('无法处理图片，请换一张试试')
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  const { sx, sy, size } = cropRect(transform, width, height, viewport)
  context.drawImage(image as never, sx, sy, size, size, 0, 0, output, output)
  return canvas
}

type BlobCanvas = { toBlob: (callback: (blob: Blob | null) => void, type: string, quality: number) => void }
export type EncodedAvatar = { mimeType: 'image/webp' | 'image/jpeg'; blob: Blob }

/** WebP 0.9; engines whose `toBlob` cannot write WebP fall back to JPEG 0.9. */
export async function encodeAvatar(canvas: BlobCanvas): Promise<EncodedAvatar> {
  const encode = (type: string): Promise<Blob | null> => new Promise((resolve) => canvas.toBlob(resolve, type, OUTPUT_QUALITY))
  const webp = await encode('image/webp')
  if (webp && webp.type === 'image/webp') return { mimeType: 'image/webp', blob: webp }
  const jpeg = await encode('image/jpeg')
  if (!jpeg) throw new Error('无法处理图片，请换一张试试')
  return { mimeType: 'image/jpeg', blob: jpeg }
}
