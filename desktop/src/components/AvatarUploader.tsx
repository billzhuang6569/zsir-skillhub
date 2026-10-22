import { userMessage } from '../lib/user-message.js'
import { useEffect, useState } from 'react'
import { pickAndUploadAvatar } from '../lib/tauri.js'
import { readAuthSpace, useStore } from '../store/index.js'
import { Icon } from './Icon.js'
import { useMediaUrl } from '../lib/media.js'
import './AvatarUploader.css'

export type AvatarUploaderProps = {
  avatarUrl?: string | null
  fallbackText: string
  label: string
  variant?: 'circle' | 'rounded'
  size?: 'small' | 'medium' | 'large'
  disabled?: boolean
  allowRemove?: boolean
  fallbackColor?: string
  className?: string
  onPersist: (url: string | null) => Promise<void>
  onError?: (message: string) => void
}

function messageOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.trim() || '头像上传失败，请稍后重试'
}

function fallbackInitial(value: string): string {
  return Array.from(value.trim())[0]?.toLocaleUpperCase() ?? 'U'
}

export default function AvatarUploader({
  avatarUrl,
  fallbackText,
  label,
  variant = 'rounded',
  size = 'medium',
  disabled = false,
  allowRemove = true,
  fallbackColor,
  className = '',
  onPersist,
  onError,
}: AvatarUploaderProps) {
  const [busy, setBusy] = useState(false)
  const [imageFailed, setImageFailed] = useState(false)
  const [status, setStatus] = useState('')
  const displayUrl = useMediaUrl(avatarUrl)

  useEffect(() => setImageFailed(false), [displayUrl])

  const reportError = (error: unknown): void => {
    const message = messageOf(error)
    setStatus(message)
    onError?.(message)
  }

  const chooseAvatar = async (): Promise<void> => {
    if (busy || disabled) return
    setBusy(true)
    setStatus('')
    try {
      const space = readAuthSpace()
      const userId = useStore.getState().currentUser?.id
      if (!space || !userId) throw new Error('请登录后上传头像')
      const uploaded = await pickAndUploadAvatar(userId)
      if (!uploaded) return
      if (readAuthSpace() !== space) throw new Error('账号已切换，请重新上传')
      await onPersist(uploaded.url)
      setStatus('头像已更新')
    } catch (error: unknown) {
      reportError(error)
    } finally {
      setBusy(false)
    }
  }

  const removeAvatar = async (): Promise<void> => {
    if (busy || disabled || !avatarUrl) return
    setBusy(true)
    setStatus('')
    try {
      await onPersist(null)
      setStatus('头像已移除')
    } catch (error: unknown) {
      reportError(error)
    } finally {
      setBusy(false)
    }
  }

  const classes = [
    'avatar-uploader',
    `avatar-uploader-${variant}`,
    `avatar-uploader-${size}`,
    className,
  ].filter(Boolean).join(' ')

  return <span className={classes} aria-busy={busy}>
    <button
      type="button"
      className="avatar-uploader-picker"
      disabled={disabled || busy}
      aria-label={busy ? `正在上传${label}` : `选择${label}`}
      title={`点击选择${label}`}
      style={fallbackColor ? { backgroundColor: fallbackColor, color: '#fff' } : undefined}
      onClick={() => void chooseAvatar()}
    >
      {displayUrl && !imageFailed
        ? <img src={displayUrl} alt="" decoding="async" referrerPolicy="no-referrer" onError={() => setImageFailed(true)} />
        : <span className="avatar-uploader-fallback" aria-hidden="true">{fallbackInitial(fallbackText)}</span>}
      <span className="avatar-uploader-action" aria-hidden="true">
        {busy ? <span className="avatar-uploader-spinner" /> : <Icon name="plus" size={12} />}
      </span>
    </button>
    {allowRemove && avatarUrl && <button
      type="button"
      className="avatar-uploader-remove"
      disabled={disabled || busy}
      aria-label={`移除${label}`}
      title={`移除${label}`}
      onClick={() => void removeAvatar()}
    ><Icon name="x" size={11} /></button>}
    <span className="avatar-uploader-status" aria-live="polite">{status}</span>
  </span>
}
