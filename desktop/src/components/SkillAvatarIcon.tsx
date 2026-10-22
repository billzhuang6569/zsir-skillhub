import { useState } from 'react'
import { useMediaUrl } from '../lib/media.js'

type Props = { avatarUrl?: string | null; status?: string | null; size?: number; className?: string }

/**
 * Shows the permanent image when it exists, otherwise a neutral placeholder.
 * Background generation is silent: task states never change the placeholder,
 * add status badges, or announce operational details to assistive technology.
 */
export function SkillAvatarIcon({ avatarUrl, size = 42, className = 'skill-cat-icon' }: Props) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  const url = useMediaUrl(avatarUrl)
  const showImage = Boolean(url && failedUrl !== url)
  return <span className={className} aria-hidden="true"
    data-skill-avatar={showImage ? 'image' : 'placeholder'}
    style={{ width: size, height: size, display: 'grid', placeItems: 'center', overflow: 'hidden', position: 'relative',
      flexShrink: 0, background: 'var(--color-surface-sunken)', color: 'var(--color-muted)' }}>
    {showImage
      ? <img src={url!} alt="" referrerPolicy="no-referrer" onError={() => setFailedUrl(url)}
          style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
      : <svg width={Math.round(size * 0.48)} height={Math.round(size * 0.48)} viewBox="0 0 24 24" fill="currentColor">
          <circle cx="9" cy="9" r="5" opacity=".45"/><path d="M5 19c2-6 7-9 14-9v9Z" opacity=".65"/>
        </svg>}
  </span>
}
