/** Sidebar 快捷访问 (#325): placement, empty state, actions and keyboard reordering. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = (path: string): string => readFileSync(resolve(desktopRoot, path), 'utf8')
const sidebar = read('src/components/Sidebar.tsx')
const quick = read('src/components/SidebarQuickAccess.tsx')
const css = read('src/components/Sidebar.css')

test('quick access sits between the main navigation and the footer and hides while empty', () => {
  assert.match(sidebar, /<\/nav>\s*<SidebarQuickAccess \/>\s*<div className="sidebar-footer">/)
  assert.match(quick, /if \(entries\.length === 0\) return null/)
  assert.match(css, /\.sidebar-quick \{[^}]*border-top: 1px solid var\(--color-line\);/)
  assert.match(css, /\.sidebar-quick-list \{[^}]*min-height: 0;[^}]*overflow-y: auto;/)
  assert.match(css, /\.sidebar-nav \{ flex: none; \}/)
  assert.match(css, /\.sidebar-quick-label \{[^}]*text-overflow: ellipsis;/)
})

test('tags open their group, Skills reveal their detail and copy the folder name', () => {
  assert.match(quick, /if \(entry\.kind === 'tag'\) openTagGroup\(entry\.label\)\n\s*else revealSkill\(entry\.skill\.id\)/)
  assert.match(quick, /navigator\.clipboard\.writeText\(skill\.name\)\n\s*\.then\(\(\) => toast\('已复制'\)\)/)
  assert.match(quick, /aria-label=\{`复制 Skill 名称 \$\{entry\.skill\.name\}`\}/)
})

test('reordering works by drag, Alt+Arrow and the item menu; removal is in the menu', () => {
  assert.match(quick, /event\.altKey && \(event\.key === 'ArrowUp' \|\| event\.key === 'ArrowDown'\)/)
  assert.match(quick, /moveQuickAccess\(state, from\.index, target\.index\)/)
  assert.match(quick, /onPointerUp=\{\(event\) => endDrag\(event, true\)\}/)
  assert.match(quick, /<span>上移<\/span>[\s\S]*<span>下移<\/span>[\s\S]*<span>移出快捷访问<\/span>/)
})

test('quick access drag uses insertion gaps and cleans up abandoned drags (#325 review)', () => {
  const source = readFileSync(new URL('../src/components/SidebarQuickAccess.tsx', import.meta.url), 'utf8')
  assert.match(source, /const dropTarget = \(from: number, gap: number\): number => gap > from \? gap - 1 : gap/)
  assert.match(source, /if \(commit && target !== drag\.from\) move\(drag\.from, target\)/)
  assert.match(source, /if \(event\.key !== 'Escape' \|\| !dragRef\.current\?\.active\) return/)
  assert.match(source, /document\.addEventListener\('pointerup', onUp\)/)
  assert.match(source, /window\.addEventListener\('blur', cancel\)/)
  assert.match(source, /window\.setTimeout\(\(\) => \{ suppressClick\.current = false \}, 0\)/)
  // Hooks stay above the empty-list early return.
  assert.ok(source.indexOf('const dragRef = useRef') < source.indexOf('if (entries.length === 0) return null'))
})

test('a drag cancelled with Escape does not click the item on release (#325 review)', () => {
  const source = readFileSync(new URL('../src/components/SidebarQuickAccess.tsx', import.meta.url), 'utf8')
  assert.match(source, /document\.addEventListener\('pointerup', release, \{ once: true, capture: true \}\)/)
})
