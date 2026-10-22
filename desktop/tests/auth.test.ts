import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  AUTH_TOKEN_STORAGE_KEY,
  importLegacyAuth,
  hadLegacySession,
  authErrorMessage,
  normalizeEmail,
  userInitials,
  validateLoginFields,
  validateRegisterFields,
} from '../src/lib/auth.ts'

function memoryStorage() {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
    removeItem: (key: string) => { values.delete(key) },
    values,
  }
}

for (const accepted of [true, false]) {
  test(`legacy import ${accepted ? 'success' : '401'} deletes the key`, async () => {
    const storage = memoryStorage()
    storage.setItem(AUTH_TOKEN_STORAGE_KEY, 'legacy.jwt')
    let received = ''
    await importLegacyAuth(async token => { received = token; return accepted }, storage)
    assert.equal(hadLegacySession(), true, 'even a rejected legacy session is existing installation evidence')
    assert.equal(received, 'legacy.jwt')
    assert.equal(storage.getItem(AUTH_TOKEN_STORAGE_KEY), null)
  })
}
test('legacy import network failure keeps the key for retry', async () => {
  const storage = memoryStorage()
  storage.setItem(AUTH_TOKEN_STORAGE_KEY, 'legacy.jwt')
  await assert.rejects(importLegacyAuth(async () => { throw new Error('offline') }, storage), /offline/)
  assert.equal(storage.getItem(AUTH_TOKEN_STORAGE_KEY), 'legacy.jwt')
})

test('login validation normalizes email and blocks invalid credentials locally', () => {
  assert.equal(normalizeEmail('  USER@Example.COM '), 'user@example.com')
  assert.deepEqual(validateLoginFields({ email: 'broken', password: 'short' }), {
    email: '请输入有效的邮箱地址',
    password: '密码至少需要 6 个字符',
  })
  assert.deepEqual(validateLoginFields({ email: 'user@example.com', password: '12345' }), { password: '密码至少需要 6 个字符' })
  assert.deepEqual(validateLoginFields({ email: 'user@example.com', password: '123456' }), {})
})

test('registration requires a real display name and server-compatible password lengths', () => {
  assert.deepEqual(validateRegisterFields({ email: 'user@example.com', password: '123456', displayName: '  ' }), {
    displayName: '请输入显示名称',
  })
  assert.equal(validateRegisterFields({
    email: 'user@example.com',
    password: 'a'.repeat(129),
    displayName: 'Bill',
  }).password, '密码不能超过 128 个字符')
  assert.deepEqual(validateRegisterFields({
    email: 'user@example.com',
    password: '123456',
    displayName: 'Bill',
  }), {})
})

test('authentication failures are translated without claiming email verification', () => {
  assert.equal(authErrorMessage(new Error('Invalid email or password')), '邮箱或密码不正确')
  assert.equal(
    authErrorMessage(new Error('Legacy login is limited to approved account migration')),
    '当前旧账号暂未开放迁移，请稍后再试',
  )
  assert.equal(
    authErrorMessage(new Error('Local registration is disabled')),
    '新账号请在一探账号门户注册',
  )
})

test('account avatars have stable initials without relying on demo identity', () => {
  assert.equal(userInitials({ displayName: '庄 Sir', email: 'bill@example.com' }), '庄S')
  assert.equal(userInitials({ displayName: '', email: 'bill@example.com' }), 'B')
})

test('login and account settings no longer expose device registration or an Agent launcher', () => {
  const authDialog = readFileSync('src/components/AuthDialog.tsx', 'utf8')
  const accountSettings = readFileSync('src/components/AccountSettings.tsx', 'utf8')
  const app = readFileSync('src/App.tsx', 'utf8')
  const settings = readFileSync('src/pages/SettingsPage.tsx', 'utf8')
  const tauriClient = readFileSync('src/lib/tauri.ts', 'utf8')
  const packageJson = readFileSync('package.json', 'utf8')
  const portalView = authDialog.slice(
    authDialog.indexOf("view === 'portal'"),
    authDialog.indexOf('<form className="auth-dialog-form auth-dialog-legacy"'),
  )

  assert.doesNotMatch(authDialog, /registerCredentialDevice|本机授权/)
  assert.doesNotMatch(authDialog, /内测邀请码|受邀账号|inviteCode/)
  assert.match(authDialog, /忘记密码？/)
  assert.match(authDialog, /src-tauri\/icons\/128x128\.png/)
  assert.match(authDialog, /startYitanPortalAuth\('login'\)/)
  assert.match(authDialog, /openYitanAccountPortal\(\)/)
  assert.doesNotMatch(portalView, /apiLogin|apiRegister|type="password"/)
  assert.match(authDialog, /已有旧 SkillHub 账号？迁移账号/)
  assert.match(authDialog, /const legacySession = await apiLogin/)
  assert.doesNotMatch(authDialog, /apiRegister/)
  assert.doesNotMatch(authDialog, /当前版本暂不支持邮件找回/)
  // Instance invitation management is separate from the removed legacy official registration.
  assert.doesNotMatch(readFileSync('src/lib/api.ts', 'utf8'), /\bwoe\b/)
  assert.match(authDialog, /closeOnBackdrop/)
  assert.doesNotMatch(accountSettings, /CredentialDevice|本机凭据授权|授权此 Mac/)
  assert.doesNotMatch(app, /AgentTerminalHost|openAgentSessionGate/)
  assert.doesNotMatch(tauriClient, /launchAgentWithLocalEnv|CredentialDevice|AgentSession/)
  assert.doesNotMatch(packageJson, /@xterm/)
  assert.doesNotMatch(settings, /settings-label">环境变量|启动 Agent/)
})

test('every successful login closes the lightweight dialog before resuming an optional intent', () => {
  const app = readFileSync('src/App.tsx', 'utf8')
  assert.match(app, /authStatus !== 'authenticated' \|\| !currentUser \|\| !authPrompt/)
  const dismiss = app.indexOf('dismissAuthPrompt()', app.indexOf("authStatus !== 'authenticated'"))
  const optionalIntent = app.indexOf('if (!intent) return', dismiss)
  assert.ok(dismiss >= 0)
  assert.ok(optionalIntent > dismiss)
})
