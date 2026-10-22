import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkAppDocLinks } from './check-app-doc-links.mjs'

test('all APP links match the real guide', async () => {
  const result = await checkAppDocLinks()
  assert.deepEqual(result.errors, [])
  assert.ok(result.count >= 14)
})
test('valid links pass; missing slug, anchor and dynamic calls fail', async () => {
  const root = await mkdtemp(join(tmpdir(), 'app-docs-'))
  try {
    await mkdir(join(root, 'docs/guide/guides'), { recursive: true })
    await mkdir(join(root, 'desktop/src'), { recursive: true })
    await writeFile(join(root, 'docs/guide/guides/example.md'), '---\ntitle: 示例\ndescription: 文档说明。\nsidebar: { order: 1 }\n---\n\n## stable-anchor\n')
    for (const [call, error] of [
      ["docsUrl('guides/example', 'stable-anchor')", null],
      ["docsUrl('guides/missing')", 'missing slug'],
      ["docsUrl('guides/example', 'missing')", 'missing anchor'],
      ['docsUrl(variable)', 'literal'],
    ]) {
      await writeFile(join(root, 'desktop/src/help.ts'), `// docsUrl('ignored')\nconst link = ${call}`)
      const result = await checkAppDocLinks(root)
      if (error) { assert.equal(result.ok, false); assert.ok(result.errors.some(message => message.includes(error))) }
      else assert.deepEqual(result.errors, [])
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})
