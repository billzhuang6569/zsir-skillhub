import MarkdownIt from 'markdown-it'
import { allowedTopicImageUrl } from './topic-article.ts'
import type { MediaContext } from './media.ts'

// Raw HTML stays disabled so SKILL.md text can never inject markup or
// scripts; markdown-it escapes it and rejects javascript:/vbscript:/file:
// link targets by default.
const renderer = new MarkdownIt({ html: false, linkify: true, breaks: false })

// Skill documents are third-party content. Loading their images would reach
// remote hosts (tracking) or arbitrary local paths, so images render as a
// labelled placeholder instead.
renderer.renderer.rules.image = (tokens, index) => {
  const token = tokens[index]
  const alt = renderer.utils.escapeHtml(token?.content || '图片')
  const source = renderer.utils.escapeHtml(token?.attrGet('src') ?? '')
  return `<span class="markdown-image-placeholder" title="${source}">图片：${alt}</span>`
}

export function renderSkillMarkdown(source: string): string {
  return renderer.render(source)
}

// Topic article fragments (#213): the same safe renderer settings, with three differences.
// Images from SkillHub's own image host are shown (others keep the placeholder); links
// are kept only for http(s), so a `skill:` link in an ordinary paragraph reads as plain
// text; and `#` renders as h2 because the article's only h1 is the topic title.
const topicRenderer = new MarkdownIt({ html: false, linkify: true, breaks: false })
topicRenderer.renderer.rules.image = (tokens, index, _options, env: { media?: MediaContext | null }) => {
  const token = tokens[index]
  const src = allowedTopicImageUrl(token?.attrGet('src') ?? '', env.media)
  const alt = topicRenderer.utils.escapeHtml(token?.content ?? '')
  if (src) return `<img src="${topicRenderer.utils.escapeHtml(src)}" alt="${alt}" loading="lazy" referrerpolicy="no-referrer">`
  return `<span class="markdown-image-placeholder" title="${topicRenderer.utils.escapeHtml(token?.attrGet('src') ?? '')}">图片：${alt || '图片'}</span>`
}
const keepsLink = (href: string | null | undefined): boolean => /^https?:\/\//iu.test((href ?? '').trim())
topicRenderer.renderer.rules.link_open = (tokens, index, options, _env, self) => {
  const token = tokens[index]
  if (!token || !keepsLink(token.attrGet('href'))) { if (token) token.meta = { ...(token.meta as object | null), dropped: true }; return '' }
  return self.renderToken(tokens, index, options)
}
topicRenderer.renderer.rules.link_close = (tokens, index, options, _env, self) => {
  // The matching link_open is the nearest earlier one at the same nesting level.
  for (let back = index - 1; back >= 0; back -= 1) {
    const token = tokens[back]
    if (token?.type === 'link_open' && token.level === tokens[index]?.level) return (token.meta as { dropped?: boolean } | null)?.dropped ? '' : self.renderToken(tokens, index, options)
  }
  return self.renderToken(tokens, index, options)
}
const demoteH1 = (tag: string): string => tag === 'h1' ? 'h2' : tag
topicRenderer.renderer.rules.heading_open = (tokens, index, options, _env, self) => { const token = tokens[index]; if (token) token.tag = demoteH1(token.tag); return self.renderToken(tokens, index, options) }
topicRenderer.renderer.rules.heading_close = (tokens, index, options, _env, self) => { const token = tokens[index]; if (token) token.tag = demoteH1(token.tag); return self.renderToken(tokens, index, options) }

export function renderTopicMarkdown(source: string, media?: MediaContext | null): string {
  return topicRenderer.render(source, { media })
}

export type MarkdownLinkTarget =
  | { kind: 'external'; url: string }
  | { kind: 'skill-file'; path: string }
  | { kind: 'ignored' }

/**
 * Classifies a clicked link. Web links open in the system browser; relative
 * links that name another file of the same Skill open its preview; anything
 * else (anchors, mailto:, file:, paths escaping the Skill) does nothing.
 * `fromPath` is the Skill-relative path of the document being read.
 */
export function classifyMarkdownLink(
  href: string,
  skillFiles: readonly string[],
  fromPath = 'SKILL.md',
): MarkdownLinkTarget {
  const trimmed = href.trim()
  if (/^https?:\/\//iu.test(trimmed)) return { kind: 'external', url: trimmed }
  if (trimmed.length === 0 || trimmed.startsWith('#') || /^[a-z][a-z0-9+.-]*:/iu.test(trimmed) || trimmed.startsWith('/')) {
    return { kind: 'ignored' }
  }
  let decoded: string
  try {
    decoded = decodeURIComponent(trimmed.split(/[?#]/u)[0] ?? '')
  } catch {
    return { kind: 'ignored' }
  }
  const segments = fromPath.split('/').slice(0, -1)
  for (const segment of decoded.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (segments.length === 0) return { kind: 'ignored' }
      segments.pop()
      continue
    }
    segments.push(segment)
  }
  const path = segments.join('/')
  return skillFiles.includes(path) ? { kind: 'skill-file', path } : { kind: 'ignored' }
}

export function isMarkdownPath(path: string): boolean {
  return /\.(md|markdown|mdx)$/iu.test(path)
}
