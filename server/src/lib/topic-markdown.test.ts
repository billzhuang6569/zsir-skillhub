import { describe, expect, it } from 'vitest'
import {
  TOPIC_CONTENT_MAX, TOPIC_INTRO_MAX, analyzeTopicMarkdown, derivedTopicItemIds, normalizeTopicMarkdown, synthesizeTopicMarkdown,
  topicWarnings, type TopicAnalysis,
} from './topic-markdown.js'

const HOSTS = ['picem-media.whatonearth.work']
const A = '7a2c5c1e-9d4e-4f0a-a4a0-0d2a5a4a9c11'
const B = '1b3d5f7a-2c4e-4b6d-8f0a-1c3e5a7b9d2f'
const C = '9e8f7a6b-5c4d-4e3f-a2b1-0c9d8e7f6a5b'
const D = '3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f'
const ok = (body: string): Extract<TopicAnalysis, { ok: true }> => {
  const result = analyzeTopicMarkdown(body, HOSTS)
  if (!result.ok) throw new Error(`unexpected ${result.error.code} at ${result.error.line}`)
  return result
}
const error = (body: string): { code: string; line: number } => {
  const result = analyzeTopicMarkdown(body, HOSTS)
  if (result.ok) throw new Error('expected an error')
  return result.error
}

describe('topic article embeds', () => {
  it('normalises NFC, BOM and CRLF before anything else, so line numbers match the stored body', () => {
    expect(normalizeTopicMarkdown('﻿é\r\nb\rc')).toBe('é\nb\nc')
    const result = ok(`﻿## 标题\r\n\r\n[a](skill:${A})\r\n`)
    expect(result.content).toBe(`## 标题\n\n[a](skill:${A})\n`)
    expect(result.embeds).toEqual([{ listingId: A, line: 3 }])
  })
  it('finds 1–3 skill links that make up a whole paragraph, in first-occurrence order without duplicates', () => {
    const body = `intro\n\n[one](skill:${A})\n\n[two](skill:${B})  [three](skill:${C.toUpperCase()})\n[again](skill:${A})\n\ntail`
    const result = ok(body)
    expect(result.embeds).toEqual([{ listingId: A, line: 3 }, { listingId: B, line: 5 }, { listingId: C, line: 5 }])
  })
  it('treats 4 links in one paragraph, mixed targets and inline mentions as ordinary text', () => {
    expect(ok(`[a](skill:${A}) [b](skill:${B}) [c](skill:${C}) [d](skill:${D})`).embeds).toEqual([])
    expect(ok(`[a](skill:${A}) [b](https://example.com)`).embeds).toEqual([])
    expect(ok(`See [a](skill:${A}) for details.`).embeds).toEqual([])
    // Not a UUID, but not an embed either: ordinary text, no error.
    expect(ok('Read [x](skill:nope) here.').embeds).toEqual([])
  })
  it('never counts embeds inside fenced code, indented code, lists, quotes or tables', () => {
    const body = [
      'para', '',
      '```', `[f](skill:${A})`, '```', '',
      `    [indented](skill:${B})`, '',
      `- [listed](skill:${C})`, '',
      `> [quoted](skill:${D})`, '',
      '| a | b |', '| - | - |', `| [t](skill:${A}) | x |`, '',
      `~~~md`, `<div>not html here</div>`, `~~~`,
    ].join('\n')
    const result = ok(body)
    expect(result.embeds).toEqual([])
  })
  it('keeps a list item and its lazy continuation together, and a setext heading is not an embed', () => {
    expect(ok(`- item\n[a](skill:${A})`).embeds).toEqual([])
    expect(ok(`[a](skill:${A})\n---`).embeds).toEqual([])
  })
  it('reads link text containing balanced or escaped brackets', () => {
    expect(ok(`[name [beta]](skill:${A})\n\n[esc \\] ape](skill:${B})`).embeds.map(embed => embed.listingId)).toEqual([A, B])
  })
})

describe('table A errors carry the first offending line', () => {
  it('TOPIC_CONTENT_TOO_LONG past 60 000 characters', () => {
    expect(error(`a\n${'x'.repeat(TOPIC_CONTENT_MAX)}`)).toEqual({ code: 'TOPIC_CONTENT_TOO_LONG', line: 2 })
    expect(analyzeTopicMarkdown('x'.repeat(TOPIC_CONTENT_MAX), HOSTS).ok).toBe(true)
  })
  it('TOPIC_HTML_FORBIDDEN for tags, comments and declarations, but not in code or comparisons', () => {
    expect(error('ok\n\nline <b>bold</b>')).toEqual({ code: 'TOPIC_HTML_FORBIDDEN', line: 3 })
    expect(error('a\n</div>')).toEqual({ code: 'TOPIC_HTML_FORBIDDEN', line: 2 })
    expect(error('<!-- note -->')).toEqual({ code: 'TOPIC_HTML_FORBIDDEN', line: 1 })
    expect(error('x\n\n<?php ?>')).toEqual({ code: 'TOPIC_HTML_FORBIDDEN', line: 3 })
    expect(analyzeTopicMarkdown('1 < 2 and `<b>` and \\<b> stay text\n\n```\n<script>\n```\n\n    <div>', HOSTS).ok).toBe(true)
  })
  it('TOPIC_LINK_FORBIDDEN for javascript, data, vbscript and file targets, including entity tricks', () => {
    expect(error('a\n\n[x](javascript:alert(1))')).toEqual({ code: 'TOPIC_LINK_FORBIDDEN', line: 3 })
    expect(error('![i](data:image/png;base64,AAA)')).toEqual({ code: 'TOPIC_LINK_FORBIDDEN', line: 1 })
    expect(error('[x](VBScript:x)')).toEqual({ code: 'TOPIC_LINK_FORBIDDEN', line: 1 })
    expect(error('a\n[x](file:///etc/passwd)')).toEqual({ code: 'TOPIC_LINK_FORBIDDEN', line: 2 })
    expect(error('[x](java&#115;cript:x)')).toEqual({ code: 'TOPIC_LINK_FORBIDDEN', line: 1 })
    expect(error('[a [b]](javascript:x)')).toEqual({ code: 'TOPIC_LINK_FORBIDDEN', line: 1 })
    expect(error('para\n\n[ref]: javascript:alert(1)')).toEqual({ code: 'TOPIC_LINK_FORBIDDEN', line: 3 })
    expect(analyzeTopicMarkdown('[x](https://example.com/javascript:) `[y](javascript:x)`', HOSTS).ok).toBe(true)
  })
  it('TOPIC_SKILL_REF_INVALID only inside an embed paragraph', () => {
    expect(error(`[a](skill:${A})\n\n[b](skill:not-a-uuid)`)).toEqual({ code: 'TOPIC_SKILL_REF_INVALID', line: 3 })
    expect(error(`[a](skill:${A}) [b](skill:${A.slice(0, -1)})`)).toEqual({ code: 'TOPIC_SKILL_REF_INVALID', line: 1 })
  })
  it('reports the earliest line when several errors exist', () => {
    expect(error('[x](skill:bad)\n\n<b>')).toEqual({ code: 'TOPIC_SKILL_REF_INVALID', line: 1 })
  })
})

describe('table A warnings, derived items and intro', () => {
  const body = [
    '## 先把素材收齐', '',
    '这是 **一篇** 关于 [周报](https://example.com) 的文章，`code` 也算文字。', '',
    `[public](skill:${A})`, '',
    `[gone](skill:${B}) [missing](skill:${C})`, '',
    '![cover](https://evil.example/cover.png)', '',
    '![ok](https://picem-media.whatonearth.work/public/app/ast/a.webp)', '',
    `[public again](skill:${A})`, '',
    '- 列表项一', '- 列表项二', '',
    '```', 'console.log(1)', '```',
  ].join('\n')
  it('classifies unknown, unavailable and outside images by line; no public Skill is a whole-body warning', () => {
    const result = ok(body)
    const listings = { known: new Set([A, B]), public: new Set([A]) }
    expect(topicWarnings(result, listings)).toEqual([
      { code: 'TOPIC_SKILL_UNAVAILABLE', line: 7, listingId: B },
      { code: 'TOPIC_SKILL_UNKNOWN', line: 7, listingId: C },
      { code: 'TOPIC_IMAGE_HOST', line: 9 },
    ])
    expect(topicWarnings(result, { known: new Set([A, B]), public: new Set() }).at(-1)).toEqual({ code: 'TOPIC_NO_PUBLIC_SKILL', line: null })
    expect(derivedTopicItemIds(result, listings.known)).toEqual([A, B])
  })
  it('derives a plain-text intro without markup, embeds, images or code, capped at 1 000 characters', () => {
    expect(ok(body).introContent).toBe('先把素材收齐\n\n这是 一篇 关于 周报 的文章，code 也算文字。\n\n列表项一\n列表项二')
    expect(ok(`[a](skill:${A})`).introContent).toBeNull()
    expect(Array.from(ok('长'.repeat(1_500)).introContent ?? '')).toHaveLength(TOPIC_INTRO_MAX)
  })
  it('synthesises a legacy topic body from its intro and items', () => {
    expect(synthesizeTopicMarkdown('导语', [{ id: A, name: 'zsir-weekly' }, { id: B, name: 'odd [name]' }]))
      .toBe(`导语\n\n[zsir-weekly](skill:${A})\n\n[odd \\[name\\]](skill:${B})`)
    expect(synthesizeTopicMarkdown(null, [{ id: A, name: 'a' }])).toBe(`[a](skill:${A})`)
    const roundTrip = ok(synthesizeTopicMarkdown('导语', [{ id: A, name: 'odd [name]' }]))
    expect(roundTrip.embeds.map(embed => embed.listingId)).toEqual([A])
  })
})

/** PR #220 review (Codex P2): each case uses the reviewer's reproduction input. */
describe('review regressions', () => {
  it('a paragraph with inline code next to a skill link is an ordinary paragraph, not an embed', () => {
    const result = ok(`\`说明\` [p](skill:${A})`)
    expect(result.embeds).toEqual([])
    expect(result.introContent).toBe('说明 p')
    // Code spans whose text merely looks like a link do not create one either.
    expect(ok(`\`[p](skill:${A})\``).embeds).toEqual([])
    // A link whose text contains a code span is still a link.
    expect(ok(`[\`p\`](skill:${A})`).embeds.map(embed => embed.listingId)).toEqual([A])
  })
  it('a list item continuation after a blank line stays inside the list', () => {
    expect(ok(`- item\n\n  [p](skill:${A})`).embeds).toEqual([])
    expect(ok(`1. step\n\n   [p](skill:${A})`).embeds).toEqual([])
    // Not indented enough to continue the item: a top-level paragraph again.
    expect(ok(`- item\n\n[p](skill:${A})`).embeds.map(embed => embed.listingId)).toEqual([A])
    // A fenced block inside the item is code: its content is never checked as HTML.
    expect(analyzeTopicMarkdown('- item\n\n  ```\n  <div>\n  ```', HOSTS).ok).toBe(true)
  })
  it('every image form is host-checked: balanced alt brackets, full / collapsed / shortcut references, entity-encoded hosts', () => {
    const outside = (body: string): string[] => ok(body).images.filter(image => !image.allowed).map(image => image.url)
    expect(outside('![a [b]](https://outside.example/x.png)')).toEqual(['https://outside.example/x.png'])
    expect(outside('![a][ref]\n\n[ref]: https://outside.example/x.png')).toEqual(['https://outside.example/x.png'])
    // (An angle-bracket destination `<https://…>` is itself refused as HTML by table A, so the bare form is used here.)
    expect(outside('![ref][]\n\n[REF]: https://outside.example/y.png "t"')).toEqual(['https://outside.example/y.png'])
    expect(outside('![ref]\n\n[ref]:\n  https://outside.example/z.png')).toEqual(['https://outside.example/z.png'])
    expect(outside('![x](https://picem-media.whatonearth.work&#46;evil.example/x.png)')).toHaveLength(1)
    expect(outside('![x](https://picem-media.whatonearth.work/public/a.png)')).toEqual([])
    // An image whose reference is never defined is literal text, not an image.
    expect(ok('![ghost][nowhere]').images).toEqual([])
    // HTML images and autolinks are refused outright.
    expect(error('<img src="https://outside.example/x.png">')).toEqual({ code: 'TOPIC_HTML_FORBIDDEN', line: 1 })
    expect(error('<https://outside.example/x.png>')).toEqual({ code: 'TOPIC_HTML_FORBIDDEN', line: 1 })
    // Reference definitions on the next line are checked for forbidden schemes too.
    expect(error('[x][ref]\n\n[ref]:\n  javascript:alert(1)')).toEqual({ code: 'TOPIC_LINK_FORBIDDEN', line: 4 })
  })
  it('out-of-range and invalid numeric entities never throw; they decode to U+FFFD like CommonMark', () => {
    for (const body of [
      '[x](https://example.test/&#99999999999999;)',
      '[x](https://example.test/&#x110000;)',
      '[x](https://example.test/&#xD800;)',
      '[x](https://example.test/&#0;)',
      '[x](&#xFFFFFFFFFFFF;)',
    ]) expect(() => analyzeTopicMarkdown(body, HOSTS), body).not.toThrow()
    expect(analyzeTopicMarkdown('[x](https://example.test/&#99999999999999;)', HOSTS).ok).toBe(true)
    // Valid entities are still decoded before the scheme check.
    expect(error('[x](&#x6A;avascript:alert(1))')).toEqual({ code: 'TOPIC_LINK_FORBIDDEN', line: 1 })
    expect(error('[x](javascript&colon;alert(1))')).toEqual({ code: 'TOPIC_LINK_FORBIDDEN', line: 1 })
  })
  it('never throws on arbitrary Markdown-ish input', () => {
    const alphabet = ['[', ']', '(', ')', '!', '<', '>', '`', '&', '#', 'x', ';', '9', 'F', ':', '\n', '\n\n', ' ', '  ', '-', '>', '*', '|', '\\', 'skill:', A, 'https://', '~~~', '```']
    let seed = 2_114
    const random = (): number => { seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648; return seed / 2_147_483_648 }
    for (let run = 0; run < 2_000; run += 1) {
      const body = Array.from({ length: 1 + Math.floor(random() * 40) }, () => alphabet[Math.floor(random() * alphabet.length)]).join('')
      expect(() => analyzeTopicMarkdown(body, HOSTS), JSON.stringify(body)).not.toThrow()
    }
  })
})
