import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { accountDeleteResult, deleteScopeFor, groupLibraryEntries, type LibraryEntrySummary } from '../src/lib/library-sync.ts'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = (path: string): string => readFileSync(resolve(desktopRoot, path), 'utf8')
const entry = (overrides: Partial<LibraryEntrySummary>): LibraryEntrySummary => ({
  entryId: 'e', name: 'n', displayName: 'N', revision: 1, deleted: false, localSkillId: null, ...overrides,
})

test('account entries split into "not on this computer yet" and the account recycle bin', () => {
  const groups = groupLibraryEntries([
    entry({ entryId: 'here', localSkillId: 'here' }),
    entry({ entryId: 'not-yet' }),
    entry({ entryId: 'recycled', deleted: true }),
  ])
  assert.deepEqual(groups.notDownloaded.map((item) => item.entryId), ['not-yet'])
  assert.deepEqual(groups.recycled.map((item) => item.entryId), ['recycled'])
})

test('a Skill in the signed-in account is only deleted from the account; never "this computer only"', () => {
  const bound = { libraryAccountId: 'owner', libraryEntryId: 'entry' }
  const base = { signedInUserId: 'owner', syncEnabled: true, online: true, skill: bound }
  assert.deepEqual(deleteScopeFor(base), { kind: 'account', available: true })
  // Offline or sync off: still account scope, just not available yet; no device fallback.
  const offline = deleteScopeFor({ ...base, online: false })
  assert.ok(offline.kind === 'account' && !offline.available && offline.reason.includes('联网'))
  const off = deleteScopeFor({ ...base, syncEnabled: false })
  assert.ok(off.kind === 'account' && !off.available)
  // Not in any account: this computer's recycle bin.
  const local = deleteScopeFor({ ...base, skill: {} })
  assert.ok(local.kind === 'device' && local.note.includes('不在账号中'))
  // Another account's (or signed out): honest about the re-download.
  for (const input of [{ ...base, skill: { libraryAccountId: 'other', libraryEntryId: 'entry' } }, { ...base, signedInUserId: null }]) {
    const decision = deleteScopeFor(input)
    assert.ok(decision.kind === 'device' && decision.note.includes('重新下载'))
  }
})

test('manage menu has the three confirmed items and every delete entry opens the same scope dialog', () => {
  const sheet = source('src/components/SkillDetailSheet.tsx')
  for (const label of ['在所有 Agent 停用', '取消 SkillHub 托管', '删除…']) assert.ok(sheet.includes(`>${label}</button>`), label)
  assert.doesNotMatch(sheet, /移入本机回收站…<\/button>|取消托管…<\/button>|从所有工具移除…<\/button>|在所有工具中停用|交给工具自行管理/)
  // Renamed items keep their dialogs: all-Agent disable still confirms; unmanage still shows its plan.
  assert.match(sheet, /title=\{`在所有 Agent 停用「\$\{skill\.displayName\}」？`\}[^\n]*confirmLabel="在所有 Agent 停用"/)
  assert.match(sheet, /setUnmanageOpen\(true\) \}\}>取消 SkillHub 托管<\/button>/)
  const unmanage = source('src/components/UnmanageSkillDialog.tsx')
  assert.match(unmanage, /label="取消 SkillHub 托管"/)
  assert.doesNotMatch(unmanage, /交给工具自行管理|工具自行管理/)
  // Menu, Profile tab and the card's trash button (focus "delete").
  assert.equal(sheet.match(/setConfirmation\('delete'\)/g)?.length, 3)
  assert.match(sheet, /confirmation === 'delete' && <DeleteSkillDialog/)
  assert.doesNotMatch(sheet, /confirmation === 'delete' && <ConfirmModal/)
  // A resolved outcome is reported per side; "kept" keeps the dialog open with the reason.
  assert.match(sheet, /const outcome = await libraryDeleteFromAccount\(managedSkillId\)\s*\n\s*const result = accountDeleteResult\(skill\.displayName, outcome\)/)
  assert.match(sheet, /if \(result\.kind === 'kept'\) \{[\s\S]{0,120}setDeleteError\(result\.message\)\s*\n\s*return\s*\n\s*\}\s*\n\s*setConfirmation\(null\)/)
  // Only a fully finished delete removes the card; a pending local copy stays visible.
  assert.match(sheet, /if \(result\.kind === 'done'\) \{\s*\n\s*setSkills\(/)
  // A rejection happens before the account is contacted: it states only that, never "unchanged".
  assert.match(sheet, /setDeleteError\(`这次没有发出删除请求：\$\{messageOf\(error\)\}`\)/)
  assert.doesNotMatch(sheet, /都未改变/)
})

test('the delete dialog offers exactly one scope and disables an unavailable account delete', () => {
  const dialog = source('src/components/DeleteSkillDialog.tsx')
  assert.match(dialog, /const decision = deleteScopeFor\(\{ signedInUserId: currentUserId, syncEnabled, online, skill \}\)/)
  assert.match(dialog, /onClick=\{\(\) => onConfirm\(decision\.kind\)\} disabled=\{busy \|\| unavailable !== null\}/)
  assert.doesNotMatch(dialog, /仅从这台电脑删除|type="radio"/)
  assert.match(dialog, /window\.addEventListener\('offline', update\)/)
})

test('"取消 SkillHub 托管" keeps a synced Skill managed and only removes Skills outside the account', () => {
  const dialog = source('src/components/UnmanageSkillDialog.tsx')
  assert.match(dialog, /const synced = syncedToAccount\(skill, currentUserId\)/)
  assert.match(dialog, /onDone\(synced\)/)
  assert.doesNotMatch(dialog, /不会自动下载|不再自动下载/)
  const sheet = source('src/components/SkillDetailSheet.tsx')
  assert.match(sheet, /onDone=\{\(keptInSkillHub\) => \{\s*\n\s*setUnmanageOpen\(false\)\s*\n\s*if \(keptInSkillHub\) \{[\s\S]{0,120}return\s*\n\s*\}\s*\n\s*setSkills\(/)
  assert.doesNotMatch(sheet, /不再自动下载/)
})

test('cloud list has no secondary account panel and settings retains account-library restoration', () => {
  const app = source('src/App.tsx')
  assert.doesNotMatch(app, /LibraryMigrationDialog|libraryMigrationConfirm|migrationPending|首次同步待确认/)
  const page = source('src/pages/SkillsPage.tsx')
  assert.doesNotMatch(page, /AccountLibraryPanel|账号中、尚未下载|只在这台电脑、未加入账号/)
  const settings = source('src/pages/SettingsPage.tsx')
  assert.match(settings, /await libraryRestoreEntry\(entry\.entryId\)/)
  assert.match(settings, /libraryTrashList\.userId === currentUser\?\.id/)
})

test('after the Server deleted the entry, a failed local cleanup is reported as account done + this computer pending', () => {
  assert.deepEqual(
    accountDeleteResult('周报助手', { account: 'deleted', accountMessage: null, localCleaned: true, localError: null }).kind,
    'done',
  )
  const pending = accountDeleteResult('周报助手', { account: 'deleted', accountMessage: null, localCleaned: false, localError: '没能移入本机回收站：Resource busy' })
  assert.equal(pending.kind, 'local-pending')
  assert.match(pending.message, /已从账号删除/)
  assert.match(pending.message, /这台电脑上的副本还没移入回收站（没能移入本机回收站：Resource busy）/)
  assert.match(pending.message, /下次同步会自动处理，也可以再次点「删除」重试/)
  assert.doesNotMatch(pending.message, /没有从账号删除/)
})

test('a delete whose result cannot be confirmed is never reported as deleted or as unchanged', () => {
  const unknown = accountDeleteResult('周报助手', {
    account: 'unconfirmed',
    accountMessage: '读取 SkillHub Server 响应失败；再次确认时：无法连接 SkillHub Server',
    localCleaned: false,
    localError: null,
  })
  assert.equal(unknown.kind, 'unconfirmed')
  assert.match(unknown.message, /账号删除结果暂无法确认（读取 SkillHub Server 响应失败；再次确认时：无法连接 SkillHub Server）/)
  assert.match(unknown.message, /副本和同步记录都已保留/)
  assert.doesNotMatch(unknown.message, /已从账号删除|没有从账号删除|都未改变/)
})

test('only a read-back that still shows the entry is reported as kept in the account', () => {
  const kept = accountDeleteResult('周报助手', {
    account: 'kept',
    accountMessage: '这个 Skill 刚在其他设备上被修改，请稍后重试',
    localCleaned: false,
    localError: null,
  })
  assert.equal(kept.kind, 'kept')
  assert.equal(kept.message, '没有从账号删除，账号中仍保留「周报助手」：这个 Skill 刚在其他设备上被修改，请稍后重试')
  assert.doesNotMatch(kept.message, /已从账号删除|暂无法确认|都未改变/)
})
