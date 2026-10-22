import type { ReactNode, Ref } from 'react'
import { blankDragRegion } from './WindowDragRegion.js'

type PageHeadingProps = {
  /** The page name, rendered as the page's only `<h1>`. */
  title: ReactNode
  beforeTitle?: ReactNode
  /** Muted one-liner after the title on wide windows, under it on narrow ones. */
  subtitle?: ReactNode
  /** Trailing controls (tabs, spacer, buttons), rendered after the heading in the title row. */
  actions?: ReactNode
  /** Extra classes on the title row, for page-specific wrapping. */
  className?: string
  /** The sticky head element, for pages that measure it. */
  headRef?: Ref<HTMLDivElement>
  /** Rows under the title row that stay in the sticky head (e.g. 我的 Skills' search bar). */
  children?: ReactNode
}

/**
 * One page head for 我的 Skills / 团队共享 / My Team / Skill 商店 / 钥匙 / 设置:
 * the same title font, subtitle and spacing everywhere. The head containers
 * stay window drag blank; the title text and the actions are not marked.
 */
export function PageHeading({ title, beforeTitle, subtitle, actions, className, headRef, children }: PageHeadingProps) {
  return <div className="page-head" {...blankDragRegion()} ref={headRef}>
    <div className="page-head-inner" {...blankDragRegion()}>
      {beforeTitle}
      <div className={['page-title-row', className ?? ''].filter(Boolean).join(' ')} {...blankDragRegion()}>
        <div className="page-heading">
          <h1>{title}</h1>
          {subtitle && <span className="page-subtitle">{subtitle}</span>}
        </div>
        {actions}
      </div>
      {children}
    </div>
  </div>
}
