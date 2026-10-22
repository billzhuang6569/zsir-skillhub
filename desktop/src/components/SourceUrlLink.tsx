import type { MouseEvent } from 'react'
import { Icon } from './Icon.js'
import { describeSourceUrl, type SourceUrlKind } from '../lib/source-url.js'

/**
 * Brand marks for the two sites Lucide no longer ships; parsed locally from
 * the URL, never fetched. Other sites use the shared Lucide icons.
 */
const BRAND_PATHS: Partial<Record<SourceUrlKind, string>> = {
  x: 'M17.75 3h3.07l-6.7 7.66L22 21h-6.17l-4.83-6.32L5.47 21H2.4l7.17-8.2L2 3h6.33l4.37 5.77L17.75 3Zm-1.08 16.17h1.7L7.4 4.73H5.57l11.1 14.44Z',
  github: 'M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.7c-2.78.6-3.37-1.34-3.37-1.34-.45-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.61.07-.61 1 .07 1.53 1.03 1.53 1.03.9 1.52 2.34 1.08 2.91.83.09-.65.35-1.09.63-1.34-2.22-.25-4.55-1.11-4.55-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.64 0 0 .84-.27 2.75 1.02a9.5 9.5 0 0 1 5 0c1.91-1.29 2.75-1.02 2.75-1.02.55 1.37.2 2.39.1 2.64.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.68-4.57 4.93.36.31.68.92.68 1.85v2.75c0 .27.18.58.69.48A10 10 0 0 0 12 2Z',
}

export function SourceSiteIcon({ kind, size = 12 }: { kind: SourceUrlKind; size?: number }) {
  const brand = BRAND_PATHS[kind]
  if (brand) {
    return <svg className="source-url-icon" width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d={brand} /></svg>
  }
  return <Icon name={kind === 'generic' ? 'link' : 'package'} size={size} className="source-url-icon" />
}

/**
 * 「来源」 link for the detail header meta row (#330): site icon + name + short
 * summary, the full target in the tooltip, opened in the system browser.
 * Renders nothing for a missing, blank or non-http(s) value.
 */
export function SourceUrlLink({ url, onOpen, leadingDot = false }: { url: string | null | undefined; onOpen: (href: string) => void; leadingDot?: boolean }) {
  const source = describeSourceUrl(url)
  if (!source) return null
  const text = source.detail ? `${source.label} ${source.detail}` : source.label
  const open = (event: MouseEvent<HTMLAnchorElement>): void => {
    event.preventDefault()
    onOpen(source.href)
  }
  // The separator stays with the link, so a narrow window wraps 「· 来源 …」 as one unit.
  return <>
    <span className="sh-origin-source-url">
      {leadingDot && <span className="sh-origin-dot" aria-hidden="true">·</span>}
      <span className="sh-origin-source-url-label">来源</span>
      <a className="source-url-link" data-source-kind={source.kind} href={source.href} title={source.href} aria-label={`来源：${text}，在浏览器中打开 ${source.href}`} target="_blank" rel="noopener noreferrer" onClick={open}>
        <SourceSiteIcon kind={source.kind} />
        <span className="source-url-name">{source.label}</span>
        {source.detail && <span className="source-url-detail">{source.detail}</span>}
      </a>
    </span>
  </>
}
