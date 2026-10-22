import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

function ordered(source: string, first: string, second: string): boolean {
  const firstIndex = source.indexOf(first)
  return firstIndex >= 0 && source.indexOf(second, firstIndex + first.length) > firstIndex
}

test('portal login commits WebView auth only after native promotion', () => {
  const app = readFileSync('src/App.tsx', 'utf8')
  const dialog = readFileSync('src/components/AuthDialog.tsx', 'utf8')
  const commit = app.slice(
    app.indexOf('const commitAuthenticatedSession'),
    app.indexOf('useEffect(() => onApiUnauthorized'),
  )

  assert.ok(ordered(commit, 'await authState()', 'setAuthSession('))
  assert.match(dialog, /await onAuthenticated\(session\)/)
  assert.doesNotMatch(dialog, /setAuthSession\(/)
})

test('native auth transitions begin fail-closed and promote by matching generation', () => {
  const app = readFileSync('src/App.tsx', 'utf8')
  const tauri = readFileSync('src/lib/tauri.ts', 'utf8')
  const reconcile = app.slice(
    app.indexOf('const commitAuthenticatedSession'),
    app.indexOf('const restorePersistedSession'),
  )

  assert.ok(ordered(reconcile, 'await authState()', 'setAuthSession('))
  assert.match(reconcile, /sameSpace\(state, session.space\)/)
  assert.doesNotMatch(tauri, /syncRuntimeSession|beginRuntimeSessionTransition/)
  assert.match(tauri, /clearNativeAuthSession\(space: SpaceHandle\)/)
})

test('account switching and legacy-account linking do not expose a WebView-only login', () => {
  const app = readFileSync('src/App.tsx', 'utf8')
  const settings = readFileSync('src/components/AccountSettings.tsx', 'utf8')
  const useAnotherAccount = app.slice(
    app.indexOf('onUseAnotherAccount={async'),
    app.indexOf('onAuthenticated=', app.indexOf('onUseAnotherAccount={async')),
  )
  const linkFlow = settings.slice(
    settings.indexOf('const linkYitanAccount'),
    settings.indexOf('const signOut'),
  )

  assert.ok(ordered(useAnotherAccount, 'await clearNativeAuthSession', 'clearAuthSession()'))
  assert.ok(ordered(linkFlow, "startYitanPortalAuth('link', currentUser.id)", 'await authState()'))
  assert.ok(ordered(linkFlow, 'sameSpace(state, session.space)', 'setAuthSession('))
  assert.match(linkFlow, /本机账号同步失败，请重新登录/)
  assert.ok(ordered(linkFlow, "message.startsWith('本机 skillhub 命令同步失败：')", 'clearAuthSession()'))
})
