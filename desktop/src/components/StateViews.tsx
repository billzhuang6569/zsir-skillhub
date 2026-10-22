import type { CSSProperties, ReactNode } from 'react'
import { Icon, type IconName } from './Icon.js'
import { RETRY_LABEL, type StateCopy } from '../lib/state-copy.js'
import './StateViews.css'

/**
 * Shared empty / error / loading views (#263). Copy comes from lib/state-copy.ts;
 * loading is a layout-matching skeleton (1.4s pulse, static under reduced motion), never a spinner.
 */

type EmptyStateProps = {
  copy: StateCopy
  icon?: IconName
  compact?: boolean
  /** `inline`: a one-line dashed note inside panels and dialogs (`.compact-empty`). */
  variant?: 'block' | 'inline'
  className?: string
  /** The next-step button(s). */
  children?: ReactNode
}

export function EmptyState({ copy, icon, compact = false, variant = 'block', className, children }: EmptyStateProps) {
  if (variant === 'inline') return <div className={['compact-empty state-inline', className ?? ''].filter(Boolean).join(' ')}>
    <b>{copy.title}</b><span>{copy.hint}</span>{children}
  </div>
  return <div className={['empty-state', compact ? 'compact' : '', className ?? ''].filter(Boolean).join(' ')}>
    {icon && <div className="empty-icon" aria-hidden="true"><Icon name={icon} size={compact ? 22 : 24} /></div>}
    <h3>{copy.title}</h3>
    <p>{copy.hint}</p>
    {children}
  </div>
}

type LoadErrorProps = {
  /** Usually `loadFailedMessage(subject, reason)`. */
  message: string
  onRetry: () => void
  retrying?: boolean
  /** `inline`: no banner frame, for narrow panels. */
  variant?: 'banner' | 'inline'
  className?: string
}

/** 「<对象>加载失败：原因」+ 重试, announced as an alert. */
export function LoadError({ message, onRetry, retrying = false, variant = 'banner', className }: LoadErrorProps) {
  return <div className={[variant === 'inline' ? 'load-error load-error-inline' : 'banner banner-error load-error', className ?? ''].filter(Boolean).join(' ')} role="alert">
    <Icon name="warn" size={15} />
    <div className="load-error-body"><span>{message}</span><button type="button" className="link-button" disabled={retrying} onClick={onRetry}>{RETRY_LABEL}</button></div>
  </div>
}

type SkeletonProps = { width?: number | string; height?: number | string; radius?: number | string; className?: string; style?: CSSProperties }

/** One pulsing placeholder block. Decorative: the surrounding status carries the text. */
export function Skeleton({ width, height = 12, radius, className, style }: SkeletonProps) {
  return <span className={['skeleton', className ?? ''].filter(Boolean).join(' ')} aria-hidden="true" style={{ width, height, borderRadius: radius, ...style }} />
}

export type SkeletonLayout = 'rows' | 'cards' | 'text' | 'detail'

type SkeletonBlockProps = {
  layout: SkeletonLayout
  /** Read by screen readers instead of the visual skeleton. */
  label: string
  count?: number
  compact?: boolean
  className?: string
}

const DEFAULT_COUNT: Record<SkeletonLayout, number> = { rows: 5, cards: 3, text: 6, detail: 1 }
const TEXT_WIDTHS = ['92%', '78%', '86%', '64%', '88%', '52%']

/**
 * Layout-matching loading placeholder:
 * - rows: the SkillLibraryList / list rows (avatar + two lines + trailing action)
 * - cards: team / store card grid
 * - text: SKILL.md / file preview paragraphs
 * - detail: a sheet head (avatar + title) followed by text
 */
export function SkeletonBlock({ layout, label, count, compact = false, className }: SkeletonBlockProps) {
  const total = count ?? DEFAULT_COUNT[layout]
  const items = Array.from({ length: total }, (_, index) => index)
  return <div className={['skeleton-block', `skeleton-${layout}`, compact ? 'compact' : '', className ?? ''].filter(Boolean).join(' ')} role="status" aria-live="polite" data-skeleton={layout}>
    <span className="sr-only">{label}</span>
    {layout === 'rows' && items.map((index) => <div className="skeleton-row" key={index} aria-hidden="true">
      <Skeleton width={44} height={44} radius={13} />
      <span className="skeleton-lines"><Skeleton width={`${46 + ((index * 17) % 30)}%`} height={14} /><Skeleton width={`${70 + ((index * 11) % 22)}%`} height={11} /></span>
      <Skeleton width={64} height={28} radius={10} />
    </div>)}
    {layout === 'cards' && items.map((index) => <div className="skeleton-card" key={index} aria-hidden="true">
      <span className="skeleton-card-head"><Skeleton width={44} height={44} radius={13} /><span className="skeleton-lines"><Skeleton width="62%" height={14} /><Skeleton width="38%" height={11} /></span></span>
      <Skeleton width="92%" height={11} /><Skeleton width="70%" height={11} />
    </div>)}
    {layout === 'text' && items.map((index) => <Skeleton key={index} width={TEXT_WIDTHS[index % TEXT_WIDTHS.length]} height={index === 0 ? 18 : 12} />)}
    {layout === 'detail' && <>
      <div className="skeleton-card-head" aria-hidden="true"><Skeleton width={56} height={56} radius={16} /><span className="skeleton-lines"><Skeleton width="44%" height={18} /><Skeleton width="68%" height={12} /></span></div>
      {TEXT_WIDTHS.slice(0, 4).map((width, index) => <Skeleton key={index} width={width} height={12} />)}
    </>}
  </div>
}
