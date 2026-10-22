import { readdir, readFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { checkGuide } from './check-guide.mjs'

const require = createRequire(new URL('../desktop/package.json', import.meta.url))
const ts = require('typescript')

export async function checkAppDocLinks(root = process.cwd()) {
  const guide = await checkGuide(join(root, 'docs/guide'))
  const errors = guide.errors.map(error => `${error.path}: ${error.message}`)
  const pages = new Map(guide.pages.map(page => [page.path.replace(/\.md$/, ''), new Set(page.anchors)]))
  let count = 0
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) { await walk(path); continue }
      if (!/\.tsx?$/.test(entry.name)) continue
      const source = ts.createSourceFile(path, await readFile(path, 'utf8'), ts.ScriptTarget.Latest, true)
      function visit(node) {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'docsUrl') {
          count += 1
          const args = node.arguments
          if (args.length < 1 || args.length > 2 || !args.every(arg => ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))) {
            errors.push(`${path}: docsUrl must use literal slug and anchor`)
          } else {
            const [slug, anchor] = args.map(arg => arg.text)
            const anchors = pages.get(slug)
            if (!anchors) errors.push(`${path}: missing slug ${slug}`)
            else if (anchor !== undefined && !anchors.has(anchor)) errors.push(`${path}: missing anchor ${slug}#${anchor}`)
          }
        }
        ts.forEachChild(node, visit)
      }
      visit(source)
    }
  }
  await walk(join(root, 'desktop/src'))
  if (!count) errors.push('No APP documentation links found')
  return { ok: errors.length === 0, errors, count }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await checkAppDocLinks(resolve(process.argv[2] ?? '.'))
  for (const error of result.errors) console.error(error)
  console.log(`APP documentation links: ${result.count}, ${result.ok ? 'PASS' : 'FAIL'}`)
  process.exitCode = result.ok ? 0 : 1
}
