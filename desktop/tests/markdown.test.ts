import assert from 'node:assert/strict'
import test from 'node:test'
import { classifyMarkdownLink, isMarkdownPath, renderSkillMarkdown } from '../src/lib/markdown.ts'

test('Skill Markdown renders structure but never raw HTML or scripts', () => {
  const html = renderSkillMarkdown('# 标题\n\n- 一\n- 二\n\n<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n`code`')
  assert.match(html, /<h1>标题<\/h1>/)
  assert.match(html, /<li>一<\/li>/)
  assert.match(html, /<code>code<\/code>/)
  assert.doesNotMatch(html, /<script|<img/)
  assert.match(html, /&lt;script&gt;/)
})

test('Skill Markdown never loads images, remote or local', () => {
  const html = renderSkillMarkdown('![架构图](https://tracker.example/pixel.png) ![本地](./diagram.png)')
  assert.doesNotMatch(html, /<img/)
  assert.match(html, /图片：架构图/)
  assert.match(html, /图片：本地/)
})

test('Unsafe link targets are not rendered as links', () => {
  const html = renderSkillMarkdown('[x](javascript:alert(1)) [y](vbscript:msgbox) [z](file:///etc/passwd)')
  assert.doesNotMatch(html, /href="(javascript|vbscript|file):/i)
})

test('Links open the web externally or another file of the same Skill', () => {
  const files = ['SKILL.md', 'references/guide.md', 'references/api.md', 'scripts/run.sh']
  assert.deepEqual(classifyMarkdownLink('https://example.com/docs', files), { kind: 'external', url: 'https://example.com/docs' })
  assert.deepEqual(classifyMarkdownLink('references/guide.md', files), { kind: 'skill-file', path: 'references/guide.md' })
  assert.deepEqual(classifyMarkdownLink('./references/guide.md#usage', files), { kind: 'skill-file', path: 'references/guide.md' })
  assert.deepEqual(classifyMarkdownLink('api.md', files, 'references/guide.md'), { kind: 'skill-file', path: 'references/api.md' })
  assert.deepEqual(classifyMarkdownLink('../scripts/run.sh', files, 'references/guide.md'), { kind: 'skill-file', path: 'scripts/run.sh' })
  for (const ignored of ['../outside.md', '/etc/hosts', 'mailto:a@b.c', 'file:///etc/passwd', '#section', 'missing.md', '%E0%A4%A']) {
    assert.deepEqual(classifyMarkdownLink(ignored, files), { kind: 'ignored' }, ignored)
  }
})

test('Markdown preview is limited to Markdown file extensions', () => {
  assert.equal(isMarkdownPath('references/guide.md'), true)
  assert.equal(isMarkdownPath('README.MARKDOWN'), true)
  assert.equal(isMarkdownPath('scripts/run.sh'), false)
})

test('Long linkify-heavy Skill text renders without blocking the UI thread', () => {
  // 100 KB of scheme-like text: markdown-it 14.1.1 rescanned the whole pending
  // text at every "://" (GHSA-253c-mchw-3w2r), taking seconds and growing
  // quadratically; 14.3.x stays in tens of milliseconds.
  const started = performance.now()
  const html = renderSkillMarkdown('a://'.repeat(25_000))
  assert.ok(html.length > 0)
  assert.ok(performance.now() - started < 1_000, `rendering took ${Math.round(performance.now() - started)} ms`)
})
