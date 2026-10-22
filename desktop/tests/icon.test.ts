import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const iconSourcePath = resolve(desktopRoot, 'src/components/Icon.tsx')
const iconSource = readFileSync(iconSourcePath, 'utf8')

type IconModule = {
  Icon: (props: { name: string; size?: number; strokeWidth?: number; className?: string }) => unknown
  LUCIDE_ICONS: Record<string, unknown>
  LEGACY_PATHS: Record<string, string>
  DEFAULT_ICON_STROKE_WIDTH: number
}

// Node's strip-types runner cannot load TSX, so compile Icon.tsx with the project's TypeScript into
// a module inside node_modules/.cache (so `react` and `lucide-react` resolve from desktop/).
async function loadIconModule(): Promise<IconModule> {
  const { outputText } = ts.transpileModule(iconSource, {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: iconSourcePath,
  })
  const outDir = resolve(desktopRoot, 'node_modules/.cache/icon-test')
  mkdirSync(outDir, { recursive: true })
  const outFile = resolve(outDir, 'Icon.mjs')
  writeFileSync(outFile, outputText)
  return await import(pathToFileURL(outFile).href) as IconModule
}

function declaredIconNames(): string[] {
  const union = /export type IconName =([\s\S]*?)\n\n/.exec(iconSource)?.[1] ?? ''
  const names = [...union.matchAll(/'([a-z-]+)'/g)].map((match) => match[1])
  const legacyUnion = /type LegacyIconName =([^\n]+)/.exec(iconSource)?.[1] ?? ''
  return [...names, ...[...legacyUnion.matchAll(/'([a-z-]+)'/g)].map((match) => match[1])]
}

test('every IconName maps to exactly one Lucide component or legacy path', async () => {
  const { LUCIDE_ICONS, LEGACY_PATHS } = await loadIconModule()
  const mapped = [...Object.keys(LUCIDE_ICONS), ...Object.keys(LEGACY_PATHS)].sort()
  assert.deepEqual(mapped, [...new Set(declaredIconNames())].sort())
  for (const name of Object.keys(LEGACY_PATHS)) assert.equal(name in LUCIDE_ICONS, false, `${name} is both Lucide and legacy`)
  for (const name of ['key-round', 'lock', 'unlock', 'shield-check', 'users-round', 'monitor-down', 'package', 'flame', 'trending-up', 'zap', 'bot', 'layout-grid', 'list', 'star', 'badge-check', 'sparkles', 'search', 'download']) {
    assert.ok(name in LUCIDE_ICONS, `design-system icon ${name} must be Lucide-backed`)
  }
})

test('every IconName renders an SVG with currentColor and the design-system stroke width', async () => {
  const { Icon, LUCIDE_ICONS, LEGACY_PATHS, DEFAULT_ICON_STROKE_WIDTH } = await loadIconModule()
  assert.equal(DEFAULT_ICON_STROKE_WIDTH, 1.75)
  for (const name of [...Object.keys(LUCIDE_ICONS), ...Object.keys(LEGACY_PATHS)]) {
    const markup = renderToStaticMarkup(createElement(Icon as never, { name, size: 20, className: 'probe' }))
    assert.match(markup, /^<svg[^>]*>/, name)
    const svgTag = /^<svg[^>]*>/.exec(markup)?.[0] ?? ''
    assert.match(svgTag, /stroke="currentColor"/, name)
    assert.match(svgTag, /stroke-width="1\.75"/, name)
    assert.match(svgTag, /width="20"/, name)
    assert.match(svgTag, /stroke-linecap="round"/, name)
    assert.match(svgTag, /class="[^"]*probe/, name)
    assert.match(svgTag, /aria-hidden="true"/, name)
  }
  const custom = renderToStaticMarkup(createElement(Icon as never, { name: 'search', strokeWidth: 2 }))
  assert.match(custom, /stroke-width="2"/)
})

test('Icon imports Lucide glyphs by name only (tree-shakeable)', () => {
  assert.doesNotMatch(iconSource, /import \* as/)
  assert.doesNotMatch(iconSource, /DynamicIcon|dynamicIconImports|lucide-react\/dynamic/)
})
