import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  KEY_COPY,
  KEY_GUIDE_STORAGE_KEY,
  aliasSuggestionSegments,
  aliasSuggestionText,
  KEYS_EXPLAINER_STORAGE_KEY,
  canSwitchSource,
  dismissKeysExplainer,
  keyChoices,
  keyGuideSummary,
  keyRowElements,
  keyRowState,
  keyRowStatus,
  keySectionElements,
  keyViewerRole,
  needsValueLabel,
  offerKeyInstallGuide,
  readKeysExplainerDismissed,
  readShownKeyGuides,
  rememberKeyGuideShown,
  safeObtainUrl,
  shouldOpenKeyGuide,
  sourceOptionLabel,
  usingLabel,
  type KeyViewerRole,
} from '../src/lib/skill-keys.ts'
import { summarizeRequiredEnvRows } from '../src/lib/skill-library.ts'
import type { SkillEnvSourceOption, SkillEnvSourcePolicyRow } from '../src/lib/tauri.ts'
import { LEGACY_TOKEN_NAMES } from './legacy-token-names.ts'

const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

const personal = (available: boolean): SkillEnvSourceOption => ({ kind: 'personal', available })
const team = (teamId: string, teamName: string, available = true): SkillEnvSourceOption => ({ kind: 'team', teamId, teamName, available })

function row(overrides: Partial<SkillEnvSourcePolicyRow> = {}): SkillEnvSourcePolicyRow {
  return { key: 'FAL_KEY', required: true, selected: null, effective: null, valid: false, state: 'needs_value', options: [personal(false)], ...overrides }
}

class MemoryStorage {
  values = new Map<string, string>()
  getItem(key: string): string | null { return this.values.get(key) ?? null }
  setItem(key: string, value: string): void { this.values.set(key, value) }
}

// ── Copy ──

test('copy table: 你的钥匙 / X 团队的钥匙 / 需要选择用哪把钥匙 / 需要填写 N 把钥匙 / 正在使用', () => {
  assert.equal(sourceOptionLabel(personal(true)), '你的钥匙')
  assert.equal(sourceOptionLabel(personal(true), 'override'), '你的钥匙（仅此 Skill）')
  assert.equal(sourceOptionLabel(team('t1', '设计组')), '设计组 团队的钥匙')
  assert.equal(KEY_COPY.needsChoice, '需要选择用哪把钥匙')
  assert.equal(needsValueLabel(3), '需要填写 3 把钥匙')
  assert.equal(KEY_COPY.using, '正在使用')
  assert.equal(KEY_COPY.fillHint, '保存到你的钥匙库，所有需要它的 Skill 都能用')
  assert.equal(KEY_COPY.shareKeysToTeam, '共享钥匙给团队')
  assert.equal('shareHint' in KEY_COPY, false)
  const ui = read('src/components/SkillKeys.tsx') + read('src/components/SkillDetailSheet.tsx') + read('src/lib/skill-keys.ts') + read('src/lib/skill-library.ts')
  for (const old of ['用户自建', '尚未选择可用来源', '项配置', '提供给团队', '填写个人值']) assert.doesNotMatch(ui.replace(/\/\/.*$/gm, ''), new RegExp(old), old)
  assert.doesNotMatch(read('src/components/SkillDetailSheet.tsx'), /由 \$\{[^}]*\} 共享/)
  const manager = read('src-tauri/system-skills/yitan-skillhub-manager/references/credentials-runtime.md')
  for (const phrase of ['你的钥匙', 'XX 团队的钥匙', '需要选择用哪把钥匙', '需要填写 N 把钥匙', '正在使用']) assert.ok(manager.includes(phrase), phrase)
  assert.match(read('src-tauri/src/runtime_env.rs'), /需要填写：请在 SkillHub APP 的 Skill 详情「需要的钥匙」中填写/)
})

// ── Three states ──

test('state transitions: fill → ready; revoke → needs_value; second team → needs_choice; choose → ready', () => {
  // Nothing anywhere: 需要填写.
  const empty = row()
  assert.equal(keyRowStatus(empty, false, false), 'needs_value')
  // Filled into the vault: ready, using 你的钥匙.
  const filled = row({ valid: true, state: 'ready', effective: { kind: 'personal' }, source: 'vault', personalSource: 'vault', options: [personal(true)] })
  assert.equal(keyRowStatus(filled, false, false), 'ready')
  assert.equal(usingLabel(filled), '使用：你的钥匙')
  // Revoked from the 钥匙 page: back to 需要填写.
  assert.equal(keyRowStatus({ ...filled, valid: false, state: 'needs_value', effective: null, source: null, personalSource: null, options: [personal(false)] }, false, false), 'needs_value')
  // One team offers the key: used automatically.
  const oneTeam = row({ valid: true, state: 'ready', effective: { kind: 'team', teamId: 't1' }, source: 'team', options: [personal(false), team('t1', 'A')] })
  assert.equal(keyRowStatus(oneTeam, false, false), 'ready')
  assert.equal(usingLabel(oneTeam), '使用：A 团队的钥匙')
  assert.equal(canSwitchSource(oneTeam), false)
  // A second team offers the same key: 需要选择 between A and B.
  const twoTeams = row({ valid: false, state: 'needs_choice', options: [personal(false), team('t1', 'A'), team('t2', 'B')] })
  assert.equal(keyRowStatus(twoTeams, false, false), 'needs_choice')
  assert.deepEqual(keyChoices(twoTeams).map((option) => sourceOptionLabel(option)), ['A 团队的钥匙', 'B 团队的钥匙'])
  // The user chooses B: ready, and switching stays possible.
  const chosen = { ...twoTeams, valid: true, state: 'ready' as const, selected: { kind: 'team' as const, teamId: 't2' }, effective: { kind: 'team' as const, teamId: 't2' } }
  assert.equal(keyRowStatus(chosen, false, false), 'ready')
  assert.equal(usingLabel(chosen), '使用：B 团队的钥匙')
  assert.equal(canSwitchSource(chosen), true)
  // A per-Skill override is switchable even with a single candidate.
  assert.equal(canSwitchSource({ ...filled, personalSource: 'override' }), true)
  assert.equal(usingLabel({ ...filled, personalSource: 'override' }), '使用：你的钥匙（仅此 Skill）')
})

test('rows from an older native layer without `state` derive the same three states', () => {
  assert.equal(keyRowState({ valid: true, options: [personal(true)] }), 'ready')
  assert.equal(keyRowState({ valid: false, options: [team('t1', 'A'), team('t2', 'B')] }), 'needs_choice')
  assert.equal(keyRowState({ valid: false, options: [personal(false)] }), 'needs_value')
})

test('a usable vault key still awaiting first-use consent shows 等待授权 and opens the consent dialog', () => {
  const consent = row({ valid: true, state: 'ready', effective: { kind: 'personal' }, source: 'vault', needsConsent: true, options: [personal(true)] })
  assert.equal(keyRowStatus(consent, false, false), 'needs_consent')
  const elements = keyRowElements({ role: 'guest', status: 'needs_consent', row: consent, dependency: { key: 'FAL_KEY' }, installed: true })
  assert.equal(elements.primary, 'consent')
  assert.equal(elements.using, '使用：你的钥匙')
  assert.equal(elements.switchable, false)
  // The list badge stays quiet: consent rows are valid for the policy.
  assert.deepEqual(summarizeRequiredEnvRows([consent]), { needsValue: 0, needsChoice: 0 })
  assert.match(read('src/components/KeyConsentDialog.tsx'), /window\.addEventListener\(KEY_CONSENT_OPEN_EVENT, open\)/)
  assert.match(read('src/components/KeyConsentDialog.tsx'), /const request = requested \?\? queued/)
})

test('loading, read errors and retry', () => {
  assert.equal(keyRowStatus(undefined, true, false), 'loading')
  assert.equal(keyRowStatus(row(), false, true), 'error')
  for (const status of ['loading', 'error'] as const) {
    assert.equal(keyRowElements({ role: 'author', status, dependency: { key: 'FAL_KEY' }, installed: true }).primary, null)
  }
  const sheet = read('src/components/SkillDetailSheet.tsx')
  assert.match(sheet, /policy\.error && <div className="banner banner-error key-policy-error" role="alert">[^]*onClick=\{policy\.reload\}>\{RETRY_LABEL\}<\/button>/)
  const keys = read('src/components/SkillKeys.tsx')
  // A re-read keeps rows on screen; only another account or Skill clears them.
  assert.match(keys, /if \(rowsOwner\.current !== owner\) \{ rowsOwner\.current = owner; setRows\(\[\]\) \}/)
  assert.match(keys, /window\.addEventListener\(ENV_READINESS_CHANGED_EVENT, onChange\)/)
})

// ── Who sees what ──

test('row-element matrix for author / member / guest / signed-out', () => {
  assert.equal(keyViewerRole({ canManage: true, signedIn: true, teamSkill: false }), 'author')
  assert.equal(keyViewerRole({ canManage: true, signedIn: false, teamSkill: false }), 'author')
  assert.equal(keyViewerRole({ canManage: false, signedIn: true, teamSkill: true }), 'member')
  assert.equal(keyViewerRole({ canManage: false, signedIn: true, teamSkill: false }), 'guest')
  assert.equal(keyViewerRole({ canManage: false, signedIn: false, teamSkill: true }), 'signed_out')

  const dependency = { key: 'FAL_KEY', origin: 'runtime_request', pending: true, obtain: 'https://fal.ai/dashboard/keys' }
  const matrix = Object.fromEntries((['author', 'member', 'guest', 'signed_out'] satisfies KeyViewerRole[]).map((role) => {
    const value = keyRowElements({ role, status: 'needs_value', row: row(), dependency, installed: true })
    const section = keySectionElements(role)
    return [role, [value.primary, value.runtimeTag, value.confirmPending, Boolean(value.obtainUrl), section.authorTools, section.shareHint]]
  }))
  assert.deepEqual(matrix, {
    author: ['fill', true, true, true, true, true],
    member: ['fill', true, false, true, false, false],
    guest: ['fill', true, false, true, false, false],
    signed_out: ['fill', true, false, true, false, false],
  })
  // The share hint needs a current-account binding.
  assert.equal(keySectionElements('author', true).shareHint, false)
  // Not installed: nothing to act on yet.
  assert.equal(keyRowElements({ role: 'author', status: 'needs_value', row: row(), dependency, installed: false }).primary, null)
  // Exactly one primary action per state.
  const primary = (status: 'ready' | 'needs_value' | 'needs_choice' | 'needs_consent') => keyRowElements({ role: 'member', status, row: row(), dependency: { key: 'K' }, installed: true }).primary
  assert.deepEqual([primary('ready'), primary('needs_value'), primary('needs_choice'), primary('needs_consent')], [null, 'fill', 'choose', 'consent'])
})

test('obtain links open only over https', () => {
  assert.equal(safeObtainUrl('https://fal.ai/dashboard/keys'), 'https://fal.ai/dashboard/keys')
  for (const bad of ['http://fal.ai', 'javascript:alert(1)', 'file:///etc/passwd', 'fal.ai', '', null, undefined]) assert.equal(safeObtainUrl(bad), null, String(bad))
  assert.match(read('src/components/SkillKeys.tsx'), /void openUrl\(elements\.obtainUrl!\)/)
})

test('「什么是钥匙？」 explainer: exact copy, dismissed once per computer, storage failures are harmless', () => {
  assert.equal(KEY_COPY.explainerTitle, '什么是钥匙？')
  assert.equal(KEY_COPY.explainerDismiss, '不再显示')
  assert.deepEqual([KEY_COPY.explainerWhatTitle, KEY_COPY.explainerWhereTitle, KEY_COPY.explainerHowTitle], ['是什么', '存在哪', '怎么用'])
  assert.equal(KEY_COPY.explainerWhat, '有些 Skill 需要外部服务（如 fal.ai 作图），要用到 API Key，才能正常使用。')
  assert.equal(KEY_COPY.explainerWhere, '明文存在你的电脑，不上传。共享给团队时会加密传到 SkillHub 服务器。一探 SkillHub 只在团队成员运行 Skill 时解密发给他，不会拿你的钥匙做别的事。')
  assert.equal(KEY_COPY.explainerHow, '填一次，所有需要它的 Skill 都能用。Agent 运行 Skill 时自动带上。')
  assert.equal(KEY_COPY.sectionSubtitle, '值保存在这台电脑的钥匙库里，界面不显示原文，也不会写进 Skill 包。')
  assert.equal(KEY_COPY.shareToTeam, '共享给团队')
  assert.equal(KEY_COPY.declarationsTitle, '钥匙声明')
  assert.equal(KEY_COPY.declarationsSubtitle, '作者可见，决定这个 Skill 需要哪些钥匙')
  assert.equal(KEY_COPY.writeBack, '写回 SKILL.md')

  assert.equal(KEYS_EXPLAINER_STORAGE_KEY, 'yitan-skillhub.keys-explainer-dismissed.v1')
  const storage = new MemoryStorage()
  assert.equal(readKeysExplainerDismissed(storage), false)
  dismissKeysExplainer(storage)
  assert.equal(storage.getItem(KEYS_EXPLAINER_STORAGE_KEY), '1')
  assert.equal(readKeysExplainerDismissed(storage), true)
  const blocked = { getItem: (): string | null => { throw new Error('blocked') }, setItem: (): void => { throw new Error('blocked') } }
  assert.equal(readKeysExplainerDismissed(blocked), false)
  assert.doesNotThrow(() => dismissKeysExplainer(blocked))
  assert.equal(readKeysExplainerDismissed(null), false)

  const keys = read('src/components/SkillKeys.tsx')
  assert.match(keys, /export function KeysExplainer\(\)/)
  assert.match(keys, /dismissKeysExplainer\(\); setDismissed\(true\)/)
  const css = read('src/components/SkillKeys.css')
  assert.match(css, /\.key-explainer-columns \{ display: grid; grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);/)
  assert.match(css, /@media \(max-width: 640px\) \{\n  \.key-explainer-columns \{ grid-template-columns: 1fr;/)
})

// ── First-install guide ──

test('the guide opens once, only after a successful store or team install that declares keys', () => {
  const base = { succeeded: true, declaredKeys: 2, alreadyShown: false }
  assert.equal(shouldOpenKeyGuide({ ...base, source: 'marketplace' }), true)
  assert.equal(shouldOpenKeyGuide({ ...base, source: 'team' }), true)
  assert.equal(shouldOpenKeyGuide({ ...base, source: 'local' }), false, 'local imports get the pre-publish checklist')
  assert.equal(shouldOpenKeyGuide({ ...base, source: 'team', succeeded: false }), false, 'install failures never show it')
  assert.equal(shouldOpenKeyGuide({ ...base, source: 'team', declaredKeys: 0 }), false)
  assert.equal(shouldOpenKeyGuide({ ...base, source: 'team', alreadyShown: true }), false, 'closing does not re-show')

  const storage = new MemoryStorage()
  assert.equal(offerKeyInstallGuide({ id: 'store-image', acquisitionSource: 'marketplace', envDeps: [{}] }, storage), true)
  rememberKeyGuideShown('store-image', storage)
  assert.deepEqual([...readShownKeyGuides(storage)], ['store-image'])
  assert.equal(offerKeyInstallGuide({ id: 'store-image', acquisitionSource: 'marketplace', envDeps: [{}] }, storage), false)
  assert.equal(offerKeyInstallGuide({ id: 'mine', acquisitionSource: 'local', envDeps: [{}] }, storage), false)
  // Corrupt or blocked storage never breaks an install.
  storage.setItem(KEY_GUIDE_STORAGE_KEY, '{not json')
  assert.deepEqual([...readShownKeyGuides(storage)], [])
  assert.doesNotThrow(() => rememberKeyGuideShown('x', { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } }))
})

test('the guide is offered only on the success path of every store / team install', () => {
  const sheet = read('src/components/SkillDetailSheet.tsx')
  const install = sheet.slice(sheet.indexOf('const executeInstall = async'), sheet.indexOf('} catch (error: unknown) {', sheet.indexOf('const executeInstall = async')))
  assert.match(install, /setInstallStep\('done'\)[^]*if \(acquired\) offerKeyInstallGuide\(acquired\)/)
  assert.match(install, /acquired = \{ id: imported\.id, acquisitionSource: imported\.acquisitionSource \?\? acquisitionSource, envDeps: imported\.envDeps \}/)
  const store = sheet.slice(sheet.indexOf('const acquireFromStore = async'), sheet.indexOf('} catch (error: unknown) { if (receipt)', sheet.indexOf('const acquireFromStore = async')))
  assert.match(store, /if \(!update\) offerKeyInstallGuide\(local\)/)
  const market = read('src/pages/MarketplacePage.tsx')
  const join = market.slice(market.indexOf('const joinMySkills = async'), market.indexOf("} catch (error: unknown) { if (receipt) void apiFinishMarketplaceInstallIntent(receipt, 'failed')", market.indexOf('const joinMySkills = async')))
  assert.match(join, /if \(!confirmed\) offerKeyInstallGuide\(local\)\n\s+return true/)
  assert.match(read('src/App.tsx'), /<KeyInstallGuide \/>\n\s+\{!spacePending && <KeyConsentDialog key=\{`consent:\$\{spaceKey\}`\} \/>\}/)
})

test('guide summary: all green closes in one click; otherwise rows are filled inline', () => {
  assert.deepEqual(keyGuideSummary(['ready', 'ready']), { allReady: true, pending: 0, title: '已就绪' })
  assert.deepEqual(keyGuideSummary(['ready', 'needs_value', 'needs_choice']), { allReady: false, pending: 2, title: '还有 2 把钥匙要处理' })
  assert.equal(keyGuideSummary([]).allReady, false)
  const guide = read('src/components/KeyInstallGuide.tsx')
  assert.match(guide, /summary\.allReady\n\s+\? <button type="button" className="btn btn-primary" onClick=\{onClose\}>完成<\/button>/)
  assert.match(guide, /<KeyRequirementList skill=\{skill\} role=\{role\} policy=\{policy\}[^\n]*variant="guide" \/>/)
  // Remembered as soon as it opens, so closing never brings it back automatically.
  assert.match(guide, /rememberKeyGuideShown\(detail\.skillId\)\n\s+setSkillId\(detail\.skillId\)/)
})

// ── Safety and visual contract ──

test('values are never echoed: no value reaches toasts, labels or the guide', () => {
  const keys = read('src/components/SkillKeys.tsx')
  for (const toastCall of keys.match(/toast\([^)]*\)/g) ?? []) assert.doesNotMatch(toastCall, /\bvalue\b/, toastCall)
  assert.match(keys, /<input type="password"/)
  assert.doesNotMatch(read('src/lib/skill-keys.ts').replace(/^\s*(\/\/|\*|\/\*\*).*$/gm, ''), /\bvalue\b/)
  assert.doesNotMatch(read('src/components/KeyInstallGuide.tsx'), /setSkillEnv|type="text"/)
})

test('visual: canonical tokens, warning + key-round for 需要填写, success for 可用, md buttons, narrow and reduced-motion', () => {
  const css = read('src/components/SkillKeys.css')
  const legacy = LEGACY_TOKEN_NAMES
  for (const name of legacy) assert.doesNotMatch(css, new RegExp(`var\\(--${name}\\)`), name)
  assert.doesNotMatch(css, /gradient\(|border-left/)
  assert.match(css, /\.key-req-badge\.success \{ background: var\(--color-success-tint\); color: var\(--color-success\); \}/)
  assert.match(css, /\.key-req-badge\.warning \{ background: var\(--color-warning-tint\); color: var\(--color-warning\); \}/)
  assert.match(css, /\.key-req-action \.btn \{ border-radius: var\(--radius-md\);/)
  assert.match(css, /\.key-req-name \{[^}]*var\(--font-code\)/s)
  assert.match(css, /@media \(max-width: 520px\)/)
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/)
  assert.match(css, /:focus-visible[^{]*\{\s*outline: 2px solid var\(--color-brand\);/)
  const keys = read('src/components/SkillKeys.tsx')
  assert.match(keys, /needs_value: \{ label: KEY_COPY\.needsValue, icon: 'key-round', tone: 'warning' \}/)
  assert.match(keys, /ready: \{ label: KEY_COPY\.ready, icon: 'check', tone: 'success' \}/)
  // Every action is a real button or input, so it is keyboard reachable.
  assert.doesNotMatch(keys, /<(div|span)[^>]*onClick/)
})

// ── 「变量名不一致」 (#288) ──

test('alias suggestion copy: same service, different variable name, value not re-entered', () => {
  assert.equal(KEY_COPY.aliasSuggestionTitle('fal.ai'), '你已有一把 fal.ai 钥匙：')
  assert.equal(KEY_COPY.aliasUseButton('FAL_KEY'), '用 FAL_KEY')
  assert.equal(KEY_COPY.aliasFillNew, '填写新的值')
  assert.equal(KEY_COPY.aliasLinkedToast('FAL_API_KEY', 'FAL_KEY'), '已关联：FAL_API_KEY 现在也使用你的 FAL_KEY')
  assert.equal(KEY_COPY.aliasSuggestionBody('FAL_API_KEY'), `${KEY_COPY.aliasSuggestionMiddle}FAL_API_KEY${KEY_COPY.aliasSuggestionTail}`)
  assert.equal(
    aliasSuggestionText('fal.ai', 'FAL_KEY', 'FAL_API_KEY'),
    '你已有一把 fal.ai 钥匙：FAL_KEY。它们是同一家服务的 Key，只是变量名不同。用它的话，运行这个 Skill 时会以 FAL_API_KEY 的名字注入，值不需要再填一遍。',
  )
  const codes = aliasSuggestionSegments('fal.ai', 'FAL_KEY', 'FAL_API_KEY').filter((segment) => segment.code).map((segment) => segment.text)
  assert.deepEqual(codes, ['FAL_KEY', 'FAL_API_KEY'])
})

test('alias suggestion: looked up once per key, offered only for 需要填写, two buttons, merged alias list with undo', () => {
  const keys = read('src/components/SkillKeys.tsx')
  // Memoized per account + key, cleared on any key change; a failed lookup shows nothing.
  assert.match(keys, /aliasSuggestions\.get\(id\)/)
  assert.match(keys, /suggestVaultKeyAlias\(key, accountUserId\)\.catch\(\(\) => null\)/)
  assert.match(keys, /window\.addEventListener\(ENV_READINESS_CHANGED_EVENT, \(\) => aliasSuggestions\.clear\(\)\)/)
  assert.match(keys, /useAliasSuggestion\(dependency\.key, elements\.primary === 'fill', accountUserId\)/)
  // The prompt replaces the plain 填写 button and offers 用 X / 填写新的值.
  assert.match(keys, /elements\.primary === 'fill' && !suggesting && <button/)
  assert.match(keys, /\{KEY_COPY\.aliasFillNew\}/)
  assert.match(keys, /KEY_COPY\.aliasUseButton\(existingKey\)/)
  assert.match(keys, /onFillNew=\{\(\) => setPanel\('fill'\)\}/)
  // 用 X: merged list written to the existing key; undo removes only this name.
  assert.match(keys, /setVaultKeyAliases\(existingKey, mergeAlias\(await vaultAliases\(existingKey, accountUserId\), keyName\), accountUserId\)/)
  assert.match(keys, /setVaultKeyAliases\(existingKey, removeAlias\(await vaultAliases\(existingKey, accountUserId\), keyName\), accountUserId\)/)
  assert.match(keys, /toast\(KEY_COPY\.aliasLinkedToast\(keyName, existingKey\), 'default', async \(\) => \{/)
  // No duplicate clicks while busy.
  assert.match(keys, /if \(inFlight\.current\) return\n\s+inFlight\.current = true\n\s+setLinking\(true\)/)
  assert.match(keys, /disabled=\{linking\} onClick=\{\(\) => void link\(\)\}/)
  assert.match(read('src/components/SkillKeys.css'), /\.key-alias-suggest \{/)
})
