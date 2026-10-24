import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'
import type { SkillSortPreference } from '../src/lib/skill-library.ts'

const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
  if (context.parentURL?.includes('/desktop/src/') && specifier.startsWith('.') && specifier.endsWith('.js')) {
    const candidate = new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL)
    if (existsSync(fileURLToPath(candidate))) return nextResolve(candidate.href, context)
  }
  return nextResolve(specifier, context)
} })
const { readSkillSortPreference, useStore } = await import('../src/store/index.ts')
hooks.deregister()

test('store reads legacy values, round-trips all directions, and tolerates unavailable storage', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const memory = new Map<string, string>()
  const key = 'yitan-skillhub.skill-sort-preference.v1'
  try {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
      getItem: (key: string): string | null => memory.get(key) ?? null,
      setItem: (key: string, value: string): void => { memory.set(key, value) },
    } })
    assert.equal(readSkillSortPreference(), 'name')
    for (const preference of ['name', 'time', 'name-desc', 'time-asc'] as const) {
      memory.set(key, preference)
      assert.equal(readSkillSortPreference(), preference)
      useStore.getState().setSkillSortPreference(preference)
      assert.equal(memory.get(key), preference)
      assert.equal(useStore.getState().skillSortPreference, preference)
      assert.equal(readSkillSortPreference(), preference)
    }
    memory.set(key, 'invalid')
    assert.equal(readSkillSortPreference(), 'name')
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
      getItem: (): never => { throw new Error('storage unavailable') },
      setItem: (): never => { throw new Error('storage full') },
    } })
    assert.equal(readSkillSortPreference(), 'name')
    useStore.getState().setSkillSortPreference('time-asc')
    assert.equal(useStore.getState().skillSortPreference, 'time-asc')
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: (): never => { throw new Error('denied') } })
    assert.equal(readSkillSortPreference(), 'name')
  } finally {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous)
    else Reflect.deleteProperty(globalThis, 'localStorage')
  }
})

// Exercise the actual inline control without loading the entire Tauri page in Node.
const page = readFileSync(new URL('../src/pages/SkillsPage.tsx', import.meta.url), 'utf8')
const control = page.slice(page.indexOf('const SORT_OPTIONS:'), page.indexOf('\nfunction EmptyManagedSkills'))
const compiled = ts.transpileModule(`${control}\nreturn SkillSortControl`, {
  compilerOptions: { jsx: ts.JsxEmit.React, jsxFactory: 'createElement', target: ts.ScriptTarget.ES2022 },
}).outputText
type ButtonProps = { onClick: () => void; 'aria-pressed': boolean; 'aria-label': string; title: string }
const SkillSortControl = new Function('createElement', 'Icon', compiled)(createElement, () => null) as
  (props: { value: SkillSortPreference; onChange: (value: SkillSortPreference) => void }) => ReactElement<{ children: ReactElement<ButtonProps>[] }>

test('sort buttons toggle repeatedly, reset on criterion change, and describe current and next directions', () => {
  let value: SkillSortPreference = 'time'
  const render = (): ReturnType<typeof SkillSortControl> => SkillSortControl({ value, onChange: next => { value = next } })
  assert.equal(render().props.children[0].props.title, '按时间：最新在前，再次点击切换为最早在前')
  assert.equal(render().props.children[1].props.title, '按名称：点击切换为A→Z')
  for (const [button, expected, text, arrow] of [
    [0, 'time-asc', '最早在前', '↑'], [0, 'time', '最新在前', '↓'], [0, 'time-asc', '最早在前', '↑'],
    [1, 'name', 'A→Z', '↑'], [1, 'name-desc', 'Z→A', '↓'], [1, 'name', 'A→Z', '↑'],
    [1, 'name-desc', 'Z→A', '↓'], [0, 'time', '最新在前', '↓'], [1, 'name', 'A→Z', '↑'],
  ] as const) {
    render().props.children[button].props.onClick()
    assert.equal(value, expected)
    const tree = render()
    const selected = tree.props.children[button].props
    assert.equal(selected['aria-pressed'], true)
    assert.equal(tree.props.children[1 - button].props['aria-pressed'], false)
    assert.equal(selected.title, selected['aria-label'])
    const nextText = text === '最早在前' ? '最新在前' : text === '最新在前' ? '最早在前' : text === 'A→Z' ? 'Z→A' : 'A→Z'
    assert.equal(selected.title, `${button === 0 ? '按时间' : '按名称'}：${text}，再次点击切换为${nextText}`)
    const markup = renderToStaticMarkup(tree)
    assert.ok(markup.includes(`<span aria-hidden="true">${arrow}</span>`))
    assert.equal((markup.match(/aria-hidden="true"/g) ?? []).length, 1)
  }
})
