import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { SOURCE_URL_DETAIL_MAX, SOURCE_URL_MAX_LENGTH, describeSourceUrl, elideMiddle, validateSourceUrl, type SourceUrlDescription } from '../src/lib/source-url.ts'

const expectEqual = (actual: unknown, expected: unknown): void => assert.deepEqual(actual, expected)

// Shared cases: keep identical in desktop/tests/source-url.test.ts and
// landing-page/src/shared/source-url.test.ts.
const LONG_PATH = `${'a'.repeat(40)}/${'b'.repeat(40)}`
const CASES: Array<[string, string | null | undefined, SourceUrlDescription | null]> = [
  ['missing', undefined, null],
  ['null', null, null],
  ['empty', '', null],
  ['whitespace', '   \n\t ', null],
  ['javascript protocol', 'javascript:alert(1)', null],
  ['data protocol', 'data:text/html,<b>x</b>', null],
  ['ftp protocol', 'ftp://example.com/skill', null],
  ['no scheme', 'github.com/acme/demo', null],
  ['userinfo', 'https://user:secret@github.com/acme/demo', null],
  ['user only', 'https://user@example.com/', null],
  ['inner space', 'https://example.com/a b', null],
  ['angle bracket', 'https://example.com/<script>', null],
  ['too long', `https://example.com/${'a'.repeat(2048)}`, null],
  ['X profile', 'https://x.com/AcmeDev', { kind: 'x', label: 'X', detail: '@AcmeDev', href: 'https://x.com/AcmeDev' }],
  ['X post', 'https://x.com/acme_dev/status/1890000000000000000', { kind: 'x', label: 'X', detail: '@acme_dev 的帖子', href: 'https://x.com/acme_dev/status/1890000000000000000' }],
  ['twitter legacy domain', 'https://twitter.com/acme/status/42?s=20', { kind: 'x', label: 'X', detail: '@acme 的帖子', href: 'https://twitter.com/acme/status/42?s=20' }],
  ['www twitter', 'https://www.twitter.com/acme', { kind: 'x', label: 'X', detail: '@acme', href: 'https://www.twitter.com/acme' }],
  ['X reserved path', 'https://x.com/search?q=skill', { kind: 'x', label: 'X', detail: null, href: 'https://x.com/search?q=skill' }],
  ['GitHub repo', 'https://github.com/acme/demo-skill', { kind: 'github', label: 'GitHub', detail: 'acme/demo-skill', href: 'https://github.com/acme/demo-skill' }],
  ['GitHub subdirectory keeps the full link', 'https://github.com/acme/skills/tree/main/skills/pdf', { kind: 'github', label: 'GitHub', detail: 'acme/skills', href: 'https://github.com/acme/skills/tree/main/skills/pdf' }],
  ['GitHub .git suffix', 'https://www.github.com/acme/demo.git', { kind: 'github', label: 'GitHub', detail: 'acme/demo', href: 'https://www.github.com/acme/demo.git' }],
  ['GitHub owner only', 'https://github.com/acme', { kind: 'github', label: 'GitHub', detail: 'acme', href: 'https://github.com/acme' }],
  ['GitHub root', 'https://github.com/', { kind: 'github', label: 'GitHub', detail: null, href: 'https://github.com/' }],
  ['uppercase host and scheme', 'HTTPS://GitHub.COM/acme/demo', { kind: 'github', label: 'GitHub', detail: 'acme/demo', href: 'https://github.com/acme/demo' }],
  ['skills.sh', 'https://skills.sh/acme/skills/pdf', { kind: 'skills-sh', label: 'skills.sh', detail: 'acme/skills/pdf', href: 'https://skills.sh/acme/skills/pdf' }],
  ['SkillsMP', 'https://skillsmp.com/skills/acme-pdf-skill-md', { kind: 'skillsmp', label: 'SkillsMP', detail: 'skills/acme-pdf-skill-md', href: 'https://skillsmp.com/skills/acme-pdf-skill-md' }],
  ['ClawHub www', 'https://www.clawhub.ai/acme/pdf', { kind: 'clawhub', label: 'ClawHub', detail: 'acme/pdf', href: 'https://www.clawhub.ai/acme/pdf' }],
  ['ClawHub root', 'https://clawhub.ai', { kind: 'clawhub', label: 'ClawHub', detail: null, href: 'https://clawhub.ai/' }],
  ['generic http', 'http://docs.example.org/guides/skill', { kind: 'generic', label: 'docs.example.org', detail: 'guides/skill', href: 'http://docs.example.org/guides/skill' }],
  ['generic www', 'https://www.example.com', { kind: 'generic', label: 'example.com', detail: null, href: 'https://www.example.com/' }],
  ['generic decoded path', 'https://example.com/%E6%8A%80%E8%83%BD/demo', { kind: 'generic', label: 'example.com', detail: '技能/demo', href: 'https://example.com/%E6%8A%80%E8%83%BD/demo' }],
  ['spoofed suffix', 'https://github.com.evil.example/acme/demo', { kind: 'generic', label: 'github.com.evil.example', detail: 'acme/demo', href: 'https://github.com.evil.example/acme/demo' }],
  ['spoofed prefix', 'https://evilgithub.com/acme/demo', { kind: 'generic', label: 'evilgithub.com', detail: 'acme/demo', href: 'https://evilgithub.com/acme/demo' }],
  ['spoofed subdomain', 'https://gist.github.com/acme/1', { kind: 'generic', label: 'gist.github.com', detail: 'acme/1', href: 'https://gist.github.com/acme/1' }],
  ['spoofed X', 'https://x.com.cn/acme', { kind: 'generic', label: 'x.com.cn', detail: 'acme', href: 'https://x.com.cn/acme' }],
  ['host in path', 'https://evil.example/github.com/acme', { kind: 'generic', label: 'evil.example', detail: 'github.com/acme', href: 'https://evil.example/github.com/acme' }],
  ['long path elided', `https://example.com/${LONG_PATH}`, { kind: 'generic', label: 'example.com', detail: `${'a'.repeat(24)}…${'b'.repeat(23)}`, href: `https://example.com/${LONG_PATH}` }],
]

describe('describeSourceUrl', () => {
  for (const [name, input, expected] of CASES) {
    it(name, () => {
      expectEqual(describeSourceUrl(input), expected)
    })
  }
})

describe('validateSourceUrl', () => {
  it('trims and accepts http/https; blank clears', () => {
    expectEqual(validateSourceUrl('  https://x.com/acme  '), { ok: true, value: 'https://x.com/acme' })
    expectEqual(validateSourceUrl('   '), { ok: true, value: null })
    expectEqual(validateSourceUrl(null), { ok: true, value: null })
  })
  it('rejects what the Server rejects', () => {
    for (const value of ['javascript:alert(1)', 'mailto:a@b.c', 'https://u:p@example.com', 'https://example.com/a"b', 'https://']) {
      expectEqual(validateSourceUrl(value).ok, false)
    }
    const atLimit = `https://e.com/${'a'.repeat(SOURCE_URL_MAX_LENGTH - 14)}`
    expectEqual(atLimit.length, SOURCE_URL_MAX_LENGTH)
    expectEqual(validateSourceUrl(atLimit).ok, true)
    expectEqual(validateSourceUrl(`${atLimit}a`).ok, false)
  })
})

describe('elideMiddle', () => {
  it('keeps short text and elides long text to the limit', () => {
    expectEqual(elideMiddle('acme/demo'), 'acme/demo')
    expectEqual(Array.from(elideMiddle('技'.repeat(100))).length, SOURCE_URL_DETAIL_MAX)
  })
})
