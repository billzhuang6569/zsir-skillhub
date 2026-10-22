import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { allowedTopicImageUrl, topicArticle, topicArticleOf, type TopicArticle } from '../src/lib/topic-article.ts'
import { renderTopicMarkdown } from '../src/lib/markdown.ts'
import { articleSkills, installAllPlan, topicSkillMap } from '../src/lib/topic-install.ts'
import type { LocalSkill } from '../src/store/index.js'
import { mockConvertFileSrc, clearMocks } from '@tauri-apps/api/mocks'
import type { MediaContext } from '../src/lib/media.ts'

// Fixtures shared with server/src/lib/topic-markdown.test.ts and the Web parser (#212):
// CRLF, fake embeds in fenced / 4-space code, 4 links in one paragraph, link text with `]`.
const A = '7a2c5c1e-9d4e-4f0a-a4a0-0d2a5a4a9c11'
const B = '1b3d5f7a-2c4e-4b6d-8f0a-1c3e5a7b9d2f'
const C = '9e8f7a6b-5c4d-4e3f-a2b1-0c9d8e7f6a5b'
const D = '3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f'
const FIXTURES: Array<{ name: string; body: string; groups: string[][] }> = [
  { name: 'CRLF and BOM', body: `﻿## 标题\r\n\r\n[a](skill:${A})\r\n`, groups: [[A]] },
  { name: '1–3 links make an embed; dedup within a group', body: `intro\n\n[one](skill:${A})\n\n[two](skill:${B})  [three](skill:${C.toUpperCase()})\n[again](skill:${A})\n\ntail`, groups: [[A], [B, C, A]] },
  { name: '4 links in one paragraph are text', body: `[a](skill:${A}) [b](skill:${B}) [c](skill:${C}) [d](skill:${D})`, groups: [] },
  { name: 'mixed targets and inline mentions are text', body: `[a](skill:${A}) [b](https://example.com)\n\nSee [a](skill:${A}) for details.\n\nRead [x](skill:nope) here.`, groups: [] },
  { name: 'never in code, indented code, lists, quotes or tables', body: ['para', '', '```', `[f](skill:${A})`, '```', '', `    [indented](skill:${B})`, '', `- [listed](skill:${C})`, '', `> [quoted](skill:${D})`, '', '| a | b |', '| - | - |', `| [t](skill:${A}) | x |`].join('\n'), groups: [] },
  { name: 'list continuation and setext heading are not embeds', body: `- item\n[a](skill:${A})\n\n[b](skill:${B})\n---\n\n- item\n\n  [p](skill:${C})`, groups: [] },
  { name: 'link text with brackets', body: `[name [beta]](skill:${A})\n\n[esc \\] ape](skill:${B})`, groups: [[A], [B]] },
  { name: 'a code span beside the link makes it text', body: `\`说明\` [p](skill:${A})`, groups: [] },
  { name: 'an invalid id makes the whole paragraph text', body: `[a](skill:${A})  [b](skill:not-a-uuid)`, groups: [] },
  { name: 'definition lines do not stop an embed', body: `[a](skill:${A})\n\n[ref]: https://example.com\n\n[b](skill:${B})`, groups: [[A], [B]] },
]
const groups = (article: TopicArticle): string[][] => article.segments.flatMap(segment => segment.kind === 'skills' ? [segment.ids] : [])

test('embed detection matches the shared fixtures', () => {
  for (const fixture of FIXTURES) assert.deepEqual(groups(topicArticle(fixture.body)), fixture.groups, fixture.name)
})

// Parity with the Web parser: the two copies are separate npm projects, so this compares
// them case by case whenever the Web parser is available (in the monorepo after #212, or
// via WEB_TOPIC_ARTICLE pointing at a copy of landing-page/src/shared/topic-article.ts).
// fileURLToPath, not URL.pathname: a checkout path with spaces would otherwise stay
// percent-encoded, existsSync would miss the file and the parity check would skip silently.
const webParser = process.env.WEB_TOPIC_ARTICLE ?? fileURLToPath(new URL('../../landing-page/src/shared/topic-article.ts', import.meta.url))
test('the desktop and Web parsers find the same embeds (fixtures + random bodies)', { skip: existsSync(webParser) ? false : 'Web topic parser not present in this checkout' }, async () => {
  const web = await import(pathToFileURL(webParser).href) as { parseTopicArticle: (input: string) => { blocks: Array<{ kind: string; ids?: string[] }>; skillIds: string[] } }
  const webGroups = (body: string): string[][] => web.parseTopicArticle(body).blocks.flatMap(block => block.kind === 'skills' ? [block.ids ?? []] : [])
  for (const fixture of FIXTURES) {
    assert.deepEqual(groups(topicArticle(fixture.body)), webGroups(fixture.body), fixture.name)
    assert.deepEqual(topicArticle(fixture.body).skillIds, web.parseTopicArticle(fixture.body).skillIds, fixture.name)
  }
  const alphabet = ['[', ']', '(', ')', '`', '\\', '#', '-', '>', '|', ' ', '\n', '\n\n', 'a', 'skill:', A, B, '    ', '```', '1.', '[r]: https://x.dev']
  let seed = 11
  const next = (): number => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed }
  for (let round = 0; round < 2000; round += 1) {
    const body = Array.from({ length: 1 + next() % 30 }, () => alphabet[next() % alphabet.length]).join('')
    assert.deepEqual(groups(topicArticle(body)), webGroups(body), JSON.stringify(body))
  }
})

test('the body is cut into markdown fragments and card groups in order; code keeps its fake embed', () => {
  const body = `导语。\n\n## 先把素材收齐\n\n[a](skill:${A})\n\n中间段落。\n\n\`\`\`\n[f](skill:${B})\n\`\`\`\n\n[b](skill:${B})  [c](skill:${C})\n\n[ref]: https://example.com/doc`
  const article = topicArticle(body)
  assert.deepEqual(article.segments.map(segment => segment.kind), ['markdown', 'skills', 'markdown', 'skills'])
  const [first, , middle] = article.segments
  assert.ok(first?.kind === 'markdown' && first.source.startsWith('导语。\n\n## 先把素材收齐'))
  assert.ok(middle?.kind === 'markdown' && middle.source.includes(`[f](skill:${B})`) && middle.source.includes('```'))
  // Reference definitions travel with every fragment so `[x][ref]` still resolves.
  assert.ok(first?.kind === 'markdown' && first.source.endsWith('[ref]: https://example.com/doc'))
  assert.deepEqual(article.skillIds, [A, B, C])
  assert.doesNotThrow(() => topicArticle('&#99999999; [a](&#9999999;)'))
})

test('old Servers (no body) fall back to the old layout', () => {
  assert.equal(topicArticleOf({}), null)
  assert.equal(topicArticleOf({ contentMarkdown: null }), null)
  assert.ok(topicArticleOf({ contentMarkdown: '' }))
  const page = readFileSync(new URL('../src/pages/MarketplacePage.tsx', import.meta.url), 'utf8')
  assert.match(page, /const article = topicArticleOf\(topic\)/)
  assert.match(page, /\{topic\.introContent && <p className="marketplace-topic-intro">\{topic\.introContent\}<\/p>\}/)
  assert.match(page, /data-topic-layout=\{article \? 'article' : topicLoad === 'loading' \? 'loading' : 'legacy'\}/)
})

test('fragments render without raw HTML: skill: links are text, web links stay links, only own-host images load, # is h2', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {} })
  mockConvertFileSrc('macos')
  const media: MediaContext = { spaceId: 'official', serverBase: 'https://fixture.invalid', allowedImageHosts: ['picem-media.whatonearth.work'] }
  const html = renderTopicMarkdown(`# 一级\n\n见 [p](skill:${A}) 与 [文档](https://example.com/a) <script>alert(1)</script>\n\n![图](https://picem-media.whatonearth.work/public/a.webp)\n\n![外](https://evil.example/a.png)\n\n[x](javascript:alert(1))`, media)
  clearMocks()
  if (previous) Object.defineProperty(globalThis, 'window', previous)
  else Reflect.deleteProperty(globalThis, 'window')
  assert.match(html, /<h2>一级<\/h2>/)
  assert.doesNotMatch(html, /<h1>/)
  assert.doesNotMatch(html, /href="skill:/)
  assert.match(html, /见 p 与 <a href="https:\/\/example.com\/a">文档<\/a>/)
  assert.doesNotMatch(html, /<script>/)
  assert.match(html, /&lt;script&gt;/)
  assert.match(html, /<img src="skillhub-media:\/\/localhost\/official%2Fh%2Fpicem-media.whatonearth.work%2Fpublic%2Fa.webp" alt="图" loading="lazy" referrerpolicy="no-referrer">/)
  assert.match(html, /<span class="markdown-image-placeholder" title="https:\/\/evil.example\/a.png">图片：外<\/span>/)
  assert.doesNotMatch(html, /href="javascript:/)
  assert.equal(allowedTopicImageUrl('https://picem-media.whatonearth.work&#46;evil.example/a.png'), null)
  assert.equal(allowedTopicImageUrl('http://picem-media.whatonearth.work/a.png'), null)
})

const store = (fields: Partial<LocalSkill>): LocalSkill => ({ id: `market-${fields.serverId}`, name: 'n', displayName: 'n', description: '', version: '1.0.0', agents: [], installed: false, ...fields } as LocalSkill)

test('withdrawn / unknown embeds have no store Skill (→ 「此 Skill 已下架」), and 全部安装 follows the existing install states', () => {
  const article = topicArticle(`[a](skill:${A})\n\n[gone](skill:${B})  [c](skill:${C})`)
  const skills = topicSkillMap([store({ serverId: A.toUpperCase() }), store({ serverId: C, localPath: '/x', marketplaceLocalId: 'local', marketplaceLocalVersion: '1.0.0' })])
  assert.equal(skills.has(B), false)
  assert.deepEqual(articleSkills(article, skills).map(skill => skill.serverId?.toLowerCase()), [A, C])
  assert.equal(installAllPlan(store({ serverId: A })), 'install')
  assert.equal(installAllPlan(store({ serverId: C, localPath: '/x', marketplaceLocalVersion: '1.0.0' })), 'joined')
  assert.equal(installAllPlan(store({ serverId: C, version: '2.0.0', localPath: '/x', marketplaceLocalVersion: '1.0.0' })), 'needs-update')
  const view = readFileSync(new URL('../src/components/store/TopicArticle.tsx', import.meta.url), 'utf8')
  assert.match(view, /if \(!skill\) return <MissingTopicSkill key=\{id\} \/>/)
  assert.match(view, /<strong>此 Skill 已下架<\/strong>/)
  // Embedded cards are the store SkillCard / SkillRow whose 安装 / 已加入 / 更新 come from StoreInstallButton.
  assert.match(view, /segment\.ids\.length === 1 \? <StoreSkillRow key=\{id\} \{\.\.\.item\(skill\)\} \/> : <StoreSkillCard key=\{id\} \{\.\.\.item\(skill\)\} \/>/)
})

test('the page wires cards and 全部安装 into the existing join flow, links into the system browser, and back keeps the scroll', () => {
  const page = readFileSync(new URL('../src/pages/MarketplacePage.tsx', import.meta.url), 'utf8')
  assert.match(page, /onOpen=\{\(skill\) => void openMarketplaceSkill\(skill\)\} onInstall=\{\(skill\) => void joinMySkills\(skill\)\} onLink=\{openTopicLink\}/)
  assert.match(page, /results\[skill\.id\] = await joinMySkills\(withLiveRuntime\(skill\)\) \? 'done' : 'failed'/)
  assert.match(page, /if \(useStore\.getState\(\)\.currentUser\?\.id !== accountId\) \{ results\[skill\.id\] = 'stopped'; continue \}/)
  assert.match(page, /const target = classifyMarkdownLink\(href, \[\]\)\n    if \(target\.kind === 'external'\) void openUrl\(target\.url\)/)
  assert.match(page, /const detail = await apiGetMarketplaceTopic\(topic\.slug\)/)
  assert.match(page, /if \(generation === topicGeneration\.current\) setTopicLoad\('failed'\)/)
  assert.match(page, /onClick=\{\(\) => void openTopic\(topic, true\)\}>\{RETRY_LABEL\}<\/button>/)
  assert.match(page, /window\.requestAnimationFrame\(\(\) => scrollPane\(\)\?\.scrollTo\(\{ top \}\)\)/)
  const view = readFileSync(new URL('../src/components/store/TopicArticle.tsx', import.meta.url), 'utf8')
  assert.match(view, /event\.preventDefault\(\)\n    onLink\(anchor\.getAttribute\('href'\) \?\? ''\)/)
  const css = readFileSync(new URL('../src/components/store/TopicArticle.css', import.meta.url), 'utf8')
  // One 680px column for the text, every card group and the end block, so card edges line up
  // with the prose and a long single card can never overflow the window (native check feedback).
  assert.match(css, /\.tsh-article \{[^}]*--article-column: 680px;[^}]*max-width: var\(--article-column\);/)
  assert.match(css, /\.tsh-article-prose \{[^}]*max-width: var\(--article-column\);[^}]*font-size: 16px; line-height: 30px;/)
  assert.match(css, /\.tsh-article-cards \{[^}]*grid-template-columns: minmax\(0, 1fr\);[^}]*max-width: var\(--article-column\);[^}]*min-width: 0;/)
  assert.match(css, /\.tsh-article-cards > \* \{ min-width: 0; \}/)
  assert.match(css, /\.tsh-article-cards\.is-1 \.tsh-row-desc \{[^}]*-webkit-line-clamp: 2;/)
  assert.match(css, /\.tsh-article-end \{[^}]*max-width: var\(--article-column\);/)
  assert.doesNotMatch(css, /820px/)
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/)
})
