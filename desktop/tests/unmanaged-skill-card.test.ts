import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import ts from 'typescript'
import type { ReactElement } from 'react'
import { findLocalSkillByManagedId } from '../src/lib/skills.ts'
import { skillListText, truncateSkillName } from '../src/lib/skill-title.ts'

type Element = ReactElement<Record<string, unknown>>

test('long name measures overflow on hover and keeps full accessible title', () => {
  const properties = new Map<string, string>()
  const node = { clientWidth: 100, dataset: { overflow: '' }, style: { setProperty: (key: string, value: string) => properties.set(key, value) }, querySelector: () => ({ scrollWidth: 240 }) }
  const { default: Name } = loadComponent('SkillListName', {
    react: { useRef: () => ({ current: node }) },
    '../lib/skill-title.js': { truncateSkillName }, './SkillListName.css': {},
  })
  const name = 'a'.repeat(30)
  const tree = Name({ name }) as Element
  assert.equal(tree.props.title, name)
  assert.equal(tree.props['aria-label'], name)
  ;(tree.props.onMouseEnter as () => void)()
  assert.equal(node.dataset.overflow, 'true')
  assert.equal(properties.get('--name-travel'), '-140px')
  node.clientWidth = 300
  ;(tree.props.onMouseEnter as () => void)()
  assert.equal(node.dataset.overflow, 'false')
})
const require = createRequire(import.meta.url)
function loadComponent(name: string, mocks: Record<string, unknown>): Record<string, Function> {
  const source = readFileSync(new URL(`../src/components/${name}.tsx`, import.meta.url), 'utf8')
  const output = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS } }).outputText
  const exports = {}
  new Function('require', 'exports', output)((id: string) => id in mocks ? mocks[id] : require(id), exports)
  return exports
}

test('local card resolves exact managed identity, refreshes avatars and preserves both title preferences', () => {
  const state = { skills: [{ id: 'managed-id', name: 'same-name', avatarUrl: 'https://images.test/old.jpg' }], skillTitlePreference: 'skill-name' }
  const selectors: Array<(value: typeof state) => unknown> = []
  const Avatar = (): null => null
  const { default: Card } = loadComponent('UnmanagedSkillCard', {
    '../store/index.js': { useStore: (selector: (value: typeof state) => unknown) => { selectors.push(selector); return selector(state) } },
    '../lib/skills.js': { findLocalSkillByManagedId },
    '../lib/skill-title.js': { skillListText },
    './SkillAvatarIcon.js': { SkillAvatarIcon: Avatar },
    './Icon.js': { Icon: () => null }, './SkillCard.css': {}, './SkillListName.js': { default: () => null },
  })
  const skill = { id: 'agent-entry', managedSkillId: 'managed-id', name: 'same-name', displayName: 'AI 标题', version: '1.0.0', localPath: '/test/skill', sources: [] }
  const keptCard = Card({ skill: { ...skill, joinLocalId: 'local-id' }, alreadyManaged: true, previewed: true }) as Element
  const keptState = (keptCard.props.children as Element[])[2].props.children as Element
  assert.equal(keptState.props.children, '待加入')
  function render(managedSkillId: string | undefined = 'managed-id', alreadyManaged = true): Element[] {
    return (Card({ skill: { ...skill, managedSkillId }, alreadyManaged, previewed: true }) as Element).props.children as Element[]
  }
  assert.equal(render()[0].type, Avatar)
  assert.deepEqual(render()[0].props, { avatarUrl: state.skills[0].avatarUrl, size: 44 })
  const avatarSelector = selectors[1]
  state.skills = [{ ...state.skills[0], avatarUrl: 'https://images.test/new.jpg' }]
  assert.equal(avatarSelector(state), state.skills[0].avatarUrl)
  assert.equal(render()[0].props.avatarUrl, state.skills[0].avatarUrl)
  assert.equal(render('missing-id')[0].props.avatarUrl, undefined)
  assert.equal(render('same-name')[0].props.avatarUrl, undefined)
  assert.equal(render('')[0].props.avatarUrl, undefined)
  assert.equal(render('', false)[0].props.avatarUrl, undefined)
  state.skills = [{ ...state.skills[0], avatarUrl: '' }]
  assert.equal(render()[0].props.avatarUrl, '')
  for (const preference of ['skill-name', 'ai-title']) {
    state.skillTitlePreference = preference
    const copy = render()[1].props.children as Element[]
    const nameRow = copy[0].props.children as Element[]
    assert.equal(nameRow[0].props.name, preference === 'skill-name' ? skill.name : skill.displayName)
  }
})

test('shared avatar falls back on missing or failed images and retries a changed URL', () => {
  let failed: string | null = null
  const { SkillAvatarIcon } = loadComponent('SkillAvatarIcon', {
    react: { useState: () => [failed, (value: string) => { failed = value }] },
    '../lib/media.js': { useMediaUrl: (url?: string) => url },
  })
  const render = (avatarUrl?: string): Element => SkillAvatarIcon({ avatarUrl, size: 44 }) as Element
  assert.equal(render().props['data-skill-avatar'], 'placeholder')
  assert.equal(render('old').props['data-skill-avatar'], 'image')
  const image = render('old').props.children as Element
  ;(image.props.onError as () => void)()
  assert.equal(render('old').props['data-skill-avatar'], 'placeholder')
  assert.equal(render('new').props['data-skill-avatar'], 'image')
})
