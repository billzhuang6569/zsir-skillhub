// Shared #289 primitives rendered for real: Tooltip, Switch, SegmentedControl, UserChip.
// Compiled the way tests/icon.test.ts compiles Icon.tsx (ts.transpileModule + react-dom/server).
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = resolve(desktopRoot, 'node_modules/.cache/ui-primitives-test')

/** Transpile one component into the cache: CSS imports dropped, sibling `.js` imports pointed at `.mjs`. */
function compile(name: string): string {
  const sourcePath = resolve(desktopRoot, `src/components/${name}.tsx`)
  const source = readFileSync(sourcePath, 'utf8')
    .replace(/^import '\.\/[A-Za-z]+\.css'\n/gm, '')
    .replace(/from '\.\/([A-Za-z]+)\.js'/g, "from './$1.mjs'")
    .replace("from '../lib/media.js'", `from '${pathToFileURL(resolve(desktopRoot, 'src/lib/media.ts')).href}'`)
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: sourcePath,
  })
  mkdirSync(outDir, { recursive: true })
  const outFile = resolve(outDir, `${name}.mjs`)
  writeFileSync(outFile, outputText)
  return pathToFileURL(outFile).href
}

type Component = (props: Record<string, unknown>) => ReactNode

async function load(name: string): Promise<Record<string, Component>> {
  compile('Icon')
  return await import(compile(name)) as Record<string, Component>
}

const render = (component: Component | undefined, props: Record<string, unknown>, ...children: ReactNode[]): string => {
  assert.ok(component)
  return renderToStaticMarkup(createElement(component as never, props, ...children))
}

test('Tooltip renders role="tooltip" and wires aria-describedby onto its trigger', async () => {
  const { Tooltip } = await load('Tooltip')
  const markup = render(Tooltip, { content: '上次运行失败\n缺少钥匙 A' }, createElement('button', { type: 'button' }, '?'))
  const tooltipId = /<span id="([^"]+)" role="tooltip"/.exec(markup)?.[1]
  assert.ok(tooltipId, markup)
  assert.match(markup, new RegExp(`<button type="button" aria-describedby="${tooltipId}">`))
  assert.match(markup, /class="ui-tip-text">上次运行失败\n缺少钥匙 A</)
  // Hidden until hover / focus; disabled drops the bubble and the description.
  assert.match(markup, /class="ui-tip ui-tip-interactive" aria-hidden="true"/)
  const disabled = render(Tooltip, { content: 'x', disabled: true }, createElement('button', { type: 'button' }, '?'))
  assert.doesNotMatch(disabled, /role="tooltip"|aria-describedby/)
})

test('Switch is role="switch" with aria-checked and aria-busy', async () => {
  const { Switch } = await load('Switch')
  const on = render(Switch, { checked: true, onChange: () => undefined, 'aria-label': '自动允许' })
  assert.match(on, /<button type="button" role="switch" class="ui-switch ui-switch-on" aria-checked="true" aria-label="自动允许">/)
  const busy = render(Switch, { checked: false, busy: true, onChange: () => undefined })
  assert.match(busy, /aria-checked="false" aria-busy="true"/)
})

test('SegmentedControl: tablist with aria-selected, radiogroup with aria-checked, icons and counts rendered', async () => {
  const { SegmentedControl } = await load('SegmentedControl')
  const options = [
    { value: 'skillhub', label: 'SkillHub 云端', icon: 'cloud', count: 12 },
    { value: 'local', label: '本地', icon: 'laptop', count: 3 },
  ]
  const tabs = render(SegmentedControl, { options, value: 'skillhub', onChange: () => undefined, 'aria-label': 'Skill 来源' })
  assert.match(tabs, /^<div class="ui-seg" role="tablist" aria-label="Skill 来源">/)
  assert.match(tabs, /role="tab" class="ui-seg-item ui-seg-on" aria-selected="true" tabindex="0">/)
  assert.match(tabs, /role="tab" class="ui-seg-item" aria-selected="false" tabindex="-1">/)
  assert.equal(tabs.match(/<svg/g)?.length, 2)
  assert.match(tabs, /<span class="ui-seg-label">SkillHub 云端<\/span><span class="ui-seg-count">12<\/span>/)
  const radios = render(SegmentedControl, { options, value: 'local', mode: 'radiogroup', size: 'sm', onChange: () => undefined, 'aria-label': '外观' })
  assert.match(radios, /^<div class="ui-seg ui-seg-sm" role="radiogroup" aria-label="外观">/)
  assert.match(radios, /role="radio" class="ui-seg-item ui-seg-on" aria-checked="true"/)
  assert.doesNotMatch(radios, /aria-selected/)
})

test('UserChip renders the name on a chip; me renders 你 on the brand tint', async () => {
  const { UserChip } = await load('UserChip')
  assert.match(render(UserChip, { name: 'Bill' }), /^<span class="user-chip" title="Bill"><span class="user-chip-name">Bill<\/span><\/span>$/)
  const me = render(UserChip, { name: 'Bill', me: true })
  assert.match(me, /class="user-chip user-chip-me"/)
  assert.match(me, /<span class="user-chip-name">你<\/span>/)
  assert.doesNotMatch(me, /Bill/)
})
