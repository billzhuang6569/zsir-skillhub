import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const tauriClient = readFileSync(resolve(desktopRoot, 'src/lib/tauri.ts'), 'utf8')
const runtime = readFileSync(resolve(desktopRoot, 'src-tauri/src/runtime_env.rs'), 'utf8')
const commands = readFileSync(resolve(desktopRoot, 'src-tauri/src/commands.rs'), 'utf8')
const rustApp = readFileSync(resolve(desktopRoot, 'src-tauri/src/lib.rs'), 'utf8')

test('personal environment commands accept the account-free guest runtime', () => {
  assert.match(tauriClient, /setSkillEnv\([\s\S]*?accountUserId: string \| null = null/)
  assert.match(tauriClient, /deleteSkillEnv\([\s\S]*?accountUserId: string \| null = null/)
  assert.match(tauriClient, /getSkillEnvSourcePolicy\([\s\S]*?accountUserId: string \| null = null/)
  assert.match(tauriClient, /setSkillEnvSource\([\s\S]*?accountUserId: string \| null = null/)
  assert.match(commands, /set_skill_env\([\s\S]*?account_user_id: Option<String>/)
  assert.match(commands, /delete_skill_env\([\s\S]*?account_user_id: Option<String>/)
})

test('guest identity is persistent while team environment sources still require login', () => {
  assert.match(runtime, /runtime_dir_at\(root\)\.join\("guest\.json"\)/)
  assert.match(runtime, /activate_guest_session_at\(root\)/)
  assert.match(runtime, /团队环境变量需要先在 SkillHub APP 登录/)
  assert.match(runtime, /auth_token: Option<String>/)
  assert.match(runtime, /copy_guest_runtime_state_at\(root, &guest_user_id, user_id\)/)
})

test('guest runtime changes preserve the registered avatar upload command', () => {
  assert.match(rustApp, /mod avatar_upload;/)
  assert.match(rustApp, /avatar_upload::pick_and_upload_avatar/)
  assert.match(tauriClient, /pickAndUploadAvatar/)
})
