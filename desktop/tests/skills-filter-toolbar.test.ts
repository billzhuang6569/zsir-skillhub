import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

test('filter triggers show icons, labels and chevrons (#488)', () => {
  const page = read('src/pages/SkillsPage.tsx')
  const triggers = page.match(/className="agent-filter-trigger"[^>]*>/g) ?? []
  assert.equal(triggers.length, 2)
  for (const trigger of triggers) {
    assert.doesNotMatch(trigger, /data-compact/)
    assert.match(trigger, /data-active=\{/)
    assert.match(trigger, /aria-label=\{`/)
    assert.match(trigger, /title=\{`/)
  }
  const css = read('src/styles/app.css')
  assert.doesNotMatch(css, /data-compact/)
  assert.match(css, /\.agent-filter-trigger\[data-active\]::after/)
  assert.match(page, /className="agent-filter-trigger-label">\{scope === 'all' \? '共享范围' : current\?\.label\}/)
  assert.match(page, /className="agent-filter-trigger-label">\{selectedAgent\?\.name \?\? 'Agent'\}/)
  assert.match(page, /aria-label=\{`共享范围：\$\{current\?\.label \?\? '所有'\}`\}/)
  assert.match(page, /aria-label=\{`Agent 筛选：\$\{selectedAgent\?\.name \?\? '所有 Agent'\}`\}/)
  assert.match(page, /\{ value: 'all', label: '所有' \}/)
  assert.match(page, /<span>所有 Agent<\/span>/)
  assert.equal((page.match(/<Icon name="chev" size=\{13\} \/>/g) ?? []).length, 2)
  assert.match(page, /if \(!capabilities\.teams\) return null/)
})

test('the sort control shows icons and text and persists on this computer (#488)', () => {
  const page = read('src/pages/SkillsPage.tsx')
  assert.match(page, /role="group" aria-label="排序"/)
  assert.match(page, /aria-pressed=\{selected\} aria-label=\{description\} title=\{description\}/)
  assert.match(page, /value: 'time', reverse: 'time-asc', label: '按时间', icon: 'clock'/)
  assert.match(page, /value: 'name', reverse: 'name-desc', label: '按名称', icon: 'type'/)
  assert.match(page, /<Icon name=\{option\.icon\} size=\{15\} \/><span>\{option\.label\}<\/span>/)
  // The account list honours the preference and its memo re-runs when it changes; 本地 Skills have no timestamps.
  assert.match(page, /orderSkills\(managedSkills\.filter/)
  assert.match(page, /\), skillSortPreference\)\n\s+\}, \[agentFilter, categoryFilter, currentUser\?\.id, managedScope, managedSkills, searchQuery, skillSortPreference, teamIds\]\)/)
  assert.match(page, /orderSkillsByName\(unmanagedSkills\.filter/)
  const store = read('src/store/index.ts')
  assert.match(store, /SKILL_SORT_PREFERENCE_KEY = 'yitan-skillhub\.skill-sort-preference\.v1'/)
  assert.match(store, /setSkillSortPreference: \(skillSortPreference\) => \{\s+writePreference\(SKILL_SORT_PREFERENCE_KEY, skillSortPreference\)/)
})

test('the shared toolbar puts sorting first and right-aligns wrapping filters (#488)', () => {
  const page = read('src/pages/SkillsPage.tsx')
  assert.match(page, /className="skills-filter-bar">\s*<SkillSortControl[^>]+\/>\s*<div className="skills-filter-controls">/)
  assert.equal((page.match(/className="skills-filter-bar"/g) ?? []).length, 1)
  const css = read('src/styles/app.css')
  assert.match(css, /\.skills-filter-bar \{[^}]*justify-content: space-between;[^}]*flex-wrap: wrap;/)
  assert.match(css, /\.skills-filter-controls \{[^}]*justify-content: flex-end;[^}]*margin-left: auto;[^}]*flex-wrap: wrap;/)
  assert.match(css, /\.skills-filter-controls \.agent-filter-menu \{ left: auto; right: 0; \}/)
  assert.match(css, /\.skills-sort-button \{[^}]*display: inline-flex;[^}]*padding: 0 10px; gap: 6px; height: 30px;[^}]*var\(--font-size-caption\)/)
  assert.match(css, /\.skills-sort-button\[aria-pressed="true"\] \{ background: var\(--color-brand-tint\); color: var\(--color-brand-strong\); \}/)
})
