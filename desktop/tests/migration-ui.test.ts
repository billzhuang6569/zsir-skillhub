import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { acceptsMigrationProgress, copyName, defaultMigrationChoices, migrationCategory, migrationChoiceError,
  migrationCommitChoice, migrationCounts, migrationGroup, migrationKeyError, migrationKeys, migrationReason,
  unfinishedMigration, migrationSnapshotError, migrationAvatarSkipped, migrationResultReason } from '../src/lib/migration-ui.ts'
import type { MigrationItem, MigrationProgress } from '../src/lib/migration-ui.ts'
import type { MigrationKeyChoice, MigrationStatus } from '../src/lib/tauri.ts'

function item(overrides: Partial<MigrationItem> = {}): MigrationItem {
  return { id: 'a', sourceSkillId: 'source', name: 'sample', category: 'own_skill', state: 'pending', reason: '',
    pendingDelta: false, warnings: [], avatars: [], avatarCount: 2, storeState: null,
    targetSkillId: null, targetEntryId: null, precheck: null, ...overrides }
}
function status(items: MigrationItem[]): MigrationStatus {
  return { localMigrationId: 'm', state: 'ready', snapshotAt: 1, limits: { skills: 100 }, items, keys: [], keysDone: false, keyResults: [] }
}
const conflict = item({ id: 'conflict', precheck: { operationKey: 'operation', status: 'conflict', reason: 'name_exists', existingSkillId: 'existing' } })

test('snapshot failures show a safe error code and Chinese reason in both entry flows', () => {
  for (const code of ['HTTP_401', 'HTTP_403']) {
    assert.equal(migrationSnapshotError(code), `未能读取迁移内容（原账号登录已失效 · ${code}），请重试或取消。`)
  }
  assert.match(migrationSnapshotError(new Error('MIGRATION_NETWORK')), /无法连接原服务器.*MIGRATION_NETWORK/)
  assert.match(migrationSnapshotError('无法连接服务器，请检查地址与网络'), /无法连接原服务器.*MIGRATION_NETWORK/)
  assert.match(migrationSnapshotError('MIGRATION_INVALID_CONTEXT'), /切换状态已变化/)
  assert.match(migrationSnapshotError('MIGRATION_SESSION_CHANGED'), /切换状态已变化/)
  assert.match(migrationSnapshotError('SkillHub 空间或账号已切换，本次请求结果已丢弃'), /MIGRATION_SESSION_CHANGED/)
  assert.match(migrationSnapshotError('FUTURE_ERROR'), /（FUTURE_ERROR）/)
  assert.match(migrationReason('FUTURE_ERROR'), /迁移未完成/)
  assert.match(migrationSnapshotError(new Error('SkillHub 服务地址无效')), /SkillHub 服务地址无效/)
  assert.equal(migrationReason('SOURCE_PACKAGE_UNAVAILABLE'), '原服务器上没有可安装的包')
  assert.equal(migrationReason('MIGRATION_LOCAL_PACKAGE_FAILED'), '本机文件夹无法打包')
  assert.equal(migrationReason('AVATAR_SKIPPED'), '头像不可用，已跳过')
  for (const code of ['MIGRATION_INVALID_PROFILE', 'MIGRATION_INVALID_PACKAGE', 'MIGRATION_SOURCE_CHANGED', 'CATALOG_UNAVAILABLE']) {
    assert.match(migrationReason(code), /[\u4e00-\u9fff]/)
  }
  assert.match(migrationReason('HTTP_500'), /请求失败（HTTP_500）/)
})
test('avatar skipped count includes each snapshot warning and target result', () => {
  assert.equal(migrationAvatarSkipped(item({
    warnings: ['AVATAR_SKIPPED', 'PENDING_DELTA', 'AVATAR_SKIPPED'],
    avatars: [{ id: 'v1', status: 'skipped', code: 'AVATAR_STYLE_UNAVAILABLE' }],
  })), 3)
})
test('report uses result reasons and counts existing store entries as mapped', () => {
  for (const state of ['imported', 'mapped']) {
    assert.equal(migrationResultReason(item({ state, precheck: { operationKey: 'a', status: 'ok', reason: 'READY', existingSkillId: null } })), '')
  }
  assert.equal(migrationResultReason(item({ state: 'skipped', reason: 'USER_SKIPPED' })), '已选择跳过')
  assert.equal(migrationResultReason(item({ state: 'failed', reason: 'MIGRATION_NETWORK' })), '无法连接原服务器')
  const counts = migrationCounts(status([item({ category: 'reacquire', state: 'mapped' })]))
  assert.equal(counts.mapped, 1)
  assert.equal(counts.imported, 0)
  for (const code of ['MIGRATION_ORGANIZER_RETRY', 'MIGRATION_LIBRARY_SYNC_REQUIRED', 'MIGRATION_RETRY_REQUIRED', 'MIGRATION_INTERRUPTED']) assert.match(migrationReason(code), /[\u4e00-\u9fff]/)
})

test('precheck counts ready, skipped, conflicting, over quota and pending delta independently', () => {
  const result = migrationCounts(status([
    item({ pendingDelta: true }), conflict,
    item({ id: 'team', category: 'team', state: 'skipped', reason: 'TEAM_SHARED_NOT_COPYABLE' }),
    item({ id: 'quota', precheck: { operationKey: 'q', status: 'over_quota', reason: 'SKILL_LIMIT', existingSkillId: null } }),
  ]))
  assert.deepEqual(result, { ready: 1, skipped: 1, conflicts: 1, overQuota: 1, pendingDelta: 1, imported: 0, mapped: 0, failed: 0, done: 1 })
})
test('conflicts default to skip, normal items copy, finalized items cannot change', () => {
  assert.deepEqual(defaultMigrationChoices(status([item(), conflict, item({ id: 'done', state: 'mapped' })])),
    [{ id: 'a', action: 'copy' }, { id: 'conflict', action: 'skip' }])
})
test('copy names obey the native name boundary; mapping requires exactly the precheck target', () => {
  assert.equal(copyName('sample'), 'sample-2')
  assert.equal(copyName('a'.repeat(128)).length, 128)
  for (const name of ['x', 'Skill-2.0_test', copyName('a'.repeat(128))]) assert.equal(migrationChoiceError({ id: 'a', action: 'copy', targetName: name }, conflict), null)
  for (const name of ['', '../a', '.a', '名字', 'a/b', 'a'.repeat(129)]) assert.ok(migrationChoiceError({ id: 'a', action: 'copy', targetName: name }, conflict))
  assert.equal(migrationChoiceError({ id: 'a', action: 'map', mapToSkillId: 'existing' }, conflict), null)
  assert.ok(migrationChoiceError({ id: 'a', action: 'map', mapToSkillId: 'other' }, conflict))
  assert.ok(migrationChoiceError({ id: 'a', action: 'map', mapToSkillId: 'existing' }, item()))
})
test('key copying is opt-in and preserves each explicit conflict strategy', () => {
  const choices: MigrationKeyChoice[] = [
    { name: 'A_KEY', conflict: { action: 'skip' } },
    { name: 'B_KEY', conflict: { action: 'overwrite' } },
    { name: 'C_KEY', conflict: { action: 'rename', name: 'C_KEY_2' } },
  ]
  assert.deepEqual(migrationKeys(false, choices), [])
  assert.deepEqual(migrationKeys(true, []), [])
  assert.deepEqual(migrationKeys(true, choices), choices)
  assert.equal(migrationKeyError(choices), null)
  assert.ok(migrationKeyError([{ name: 'A', conflict: { action: 'rename', name: 'bad name' } }]))
  assert.ok(migrationKeyError([...choices, { name: 'D', conflict: { action: 'rename', name: 'A_KEY' } }]))
})
test('reason and categories are Chinese without echoing unknown native errors', () => {
  assert.equal(migrationReason('TEAM_SHARED_NOT_COPYABLE'), '团队共享不支持复制')
  assert.equal(migrationReason('name_exists'), '目标账号已有同名 Skill')
  assert.match(migrationReason('SKILL_LIMIT,STORAGE_LIMIT'), /数量上限.*存储上限/)
  assert.doesNotMatch(migrationReason('secret-value'), /secret-value/)
  assert.equal(migrationCategory(item({ category: 'reacquire' })), '商店 · 重新取得')
  assert.equal(migrationCategory(item({ category: 'store_copy', storeState: 'delisted' })), '商店 · 个人副本（已下架）')
  assert.equal(migrationGroup(item({ category: 'team' })), '团队共享')
})
test('source-only login cancels the candidate transaction after confirmation', () => {
  assert.equal(migrationCommitChoice(true), '取消')
  assert.equal(migrationCommitChoice(false), '迁移并切换')
})
test('unfinished startup tasks are resumable but finished, abandoned and incomplete snapshots are not', () => {
  for (const state of ['ready', 'paused', 'running', 'awaitingChoice', 'imported']) assert.equal(unfinishedMigration({ ...status([]), state }), true)
  for (const state of ['completed', 'cancelled', 'snapshotFailed', 'snapshotting']) assert.equal(unfinishedMigration({ ...status([]), state }), false)
})
test('progress binds exact current target generation and user, and is ignored during switching', () => {
  const space = { spaceId: 'selfhost:target', generation: 4 }
  const event: MigrationProgress = { localMigrationId: 'm', state: 'running', space, userId: 'user' }
  assert.equal(acceptsMigrationProgress(event, space, 'user', false), true)
  assert.equal(acceptsMigrationProgress(event, { ...space, generation: 5 }, 'user', false), false)
  assert.equal(acceptsMigrationProgress(event, { ...space, spaceId: 'official' }, 'user', false), false)
  assert.equal(acceptsMigrationProgress(event, space, 'other', false), false)
  assert.equal(acceptsMigrationProgress(event, space, 'user', true), false)
  assert.equal(acceptsMigrationProgress({ localMigrationId: 'm', state: 'paused' }, space, 'user', false), false)
})
test('migration modal sits above the connection modal and uses design tokens', () => {
  const css = readFileSync(new URL('../src/components/MigrationDialog.css', import.meta.url), 'utf8')
  const auth = readFileSync(new URL('../src/components/AuthDialog.css', import.meta.url), 'utf8')
  assert.ok(Number(css.match(/\.migration-dialog-layer \{ z-index:\s*(\d+)/)?.[1]) > Number(auth.match(/z-index:\s*(\d+)/)?.[1]))
  assert.doesNotMatch(css, /font-size:\s*\d+px/)
})
