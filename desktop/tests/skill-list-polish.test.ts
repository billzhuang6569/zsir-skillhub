import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import ts from 'typescript'
import { createElement, type ReactElement } from 'react'
import { unmanagedLocalSkills, isGenericLocalSkill } from '../src/lib/skill-library.ts'

const read = (path: string): string => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8')
const page = read('pages/SkillsPage.tsx')

test('local inventory excludes managed identities and projections before counting', () => {
  const free = { name: 'same-name', localPath: '/agent/independent' }
  assert.deepEqual(unmanagedLocalSkills([free, { name: 'same-name', localPath: '/managed/skill' }, { localPath: '/bound', managedSkillId: 'id' }], new Set(['/managed/skill'])), [free])
  assert.equal(isGenericLocalSkill({ sources: [{ agentKey: 'agent-skills' }] }), true)
  assert.equal(isGenericLocalSkill({ sources: [] }), true)
  assert.equal(isGenericLocalSkill({ sources: [{ agentKey: 'codex' }] }), false)
  assert.match(page, /count: unmanagedSkills.length/)
  assert.match(page, /managedOutsideAccount/)
})

test('kept local recovery entries survive managed filtering and remain counted', () => {
  const kept = { localPath: '/managed/kept', managedSkillId: 'kept', joinLocalId: 'local-id' }
  const ordinary = { localPath: '/managed/ordinary', managedSkillId: 'ordinary' }
  const otherAccount = { localPath: '/managed/other', managedSkillId: 'other', joinLocalId: undefined }
  const projection = { localPath: '/managed/ordinary' }
  const visible = unmanagedLocalSkills([kept, ordinary, otherAccount, projection], new Set([kept.localPath, ordinary.localPath, otherAccount.localPath]))
  assert.deepEqual(visible, [kept])
  assert.equal(visible.length, 1)
  assert.equal(isGenericLocalSkill({ ...kept, sources: [{ agentKey: 'skillhub' }] }), true)
  assert.match(page, /sources: \[\{ agentKey: 'skillhub', agentName: 'SkillHub', entryName: skill.id \}\]/)
  assert.match(page, /status.userId === expectedUserId/)
  assert.match(page, /keptLocalState\?\.userId === currentUser\?\.id/)
  assert.match(page, /!skill.libraryAccountId \? keptLocal.find/)
  assert.match(page, /localSkillPreview.joinLocalId === selected.joinLocalId/)
  assert.match(read('components/LocalSkillPreviewPanel.tsx'), /libraryJoinLocal\(\[skill.joinLocalId!/)
})

test('local icon filters toggle by detected Agent key and offer generic only when needed', () => {
  const start = page.indexOf('<div className="local-agent-filters"')
  const jsx = page.slice(start, page.indexOf('</div> :', start) + 6)
  const compiled = ts.transpileModule(`return (${jsx})`, { compilerOptions: { jsx: ts.JsxEmit.React, jsxFactory: 'createElement' } }).outputText
  type Button = ReactElement<{ onClick: () => void; title: string; 'aria-label': string; 'aria-pressed': boolean }>
  let selected = ''
  const render = (generic: boolean): ReactElement<{ children: [Button[], Button | false] }> => new Function('createElement', 'AgentBrandIcon', 'Icon', 'detectedAgents', 'hasGenericSkills', 'localAgentFilter', 'setLocalAgentFilter', compiled)(createElement, () => null, () => null, [{ key: 'codex', name: 'Codex' }], generic, selected, (update: (current: string) => string) => { selected = update(selected) })
  let tree = render(false)
  assert.equal(tree.props.children[1], false)
  const button = tree.props.children[0][0]
  assert.equal(button.props.title, 'Codex')
  assert.equal(button.props['aria-label'], 'Codex')
  button.props.onClick()
  assert.equal(selected, 'codex')
  tree = render(true)
  assert.equal(tree.props.children[0][0].props['aria-pressed'], true)
  tree.props.children[0][0].props.onClick()
  assert.equal(selected, '')
  const generic = render(true).props.children[1] as Button
  generic.props.onClick()
  assert.equal(selected, 'generic')
  ;(render(true).props.children[1] as Button).props.onClick()
  assert.equal(selected, '')
  assert.match(page, /skill.sources.some\(source => source.agentKey === localAgentFilter\)/)
})

test('empty and initial skill workspaces reserve the detail column; lists share name behavior', () => {
  const app = read('App.tsx')
  assert.match(app, /skillWorkspaceAvailable \|\| localSkillWorkspace \? ' skill-browser-open'/)
  assert.match(app, /skillWorkspaceAvailable && !workspaceSkillSheet/)
  assert.match(app, /选择一个 Skill 查看详情/)
  for (const file of ['SkillLibraryList', 'UnmanagedSkillCard']) {
    const source = read(`components/${file}.tsx`)
    assert.match(source, /<SkillListName name=\{title.primary\}/)
    assert.match(source, /UNANALYSED_SKILL_NAME|尚未分析技能名/)
  }
  assert.doesNotMatch(read('components/SkillLibraryList.tsx'), /inline-status checking.*未分析/)
  assert.match(read('components/SkillDetailSheet.tsx'), /未分析/)
  assert.match(read('components/SkillListName.css'), /prefers-reduced-motion: no-preference/)
  assert.match(read('components/SkillListName.css'), /data-overflow="true"\]:hover/)
  assert.match(read('components/SkillCard.css'), /local-library-name-row \{[^}]*flex-wrap: nowrap/)
  assert.match(read('styles/app.css'), /scrollbar-gutter: stable/)
})
