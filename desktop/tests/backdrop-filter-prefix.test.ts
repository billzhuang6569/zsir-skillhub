import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

// Windows WebView2 is Chromium and only understands the unprefixed `backdrop-filter`.
// When a rule declares `backdrop-filter` and then `-webkit-backdrop-filter`, the Vite CSS
// minifier treats them as one property and keeps only the later, prefixed declaration,
// so the blur silently disappears on Windows (ex-#180 page-head regression). The minifier
// already adds the -webkit- prefix for WebKit targets, so source CSS must never write it.
const srcRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src')

const cssFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return cssFiles(path)
    return name.endsWith('.css') ? [path] : []
  })

test('source CSS never hand-writes -webkit-backdrop-filter', () => {
  const offenders = cssFiles(srcRoot).filter((file) =>
    /-webkit-backdrop-filter\s*:/.test(readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')),
  )
  assert.deepEqual(offenders.map((file) => relative(srcRoot, file)), [])
})

test('the sticky page head still declares the unprefixed blur', () => {
  const css = readFileSync(join(srcRoot, 'styles', 'app.css'), 'utf8')
  const rule = css.match(/\.page-head\s*\{[^}]*\}/)?.[0] ?? ''
  assert.match(rule, /(^|[\s;{])backdrop-filter:\s*blur\(20px\) saturate\(1\.3\)/)
})
