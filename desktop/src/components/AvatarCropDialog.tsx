import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type WheelEvent } from 'react'
import FocusTrapDialog from './FocusTrapDialog.js'
import { Icon } from './Icon.js'
import {
  CROP_VIEWPORT, MAX_ZOOM, MIN_ZOOM, coverTransform, cropToCanvas, encodeAvatar, panTransform, sourceTooSmall, zoomTransform,
  type CropTransform,
} from '../lib/avatar-crop.js'
import type { AvatarSource } from '../lib/tauri.js'
import type { CustomAvatarImage } from '../lib/api.js'
import './AvatarCropDialog.css'

const MAX_UPLOAD_BYTES = 2 * 1024 * 1024

function base64ToBytes(value: string): ArrayBuffer {
  const binary = atob(value)
  const buffer = new ArrayBuffer(binary.length)
  const bytes = new Uint8Array(buffer)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return buffer
}

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  return btoa(binary)
}

/**
 * Square cover crop for a custom Skill avatar: 320px viewfinder, starts as cover,
 * drag to pan (never shows the background), wheel / slider zoom 1×–3×, arrow keys
 * nudge 1px. Output is 512×512 WebP 0.9 (JPEG 0.9 where WebP encoding is missing).
 * EXIF orientation is applied by `createImageBitmap`; animated images use the first frame.
 */
export default function AvatarCropDialog({ source, busy, onCancel, onConfirm }: {
  source: AvatarSource
  busy: boolean
  onCancel: () => void
  onConfirm: (image: CustomAvatarImage) => void
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const drag = useRef<{ x: number; y: number } | null>(null)
  const [bitmap, setBitmap] = useState<ImageBitmap | null>(null)
  const [zoom, setZoom] = useState(MIN_ZOOM)
  const [transform, setTransform] = useState<CropTransform | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [encoding, setEncoding] = useState(false)

  useEffect(() => {
    let active = true
    let decoded: ImageBitmap | null = null
    const blob = new Blob([base64ToBytes(source.dataBase64)], { type: source.mimeType })
    createImageBitmap(blob, { imageOrientation: 'from-image' }).then((image) => {
      decoded = image
      if (!active) { image.close(); return }
      if (sourceTooSmall(image.width, image.height)) { setError('图片太小，至少 256×256'); return }
      setBitmap(image)
      setTransform(coverTransform(image.width, image.height))
    }, () => { if (active) setError('无法读取这张图片，请换一张试试') })
    return () => { active = false; decoded?.close() }
  }, [source])

  useEffect(() => {
    const canvas = canvasRef.current
    const context = canvas?.getContext('2d')
    if (!canvas || !context || !bitmap || !transform) return
    const ratio = window.devicePixelRatio || 1
    canvas.width = CROP_VIEWPORT * ratio
    canvas.height = CROP_VIEWPORT * ratio
    context.setTransform(ratio, 0, 0, ratio, 0, 0)
    context.imageSmoothingQuality = 'high'
    context.clearRect(0, 0, CROP_VIEWPORT, CROP_VIEWPORT)
    context.drawImage(bitmap, transform.x, transform.y, bitmap.width * transform.scale, bitmap.height * transform.scale)
  }, [bitmap, transform])

  const pan = (dx: number, dy: number): void => {
    if (bitmap && transform) setTransform(panTransform(transform, bitmap.width, bitmap.height, dx, dy))
  }
  const zoomTo = (next: number, anchor?: { x: number; y: number }): void => {
    if (!bitmap || !transform) return
    const clamped = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next))
    setZoom(clamped)
    setTransform(zoomTransform(transform, bitmap.width, bitmap.height, clamped, anchor))
  }
  const onPointerDown = (event: PointerEvent<HTMLCanvasElement>): void => {
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = { x: event.clientX, y: event.clientY }
  }
  const onPointerMove = (event: PointerEvent<HTMLCanvasElement>): void => {
    if (!drag.current) return
    pan(event.clientX - drag.current.x, event.clientY - drag.current.y)
    drag.current = { x: event.clientX, y: event.clientY }
  }
  const onWheel = (event: WheelEvent<HTMLCanvasElement>): void => {
    const rect = event.currentTarget.getBoundingClientRect()
    zoomTo(zoom * Math.exp(-event.deltaY * 0.002), { x: event.clientX - rect.left, y: event.clientY - rect.top })
  }
  const onKeyDown = (event: KeyboardEvent<HTMLCanvasElement>): void => {
    const moves: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }
    const move = moves[event.key]
    if (move) { event.preventDefault(); pan(move[0], move[1]); return }
    if (event.key === '+' || event.key === '=') { event.preventDefault(); zoomTo(zoom + 0.1) }
    if (event.key === '-') { event.preventDefault(); zoomTo(zoom - 0.1) }
  }
  const confirm = async (): Promise<void> => {
    if (!bitmap || !transform || busy || encoding) return
    setEncoding(true)
    try {
      const canvas = cropToCanvas(bitmap, bitmap.width, bitmap.height, transform, () => document.createElement('canvas'))
      const encoded = await encodeAvatar(canvas)
      if (encoded.blob.size > MAX_UPLOAD_BYTES) throw new Error('裁剪后的图片超过 2 MB，请换一张试试')
      onConfirm({ mimeType: encoded.mimeType, dataBase64: await blobToBase64(encoded.blob) })
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : '无法处理图片，请换一张试试')
    } finally { setEncoding(false) }
  }
  const working = busy || encoding
  return <FocusTrapDialog className="modal-layer above-sheet" label="更换头像" onEscape={onCancel} escapeDisabled={working}>
    <div className="modal-card compact avatar-crop">
      <div className="modal-head"><div><span className="eyebrow">Skill 头像</span><h2>更换头像</h2></div><button type="button" className="ico-btn" onClick={onCancel} disabled={working} aria-label="关闭更换头像"><Icon name="x" size={16} /></button></div>
      {error ? <p className="banner banner-error" role="alert">{error}</p> : <>
        <div className="avatar-crop-frame" style={{ width: CROP_VIEWPORT, height: CROP_VIEWPORT }}>
          <canvas ref={canvasRef} className="avatar-crop-canvas" style={{ width: CROP_VIEWPORT, height: CROP_VIEWPORT }} tabIndex={0}
            role="img" aria-label="头像取景框，拖动或用方向键调整位置，滚轮缩放"
            onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={() => { drag.current = null }} onPointerCancel={() => { drag.current = null }}
            onWheel={onWheel} onKeyDown={onKeyDown} />
          {!bitmap && <span className="avatar-crop-loading">正在读取图片…</span>}
        </div>
        <label className="avatar-crop-zoom"><span>缩放</span><input type="range" min={MIN_ZOOM} max={MAX_ZOOM} step={0.01} value={zoom} disabled={!bitmap || working} aria-label="缩放" onChange={(event) => zoomTo(Number(event.target.value))} /></label>
        <p className="modal-copy avatar-crop-hint">头像会裁剪为正方形并填满，保存为 512×512。</p>
      </>}
      <div className="modal-actions"><button type="button" className="btn btn-ghost" onClick={onCancel} disabled={working}>取消</button><button type="button" className="btn btn-primary" onClick={() => void confirm()} disabled={!bitmap || Boolean(error) || working}>{working ? '上传中…' : '使用这张'}</button></div>
    </div>
  </FocusTrapDialog>
}
