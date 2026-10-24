import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'

// Render the actual inline notice without starting the Tauri settings page.
const page = readFileSync(new URL('../src/pages/SettingsPage.tsx', import.meta.url), 'utf8')
const source = page.slice(page.indexOf('function RuntimeCliPathNotice('), page.indexOf('export default function SettingsPage'))
const compiled = ts.transpileModule(`${source}\nreturn RuntimeCliPathNotice`, {
  compilerOptions: { jsx: ts.JsxEmit.React, jsxFactory: 'createElement', target: ts.ScriptTarget.ES2022 },
}).outputText
const messages: string[] = []
const Notice = new Function('createElement', 'Icon', 'toast', 'userMessage', compiled)(
  createElement, () => null, (message: string) => messages.push(message), String,
) as (props: { guidance: { message: string; command: string | null } }) => ReactElement

test('Windows notice always renders and has no copy command', () => {
  const html = renderToStaticMarkup(Notice({ guidance: { message: '新打开的终端才会看到 skillhub', command: null } }))
  assert.match(html, /新打开的终端才会看到 skillhub/)
  assert.doesNotMatch(html, /<button|<code/)
  assert.match(page, /id="settings-help"[^]*runtimeCliStatus\?\.pathGuidance && <div className="settings-row"><RuntimeCliPathNotice/)
  const styles = readFileSync(new URL('../src/pages/SettingsPage.css', import.meta.url), 'utf8')
  assert.match(styles, /\.cli-path-notice span, \.cli-path-notice code \{[^}]*white-space: normal;[^}]*overflow-wrap: anywhere/)
})

test('bash and fish commands render verbatim and copy with success and error feedback', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  let copied = ''
  let denied = false
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: {
    writeText: async (text: string): Promise<void> => {
      if (denied) throw new Error('clipboard denied')
      copied = text
    },
  } } })
  try {
    for (const [shell, command] of [
      ['bash', 'export PATH="$HOME/.local/bin:$PATH"'],
      ['fish', 'set -gx PATH "$HOME/.local/bin" $PATH'],
    ]) {
      const tree = Notice({ guidance: { message: `默认 shell 为 ${shell}`, command } })
      assert.match(renderToStaticMarkup(tree), new RegExp(`默认 shell 为 ${shell}`))
      const content = (tree.props as { children: ReactElement[] }).children[1]
      const children = (content.props as { children: ReactElement[] }).children
      assert.equal((children[2].props as { children: string }).children, command)
      ;(children[3].props as { onClick: () => void }).onClick()
      await new Promise(resolve => setImmediate(resolve))
      assert.equal(copied, command)
      assert.equal(messages.at(-1), 'PATH 命令已复制')
      denied = true
      ;(children[3].props as { onClick: () => void }).onClick()
      await new Promise(resolve => setImmediate(resolve))
      assert.match(messages.at(-1) ?? '', /clipboard denied/)
      denied = false
    }
  } finally {
    if (previous) Object.defineProperty(globalThis, 'navigator', previous)
    else Reflect.deleteProperty(globalThis, 'navigator')
  }
})
