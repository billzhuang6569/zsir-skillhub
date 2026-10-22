#!/usr/bin/env node
import { readdir, readFile, realpath } from 'node:fs/promises'
import { isIP } from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const privatePath = /(?:^|[/\\\s`"'(])(?:landing-page|donation-service|design-reference|\.seecode|diagrams|\.secrets)(?:[/\\]|$)|(?:^|[/\\\s`"'(])docs[/\\](?:CURRENT\.md|operations(?:[/\\]|$)|plans(?:[/\\]|$)|releases(?:[/\\]|$))/i
const closedSymbol = /zpay|DONATION_|DonationOrder|donationOrders|apiCreateDonationOrder/i
const groups = new Set(['getting-started', 'official', 'self-host', 'ai-and-avatars', 'guides', 'account-and-data', 'reference'])

function proseOnly(text) {
  let fence = null
  return text.replace(/<!--[\s\S]*?-->/g, '').split('\n').map((line) => {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/)
    if (marker) {
      if (!fence) fence = marker[1]
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null
      return ''
    }
    return fence || /^(?: {4}|\t)/.test(line) ? '' : line
  }).join('\n')
}

function scalar(value) {
  if (/^"(?:[^"\\]|\\.)*"$/.test(value)) {
    try { return JSON.parse(value) } catch { return null }
  }
  if (/^'(?:[^']|'')*'$/.test(value)) return value.slice(1, -1).replaceAll("''", "'")
  if (!value || /^(?:[>|*&!{[]|null$|true$|false$|\d+$)/.test(value) || /:\s|\s#/.test(value)) return null
  return value
}

function frontmatter(text, fail) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)
  if (!match) {
    fail('frontmatter', '缺少开头的 YAML frontmatter')
    return { body: text, title: null }
  }
  const fields = new Map()
  let order
  let inSidebar = false
  for (const line of match[1].split(/\r?\n/)) {
    if (!line.trim()) continue
    const nested = line.match(/^ {2}order: ([0-9]+)\s*$/)
    if (inSidebar && nested && order === undefined) {
      order = Number(nested[1])
      continue
    }
    inSidebar = false
    const entry = line.match(/^(title|description|sidebar):(?: (.*))?$/)
    if (!entry || fields.has(entry[1])) {
      fail('frontmatter', `不支持或重复的 frontmatter 行：${line}`)
      continue
    }
    fields.set(entry[1], entry[2] ?? '')
    if (entry[1] === 'sidebar') {
      const inline = (entry[2] ?? '').match(/^\{\s*order:\s*(\d+)\s*\}$/)
      if (inline) order = Number(inline[1])
      else if (!entry[2]) inSidebar = true
    }
  }
  const title = scalar(fields.get('title') ?? '')
  const description = scalar(fields.get('description') ?? '')
  if (typeof title !== 'string' || !title.trim() || !/\p{Script=Han}/u.test(title)) fail('frontmatter', 'title 必须是非空中文单行字符串')
  if (typeof description !== 'string' || !description.trim() || /[\r\n]/.test(description)) fail('frontmatter', 'description 必须是非空单行字符串')
  if (!Number.isSafeInteger(order) || order < 0) fail('frontmatter', 'sidebar.order 必须是非负安全整数')
  return { body: text.slice(match[0].length), title }
}

function headingIds(prose, fail) {
  const ids = new Set()
  const lines = prose.split('\n')
  for (let index = 0; index < lines.length; index++) {
    const atx = lines[index].match(/^ {0,3}#{1,6}\s+(.+?)(?:\s+#+)?\s*$/)
    const setext = index + 1 < lines.length && /^ {0,3}(?:=+|-+)\s*$/.test(lines[index + 1]) && lines[index].trim()
    if (!atx && !setext) continue
    const heading = atx ? atx[1] : lines[index++].trim()
    const explicit = heading.match(/\s+\{#([A-Za-z][\w-]*)\}$/)
    let id
    if (explicit) {
      id = explicit[1]
      if (ids.has(id)) fail('anchor-duplicate', `重复锚点：${id}`)
    } else {
      // Authored headings stay plain text; stable app targets use ASCII slugs.
      const base = heading.toLowerCase()
        .replace(/!?\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/<[^>]*>/g, '')
        .replace(/[`*~]/g, '')
        .replace(/[^\p{L}\p{M}\p{N}_\-\s]/gu, '')
        .replace(/\s/g, '-')
      id = base
      let suffix = 0
      while (ids.has(id)) id = `${base}-${++suffix}`
    }
    ids.add(id)
  }
  return [...ids]
}

function destinations(prose, fail) {
  const links = []
  const definitions = new Map()
  const normalizeLabel = (label) => label.trim().replace(/\s+/g, ' ').toLowerCase()
  const destination = (raw) => {
    const value = raw.trim()
    if (value.startsWith('<')) return value.match(/^<([^>]*)>/)?.[1]
    return value.match(/^((?:\\.|[^\s])+)/)?.[1]?.replace(/\\([\\()[\]])/g, '$1')
  }
  const content = prose.replace(/^ {0,3}\[([^\]]+)\]:\s*(.+)$/gm, (_, label, raw) => {
    const href = destination(raw)
    if (!href) fail('link-format', `无效引用链接：${label}`)
    else {
      definitions.set(normalizeLabel(label), href)
      links.push(href)
    }
    return ''
  }).replace(/(`+)[\s\S]*?\1/g, '')
  // Read balanced inline destinations, including parentheses in external URLs.
  for (const match of content.matchAll(/!?\[([^\]\n]+)\](?:\(|\[([^\]\n]*)\])?/g)) {
    const end = match.index + match[0].length
    if (match[0].endsWith('(')) {
      let depth = 1
      let cursor = end
      for (; cursor < content.length && depth; cursor++) {
        if (content[cursor] === '\\') { cursor++; continue }
        if (content[cursor] === '(') depth++
        if (content[cursor] === ')') depth--
      }
      if (depth) fail('link-format', '链接括号未闭合')
      else {
        const href = destination(content.slice(end, cursor - 1))
        if (href) links.push(href)
        else fail('link-format', '链接目标为空')
      }
    } else {
      const label = normalizeLabel(match[2] || match[1])
      const href = definitions.get(label)
      if (href) links.push(href)
      else if (match[2] !== undefined) fail('link-format', `引用链接未定义：${label}`)
    }
  }
  for (const match of content.matchAll(/\b(?:href|src)\s*=\s*["']([^"']+)["']/gi)) links.push(match[1])
  for (const match of content.matchAll(/<(https?:\/\/[^>\s]+)>/g)) links.push(match[1])
  return links
}

function decode(value) {
  try { return decodeURIComponent(value) } catch { return null }
}

/**
 * Check a standalone guide tree. No network, rendering, or document commands run.
 * @returns {Promise<{ok: boolean, errors: {path: string, code: string, message: string}[], warnings: {path: string, code: string, message: string}[], pages: {path: string, slug: string, title: string|null, anchors: string[]}[]}>}
 */
export async function checkGuide(root, { release = false } = {}) {
  const base = path.resolve(root)
  const errors = []
  const warnings = []
  const pages = []
  const documents = new Map()
  const slugs = new Set()
  const add = (file, code, message) => errors.push({ path: file, code, message })
  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(directory, entry.name)
      const relative = path.relative(base, absolute).split(path.sep).join('/')
      if (entry.isSymbolicLink()) { add(relative, 'symlink', '文档树不允许符号链接'); continue }
      if (entry.isDirectory()) { await walk(absolute); continue }
      if (!entry.name.endsWith('.md')) { add(relative, 'file-format', '文档树只接受 .md 文件'); continue }
      const fail = (code, message) => add(relative, code, message)
      const slug = path.basename(relative, '.md')
      const parts = relative.split('/')
      if (!(relative === 'index.md' || relative === 'README.md')
        && (parts.length !== 2 || !groups.has(parts[0]) || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug))) {
        fail('slug', '页面必须位于约定分组，文件名使用英文短横线 slug')
      }
      if (slugs.has(slug)) fail('slug-duplicate', `重复页面 slug：${slug}`)
      slugs.add(slug)
      const text = await readFile(absolute, 'utf8')
      if (/github\.com\/OWNER\//i.test(text)) {
        const issues = release ? errors : warnings
        issues.push({ path: relative, code: 'repository-placeholder', message: '公开仓库 OWNER 占位尚未替换；#419 导出时替换 OWNER，发布检查不允许保留该占位' })
      }
      if (closedSymbol.test(text)) fail('closed-symbol', '含闭源符号')
      if (privatePath.test(text)) fail('private-content', '含私有路径')
      if ([...text.matchAll(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi)]
        .some(([email]) => email !== 'admin@example.com')) fail('personal-email', '邮箱示例只允许 admin@example.com')
      if (/\b[a-z0-9][a-z0-9.-]*\.(?:internal|local|ts\.net)\b/i.test(text)) fail('internal-host', '含内部或尾网主机名')
      if ([...text.matchAll(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g)].some(([value]) => value !== '127.0.0.1')
        || [...text.matchAll(/[0-9a-f:]*:[0-9a-f:.%]+/gi)].some(([value]) => isIP(value.replace(/%.*$/, '')) === 6)) {
        fail('ip-address', '含非允许的 IP 地址；本机示例仅允许 127.0.0.1 或 localhost')
      }
      if (/<script\b/i.test(text)) fail('script', '正文不允许脚本，结构化数据由站点生成')
      const { body, title } = frontmatter(text, fail)
      const prose = proseOnly(body)
      const page = { path: relative, slug, title, anchors: headingIds(prose, fail) }
      pages.push(page)
      documents.set(absolute, { page, links: destinations(prose, fail) })
    }
  }
  try {
    await walk(base)
  } catch (error) {
    add('.', 'read', error instanceof Error ? error.message : String(error))
  }
  if (!pages.length) add('.', 'empty', '没有 Markdown 页面')
  for (const [absolute, { page, links }] of documents) {
    for (const raw of links) {
      const href = decode(raw)
      const fail = (code, message) => add(page.path, code, `${raw}：${message}`)
      if (href === null) { fail('link-format', 'URL 编码无效'); continue }
      const normalized = href.replaceAll('\\', '/')
      if (privatePath.test(normalized) || privatePath.test(path.posix.normalize(normalized))) {
        fail('private-link', '不能链接私有路径'); continue
      }
      if (/^https:\/\//i.test(href)) {
        try {
          const url = new URL(href)
          if (url.username || url.password) fail('link-format', 'URL 不能包含凭据')
          if (url.hostname === 'sk.woe.show' && /^\/(?:docs|guides)(?:\/|$)/.test(url.pathname)) {
            fail('link-format', '文档站内链接须使用相对 .md')
          }
        } catch { fail('link-format', '外部 URL 无效') }
        continue
      }
      if (/^[a-z][a-z0-9+.-]*:/i.test(href) || /^[\\/]/.test(href)) {
        fail('link-format', '外链须 HTTPS，站内须相对 .md'); continue
      }
      const [target, anchor, ...extra] = href.split('#')
      if (!target.endsWith('.md') || target.includes('?') || target.includes('\\') || extra.length) {
        fail('link-format', '站内须相对 .md 路径，可带一个锚点'); continue
      }
      const resolved = path.resolve(path.dirname(absolute), target)
      const relative = path.relative(base, resolved)
      if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
        fail('outside-root', '链接超出公开文档根目录'); continue
      }
      const found = documents.get(resolved)
      if (!found) { fail('target-missing', '目标页面不存在或不允许'); continue }
      if (anchor !== undefined && (!anchor || !found.page.anchors.includes(anchor))) fail('anchor-missing', '目标锚点不存在')
    }
  }
  return { ok: errors.length === 0, errors, warnings, pages }
}

const invoked = process.argv[1] && await realpath(process.argv[1]).catch(() => null)
if (invoked === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const roots = args.filter(argument => argument !== '--release')
  if (roots.length > 1 || roots.some(argument => argument.startsWith('-'))) {
    console.error('用法：node scripts/check-guide.mjs [--release] [docs/guide]')
    process.exit(2)
  }
  const result = await checkGuide(roots[0] ?? 'docs/guide', { release: args.includes('--release') })
  for (const warning of result.warnings) console.error(`${warning.path} [WARNING ${warning.code}] ${warning.message}`)
  for (const error of result.errors) console.error(`${error.path} [${error.code}] ${error.message}`)
  console.log(`GUIDE_CHECK ${result.ok ? 'PASS' : 'FAIL'} pages=${result.pages.length} errors=${result.errors.length} warnings=${result.warnings.length}`)
  process.exitCode = result.ok ? 0 : 1
}
