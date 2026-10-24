import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'
import { formatBytes } from '../src/lib/env-backups.ts'

const require = createRequire(import.meta.url)
const source = readFileSync(new URL('../src/pages/SettingsPage.tsx', import.meta.url), 'utf8')
const card = source.slice(source.indexOf('<div className="agent-runtime-notice cli-storage-notice"'), source.indexOf('</div></div>', source.indexOf('<div className="agent-runtime-notice cli-storage-notice"')) + '</div>'.length)
function render(overrides: Record<string, unknown> = {}): string {
  const values = {
    cliStorage: { currentBytes: 2048, reclaimableCount: 2, reclaimableBytes: 1024, warnings: [] },
    cliStorageBusy: false, runtimeCliChecking: false, runtimeCliUnmanaged: false,
    runtimeCliStatus: { managed: true }, cliStorageError: null, cliCleanupWarnings: [],
    cleanCliStorage: () => {}, reloadCliStorage: () => {}, formatBytes,
    Icon: () => null, ...overrides,
  }
  const output = ts.transpileModule(`export function render() { return (${card}) }`, {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const exports: { render?: () => React.ReactNode } = {}
  new Function('require', 'exports', ...Object.keys(values), output)(require, exports, ...Object.values(values))
  return renderToStaticMarkup(exports.render!())
}

test('CLI storage card shows bytes/count, hides cleanup for empty or Dev, and disables busy actions', () => {
  assert.match(render(), /当前副本 2 KB · 可清理旧副本 2 个（1 KB）/)
  assert.match(render(), /清理旧副本/)
  assert.doesNotMatch(render({ cliStorage: { currentBytes: 2048, reclaimableCount: 0, reclaimableBytes: 0, warnings: [] } }), /清理旧副本<\/button>/)
  const dev = render({ runtimeCliUnmanaged: true, runtimeCliStatus: { managed: false } })
  assert.match(dev, /请在正式版中清理旧副本/)
  assert.equal((dev.match(/<button/g) ?? []).length, 1)
  assert.match(render({ cliStorageBusy: true }), /disabled=""[^>]*>正在清理/)
})

test('CLI storage card displays loading, read failures and each retained-file reason', () => {
  assert.match(render({ cliStorage: null }), /正在统计占用/)
  assert.match(render({ cliStorage: null, cliStorageError: 'permission denied' }), /无法读取占用：permission denied/)
  const warnings = ['copy-a：permission denied', 'copy-b：changed residue']
  const html = render({ cliCleanupWarnings: warnings, cliStorage: { currentBytes: 0, reclaimableCount: 0, reclaimableBytes: 0, warnings } })
  assert.equal((html.match(/role="alert"/g) ?? []).length, 2)
  for (const warning of warnings) assert.ok(html.includes(warning))
})

function cleanupHandler(values: Record<string, unknown>): () => Promise<void> {
  const body = source.slice(source.indexOf('  const cleanCliStorage ='), source.indexOf('  const checkRuntimeCli ='))
  const output = ts.transpileModule(`${body}\nreturn cleanCliStorage`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  return new Function(...Object.keys(values), output)(...Object.values(values)) as () => Promise<void>
}

test('cleanup refreshes counts, reports released bytes and partial failures, and blocks duplicate clicks', async () => {
  let calls = 0
  let refreshed = 0
  let busy = false
  let warnings: string[] = []
  const notifications: unknown[][] = []
  const handler = cleanupHandler({
    cliStorageBusyRef: { current: false }, runtimeCliChecking: false, runtimeCliStatus: { managed: true },
    setCliStorageBusy: (value: boolean) => { busy = value },
    setCliCleanupWarnings: (value: string[]) => { warnings = value },
    cleanupRuntimeCli: async () => { calls++; return { deletedCount: 2, freedBytes: 1024, warnings: ['copy：denied'] } },
    refreshCliStorage: async () => { refreshed++ },
    toast: (...args: unknown[]) => notifications.push(args), formatBytes, messageOf: String,
  })
  await Promise.all([handler(), handler()])
  assert.equal(calls, 1)
  assert.equal(refreshed, 1)
  assert.equal(busy, false)
  assert.deepEqual(warnings, ['copy：denied'])
  assert.deepEqual(notifications, [['已清理 2 个旧副本，释放 1 KB', 'warn']])
})

test('cleanup invocation failure stays visible, refreshes storage and releases busy state', async () => {
  const busyRef = { current: false }
  let warnings: string[] = []
  let refreshed = false
  const values = {
    cliStorageBusyRef: busyRef, runtimeCliChecking: false, runtimeCliStatus: { managed: true },
    setCliStorageBusy: () => {}, setCliCleanupWarnings: (value: string[]) => { warnings = value },
    cleanupRuntimeCli: async () => { throw new Error('locked') },
    refreshCliStorage: async () => { refreshed = true }, toast: () => assert.fail('no success toast'), formatBytes, messageOf: String,
  }
  await cleanupHandler(values)()
  assert.deepEqual(warnings, ['Error: locked'])
  assert.equal(refreshed, true)
  assert.equal(busyRef.current, false)
  refreshed = false
  await cleanupHandler({ ...values, runtimeCliStatus: { managed: false } })()
  assert.equal(refreshed, false)
})

test('storage reads are separate from status polling and both commands are wired through Tauri', () => {
  const polling = source.slice(source.indexOf('    const timer = window.setInterval'), source.indexOf('  const runtimeCliReady'))
  assert.doesNotMatch(polling.split('  useEffect')[0], /refreshCliStorage|getRuntimeCliStorage/)
  assert.match(polling, /\}, \[refreshCliStorage\]\)/)
  const bridge = readFileSync(new URL('../src/lib/tauri.ts', import.meta.url), 'utf8')
  const registration = readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8')
  for (const command of ['get_runtime_cli_storage', 'cleanup_runtime_cli']) {
    assert.ok(bridge.includes(`('${command}')`))
    assert.ok(registration.includes(`runtime_env::${command},`))
  }
})
