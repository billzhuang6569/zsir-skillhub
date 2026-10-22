import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const settings = readFileSync(resolve(desktopRoot, 'src/pages/SettingsPage.tsx'), 'utf8')
const styles = readFileSync(resolve(desktopRoot, 'src/pages/SettingsPage.css'), 'utf8')

test('Settings connects the native recycle-bin list, file manager, and restore commands', () => {
  assert.match(settings, /listTrashItems/)
  assert.match(settings, /openTrashItem\(item\.id\)/)
  assert.match(settings, /restoreTrashItem\(item\.id\)/)
  assert.match(settings, /item\.reason === 'marketplace_version_replacement'/)
  assert.match(settings, /await rollbackMarketplaceReplacement\(item\.id\)/)
  assert.match(settings, /await restoreTrashItem\(item\.id\)[^]*await refreshTrash\(\)/)
  assert.match(settings, /apiGetSkillTrash\(\)/)
  assert.match(settings, /await apiRestoreSkill\(item\.serverId\)/)
  assert.match(settings, /apiRestoreSkill\(skill\.id\)/)
  assert.match(settings, /已恢复到\$\{target\}/)
  assert.match(settings, /原位置已有新的同名内容/)
  assert.match(settings, /const generation = \+\+trashGenerationRef\.current/)
  assert.match(settings, /useStore\.getState\(\)\.currentUser\?\.id \?\? null/)
  assert.match(settings, /setAccountTrashItems\(\[\]\)/)
  assert.match(settings, /if \(accountRestoreError\) setTrashError\(accountRestoreError\)/)
  assert.match(settings, /item\.kind === 'managed_asset'[^]*&& item\.restorable[^]*&& item\.serverOwnerId === currentUser\?\.id/)
})

test('Settings distinguishes loading, error, empty, and populated recycle-bin states', () => {
  const loading = settings.indexOf('trashLoading ?')
  const error = settings.indexOf('trashError &&')
  const empty = settings.indexOf('trashItems.length === 0 && accountOnlyTrash.length === 0 && libraryTrash.length === 0 ?', loading)
  const list = settings.indexOf('className="trash-list"', empty)

  assert.ok(loading >= 0)
  assert.ok(error >= 0)
  assert.ok(empty > loading)
  assert.ok(list > empty)
  assert.match(settings, /role="status"/)
  assert.match(settings, /role="alert"/)
  assert.match(settings, /回收站为空/)
  assert.match(settings, /同名 Skill 备份/)
  assert.match(settings, /本机 Skill 备份/)
  assert.match(settings, /Skill 商店版本备份/)
  assert.match(settings, /当前版本已保留在回收站/)
  assert.match(settings, /Skill 商店切换中断/)
  assert.match(settings, /上次版本切换中断，两套内容均已保留；可恢复此版本，无法确认时不会覆盖/)
  assert.match(settings, /切换中断，内容待确认/)
})

test('recycle-bin rows expose identity, source, time, and accessible actions', () => {
  assert.match(settings, /item\.displayName \|\| item\.skillId/)
  assert.match(settings, /trashSourceLabel\(item\)/)
  assert.match(settings, /<time dateTime=\{createdAt\?\.toISOString\(\)\}>/)
  assert.match(settings, /aria-label="刷新回收站"/)
  assert.match(settings, /title=\{item\.location\}/)
  assert.match(settings, />打开文件夹<\/button>/)
  assert.match(settings, /'正在切换'/)
  assert.match(settings, /'切换版本'/)
  assert.match(settings, /'恢复此版本'/)
  assert.match(settings, /'正在恢复'/)
  assert.match(settings, /disabled=\{restoringTrashId !== null\}/)
  assert.match(settings, /账号资产/)
  assert.match(settings, /来自当前账号/)
})

test('recycle-bin styling stays compact, responsive, and keyboard-sized', () => {
  assert.match(styles, /\.trash-item\s*\{[^}]*min-height:\s*64px;[^}]*grid-template-columns:\s*36px minmax\(0, 1fr\) auto;/s)
  assert.match(styles, /\.trash-action\s*\{[^}]*height:\s*40px;/s)
  assert.match(styles, /\.trash-head-actions \.ico-btn\s*\{\s*width:\s*40px;\s*height:\s*40px;/)
  assert.match(styles, /transition-property:\s*background-color/)
  assert.doesNotMatch(styles, /transition:\s*all/)
  assert.match(styles, /@media \(max-width: 760px\)[^]*\.trash-actions\s*\{\s*grid-column:\s*2;/)
})
