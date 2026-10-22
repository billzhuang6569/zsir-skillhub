import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { disableAgentLabel, disabledToastMessage, sharedProjectionAgents, sharedProjectionNote } from '../src/lib/skill-lifecycle-ui.ts'
import { userMessage } from '../src/lib/user-message.ts'
import { moveLocalSkillToRecycle } from '../src/lib/team-share-flow.ts'
import type { AgentInfo } from '../src/lib/tauri.ts'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = (path: string): string => readFileSync(resolve(desktopRoot, path), 'utf8')

const agents = [
  { key: 'codex', name: 'ChatGPT', dir: '/shared' },
  { key: 'doubao', name: '豆包工作', dir: '/shared' },
  { key: 'claude', name: 'Claude Code', dir: '/claude' },
] as AgentInfo[]

test('shared Agent directory is disclosed on the button, the toast and inline before any click', () => {
  assert.deepEqual(sharedProjectionAgents('codex', agents), ['ChatGPT', '豆包工作'])
  assert.deepEqual(sharedProjectionAgents('claude', agents), [])
  assert.deepEqual(sharedProjectionAgents('unknown', agents), [])
  assert.match(disableAgentLabel('ChatGPT', ['ChatGPT', '豆包工作']), /ChatGPT 已安装，点击停用（ChatGPT、豆包工作 共用同一文件夹，会一起停用）/)
  assert.equal(disableAgentLabel('Claude Code', []), 'Claude Code 已安装，点击停用')
  assert.match(disabledToastMessage('ChatGPT', ['ChatGPT', '豆包工作']), /已在 ChatGPT、豆包工作 停用（共用同一文件夹），SkillHub 中仍保留/)
  assert.equal(disabledToastMessage('Claude Code', []), '已在 Claude Code 停用，SkillHub 中仍保留')
  assert.equal(sharedProjectionNote(['claude'], agents), null)
  assert.match(sharedProjectionNote(['codex', 'doubao', 'claude'], agents) ?? '', /^ChatGPT、豆包工作 共用同一文件夹，停用其中一个会一起停用。$/)
})

test('single-Agent disable runs directly, stays busy through the read-back and offers undo', () => {
  const sheet = source('src/components/SkillDetailSheet.tsx')
  const card = source('src/components/SkillCard.tsx')
  // No confirm modal for one Agent any more, in the sheet or on the card.
  for (const component of [sheet, card]) {
    assert.doesNotMatch(component, /removeAgent|setRemoveAgent|removalDescription|从 \$\{[^}]+\} 移除？/)
  }
  // Sheet: installed → disable directly; broken → repair; busy covers the state read-back; undo re-enables.
  assert.match(sheet, /onClick=\{\(\) => state === 'broken' \? onRepairAgent\(agent\) : void toggleAgent\(agent, state === 'installed'\)\}/)
  assert.match(sheet, /await \(enabled \? disableSkill\(managedSkillId, agent\) : enableSkill\(managedSkillId, agent\)\)\s*\n\s*await onRefresh\(\)/)
  assert.match(sheet, /onRefresh: \(\) => Promise<void>/)
  assert.match(sheet, /onRefresh=\{\(\) => refreshLocal\(\)\}/)
  assert.match(sheet, /enabled \? async \(\) => \{ await enableSkill\(managedSkillId, agent\); await onRefresh\(\) \} : undefined/)
  assert.match(sheet, /if \(busyAgent \|\| skill\.isSystem\) return/)
  assert.match(sheet, /disabled=\{!skill\.localPath \|\| busyAgent !== null \|\| skill\.isSystem\}/)
  assert.match(sheet, /\{sharedNote && <p className="profile-agent-note" role="note">\{sharedNote\}<\/p>\}/)
  // Card: direct disable, state read back from the real list before busy clears, undo present.
  assert.match(card, /onClick=\{\(event\) => \{ event\.stopPropagation\(\); void toggleAgent\(agent\) \}\}/)
  // The state is read back before busy clears: by the single-Skill command once #147 lands, by the list until then.
  assert.match(card, /await disableSkill\(managedSkillId, agent\.key\)\s*\n(?:\s*\/\/[^\n]*\n)*\s*const refreshed = (?:await getLocalSkill\(managedSkillId\)|findLocalSkillByManagedId\(await getLocalSkills\(\), managedSkillId\))/)
  assert.match(card, /toast\(disabledToastMessage\(agent\.name, sharedProjectionAgents\(agent\.key, installedAgents\)\), 'default', async \(\) => \{ await enableSkill\(managedSkillId, agent\.key\)/)
  // The whole-Skill actions keep their confirmations.
  assert.match(sheet, /confirmation === 'uninstall' && <ConfirmModal/)
  assert.match(sheet, /confirmation === 'delete' && <DeleteSkillDialog/)
  assert.match(sheet, /unmanageOpen && <UnmanageSkillDialog|<UnmanageSkillDialog/)
})

test('local recycle rejects remote-only records and never mutates cloud', async () => {
  let cloud = 0
  let local = 0
  await assert.rejects(moveLocalSkillToRecycle({ skill: {}, deleteLocal: async () => { local++ }, deleteRemote: async () => { cloud++ } }), /不在本机/)
  await assert.rejects(moveLocalSkillToRecycle({ skill: { localPath: '/fixture' }, deleteLocal: async () => { throw new Error('disk failure') }, deleteRemote: async () => { cloud++ } }), /disk failure/)
  assert.equal(cloud, 0)
  assert.equal(local, 0)
})
test('messages keep actionable errors and distinguish access from network failures', () => {
  assert.match(userMessage(new Error('Forbidden')), /账号.*权限/)
  assert.match(userMessage('Load failed'), /网络/)
  assert.equal(userMessage('文件已变化，请重新确认'), '文件已变化，请重新确认')
})
