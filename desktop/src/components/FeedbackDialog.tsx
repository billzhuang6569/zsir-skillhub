import { userMessage } from '../lib/user-message.js'
import { useRef, useState, type DragEvent, type FormEvent } from 'react'
import {
  apiSubmitFeedback,
  type FeedbackAttachmentInput,
  type FeedbackType,
} from '../lib/api.js'
import FocusTrapDialog from './FocusTrapDialog.js'
import { Icon } from './Icon.js'
import { toast } from './Toast.js'
import { useStore } from '../store/index.js'
import './FeedbackDialog.css'

type Props = { onClose: () => void; defaultContact?: string }

type PendingAttachment = FeedbackAttachmentInput & {
  id: string
  size: number
}

const MAX_ATTACHMENTS = 3
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024
const ACCEPTED_IMAGE_TYPES = new Set<FeedbackAttachmentInput['mimeType']>([
  'image/jpeg',
  'image/png',
  'image/webp',
])

function messageOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (message === 'Too many feedback submissions. Try again later.') return '提交次数较多，请稍后再试'
  if (message === 'Invalid feedback data') return '请检查反馈内容后重试'
  if (message === 'Invalid feedback attachment') return '图片无法读取，请使用 JPG、PNG 或 WebP 后重试'
  return message || '暂时无法提交反馈'
}

function bytesToBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return window.btoa(binary)
}

async function prepareAttachment(file: File): Promise<PendingAttachment> {
  if (!ACCEPTED_IMAGE_TYPES.has(file.type as FeedbackAttachmentInput['mimeType'])) {
    throw new Error('仅支持 JPG、PNG 或 WebP 图片')
  }
  if (file.size <= 0 || file.size > MAX_ATTACHMENT_BYTES) {
    throw new Error('每张图片需要小于 5 MB')
  }
  const mimeType = file.type as FeedbackAttachmentInput['mimeType']
  return {
    id: crypto.randomUUID(),
    fileName: file.name || `feedback-${Date.now()}.${mimeType.split('/')[1]}`,
    mimeType,
    size: file.size,
    dataBase64: bytesToBase64(new Uint8Array(await file.arrayBuffer())),
  }
}

export default function FeedbackDialog({ onClose, defaultContact }: Props) {
  const currentUser = useStore(state => state.currentUser)
  const [type, setType] = useState<FeedbackType>('usage')
  const [content, setContent] = useState('')
  const [contact, setContact] = useState(() => defaultContact?.trim() ?? '')
  const [attachments, setAttachments] = useState<PendingAttachment[]>([])
  const [dragActive, setDragActive] = useState(false)
  const [addingImages, setAddingImages] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const addingImagesRef = useRef(false)
  const operationRef = useRef<{ type: FeedbackType; content: string; contact: string; attachments: PendingAttachment[]; id: string } | null>(null)

  const addFiles = async (files: readonly File[]): Promise<void> => {
    if (!currentUser) { setError('登录后可附上截图，也可直接提交文字反馈'); return }
    if (addingImagesRef.current) return
    const candidates = files.filter((file) => file.type.startsWith('image/'))
    if (candidates.length === 0) {
      setError('请粘贴或拖入 JPG、PNG、WebP 图片')
      return
    }
    if (attachments.length + candidates.length > MAX_ATTACHMENTS) {
      setError(`最多添加 ${MAX_ATTACHMENTS} 张图片`)
      return
    }
    addingImagesRef.current = true
    setAddingImages(true)
    setError(null)
    try {
      const prepared = await Promise.all(candidates.map(prepareAttachment))
      setAttachments((current) => [...current, ...prepared].slice(0, MAX_ATTACHMENTS))
    } catch (reason: unknown) {
      setError(messageOf(reason))
    } finally {
      addingImagesRef.current = false
      setAddingImages(false)
    }
  }

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    const normalizedContent = content.trim()
    if (!normalizedContent) { setError('请填写反馈信息'); return }
    const normalizedContact = contact.trim()
    const previous = operationRef.current
    if (!previous || previous.type !== type || previous.content !== normalizedContent || previous.contact !== normalizedContact || previous.attachments !== attachments) {
      operationRef.current = { type, content: normalizedContent, contact: normalizedContact, attachments, id: crypto.randomUUID() }
    }
    const clientOperationId = operationRef.current!.id
    setSubmitting(true)
    setError(null)
    try {
      await apiSubmitFeedback({
        type,
        content: normalizedContent,
        contact: normalizedContact || undefined,
        attachments: attachments.map(({ fileName, mimeType, dataBase64 }) => ({ fileName, mimeType, dataBase64 })),
        clientOperationId,
      })
      onClose()
      window.setTimeout(() => toast('反馈已提交，感谢你的帮助'), 0)
    } catch (reason: unknown) {
      setError(messageOf(reason))
    } finally {
      setSubmitting(false)
    }
  }

  const onDrop = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault()
    setDragActive(false)
    if (!submitting && !addingImages) void addFiles(Array.from(event.dataTransfer.files))
  }

  const busy = submitting || addingImages
  return <FocusTrapDialog className="modal-layer feedback-dialog-layer" label="提交产品反馈" onEscape={() => !busy && onClose()} escapeDisabled={busy} closeOnBackdrop>
    <form
      className="modal-card compact feedback-dialog"
      onSubmit={(event) => void submit(event)}
      onPaste={(event) => {
        const files = Array.from(event.clipboardData.items)
          .filter((item) => item.kind === 'file')
          .map((item) => item.getAsFile())
          .filter((file): file is File => Boolean(file))
        if (files.length > 0) {
          event.preventDefault()
          void addFiles(files)
        }
      }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="modal-head"><div><span className="eyebrow">产品反馈</span><h2>告诉我们哪里需要改进</h2></div><button type="button" className="ico-btn" disabled={busy} onClick={onClose} aria-label="关闭反馈窗口"><Icon name="x" size={16} /></button></div>
      <div className="form-stack">
        <label><span>类型</span><select value={type} onChange={(event) => setType(event.target.value as FeedbackType)}><option value="usage">使用问题</option><option value="bug">Bug</option><option value="feature">功能建议</option><option value="other">其他</option></select></label>
        <label><span>反馈信息</span><textarea autoFocus required rows={6} maxLength={2000} value={content} onChange={(event) => { setContent(event.target.value); setError(null) }} placeholder="请描述你遇到的情况，或希望 SkillHub 如何改进" /><small>{content.length}/2000</small></label>
        <div
          className={`feedback-dropzone${dragActive ? ' active' : ''}`}
          onDragEnter={(event) => { event.preventDefault(); setDragActive(true) }}
          onDragOver={(event) => event.preventDefault()}
          onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragActive(false) }}
          onDrop={onDrop}
        >
          <input ref={fileInputRef} type="file" accept="image/png,image/jpeg,image/webp" multiple hidden onChange={(event) => { void addFiles(Array.from(event.target.files ?? [])); event.currentTarget.value = '' }} />
          <Icon name="image" size={18} />
          <div><b>{addingImages ? '正在读取图片…' : currentUser ? '粘贴或拖入截图' : '登录后可附上截图'}</b><span>JPG、PNG、WebP，每张不超过 5 MB，最多 3 张</span></div>
          <button type="button" className="btn btn-ghost btn-sm" disabled={!currentUser || busy || attachments.length >= MAX_ATTACHMENTS} onClick={() => fileInputRef.current?.click()}>选择图片</button>
        </div>
        {attachments.length > 0 && <div className="feedback-attachments" aria-label="已添加的反馈图片">{attachments.map((attachment) => <div key={attachment.id} className="feedback-attachment">
          <img src={`data:${attachment.mimeType};base64,${attachment.dataBase64}`} alt="" />
          <span title={attachment.fileName}>{attachment.fileName}</span>
          <button type="button" className="ico-btn" disabled={submitting} onClick={() => setAttachments((current) => current.filter((item) => item.id !== attachment.id))} aria-label={`移除图片 ${attachment.fileName}`}><Icon name="x" size={12} /></button>
        </div>)}</div>}
        <label><span>联系方式 <em>选填</em></span><input maxLength={200} value={contact} onChange={(event) => setContact(event.target.value)} placeholder="邮箱、微信或其他方便联系的方式" /></label>
      </div>
      {error && <div className="banner banner-error feedback-error" role="alert"><Icon name="warn" size={14} />{error}</div>}
      <div className="modal-actions"><button type="button" className="btn btn-ghost" disabled={busy} onClick={onClose}>取消</button><button type="submit" className="btn btn-primary" disabled={busy || !content.trim()}>{submitting ? '正在提交…' : '提交反馈'}</button></div>
    </form>
  </FocusTrapDialog>
}
