import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { blankDragAttributes } from '../src/lib/window-drag.ts'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = (path: string): string => readFileSync(resolve(desktopRoot, path), 'utf8')

test('blank regions use the bare direct-hit attribute and leave double-click to the native drag script', () => {
  assert.deepEqual(blankDragAttributes(), { 'data-tauri-drag-region': true })
  const region = source('src/components/WindowDragRegion.tsx')
  // Tauri 2.11.5 drag.js already toggles maximize on a direct double-click
  // (`internal_toggle_maximize`, granted by `core:default`); a second React
  // handler would toggle twice. The region therefore carries only the attribute.
  assert.doesNotMatch(region, /onDoubleClick|toggleMaximize|getCurrentWindow|startDragging|'deep'|"deep"/)
  assert.match(region, /return blankDragAttributes\(\)/)
  const capability = source('src-tauri/capabilities/default.json')
  assert.match(capability, /"core:default"/)
  assert.match(capability, /"core:window:allow-start-dragging"/)
})

test('page heads and the detail header carry the drag region on their blank containers only', () => {
  // Every page head goes through PageHeading, which marks its three blank containers.
  const heading = source('src/components/PageHeading.tsx')
  assert.match(heading, /className="page-head" \{\.\.\.blankDragRegion\(\)\} ref=\{headRef\}/)
  assert.match(heading, /className="page-head-inner" \{\.\.\.blankDragRegion\(\)\}/)
  assert.match(heading, /className=\{\['page-title-row', className \?\? ''\]\.filter\(Boolean\)\.join\(' '\)\} \{\.\.\.blankDragRegion\(\)\}/)
  assert.doesNotMatch(heading, /<h1 \{\.\.\.blankDragRegion|page-subtitle" \{\.\.\.blankDragRegion/)
  for (const page of ['SkillsPage', 'MarketplacePage', 'TeamSharedPage', 'TeamsPage', 'SettingsPage', 'KeysPage']) {
    const text = source(`src/pages/${page}.tsx`)
    assert.match(text, /<PageHeading\b/, page)
    assert.doesNotMatch(text, /className="page-head"|<h1/, `${page}: the head comes from PageHeading`)
    assert.doesNotMatch(text, /<span className="sp" \/>/, `${page}: spacer must be the drag spacer`)
    // Scrollers, list bodies and the marquee canvas are never drag regions.
    assert.doesNotMatch(text, /className="page-body[^"]*" \{\.\.\.blankDragRegion|className="category-scroll" \{\.\.\.blankDragRegion|data-tauri-drag-region="deep"/, page)
  }
  const skills = source('src/pages/SkillsPage.tsx')
  assert.match(skills, /className="toolbar skills-filter-row" \{\.\.\.blankDragRegion\(\)\}/)
  assert.match(skills, /<BlankDragSpacer \/>/)
  const sheet = source('src/components/SkillDetailSheet.tsx')
  for (const cls of ['sh-head', 'sh-id', 'sh-idtx', 'sh-meta', 'sh-act']) {
    assert.match(sheet, new RegExp(`className="${cls}" \\{\\.\\.\\.blankDragRegion\\(\\)\\}`), cls)
  }
  // Text, tabs' buttons, the body panel and dialogs are not marked.
  assert.doesNotMatch(sheet, /<h2 \{\.\.\.blankDragRegion|<p[^>]*\{\.\.\.blankDragRegion|className="sh-body"[^>]*blankDragRegion|data-tauri-drag-region="deep"/)
  const list = source('src/components/SkillLibraryList.tsx')
  assert.doesNotMatch(list, /blankDragRegion|data-tauri-drag-region/)
  // The title bar blank uses the same single native handler: no React double-click
  // on the drag region; the maximize *button* keeps its explicit action.
  const controls = source('src/components/WindowControls.tsx')
  assert.match(controls, /className="window-drag-region" data-tauri-drag-region aria-hidden="true" \/>/)
  assert.doesNotMatch(controls, /onDoubleClick/)
  assert.match(controls, /className="window-control maximize"[^\n]*onClick=\{\(\) => invokeWindowAction\('toggleMaximize'\)\}/)
})

test('the sidebar resize separator is never part of a window drag region', () => {
  const resizer = source('src/components/SidebarResizer.tsx').replace(/\/\*[\s\S]*?\*\//g, '')
  // No drag attribute on the separator itself: a direct hit resizes, never drags.
  assert.doesNotMatch(resizer, /data-tauri-drag-region|blankDragRegion|startDragging/)
  // The press is consumed (no text selection, no native drag script fallback).
  assert.match(source('src/lib/sidebar-width.ts'), /pointerDown\(event\) \{[^]*event\.preventDefault\(\)[^]*setPointerCapture/)
  const sidebar = source('src/components/Sidebar.tsx')
  // The separator is a direct child of the sidebar, outside the drag-marked brand
  // row and window chrome, and the sidebar itself is not a drag region.
  assert.match(sidebar, /<SidebarResizer targetRef=\{sidebarRef\}[^\n]*\/>\n\s+<\/aside>/)
  assert.doesNotMatch(sidebar, /<aside className="sidebar"[^>]*data-tauri-drag-region/)
  const css = source('src/styles/app.css')
  assert.match(css, /\.sidebar-resizer \{[^}]*-webkit-app-region: no-drag;/)
  // Scroll areas stay outside the drag regions as before.
  assert.doesNotMatch(css, /\.app-main[^{]*\{[^}]*-webkit-app-region: drag/)
})
