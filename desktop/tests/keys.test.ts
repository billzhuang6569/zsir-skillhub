import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  acceptsTeamKeyResponse,
  acceptsVaultResponse,
  aliasesOf,
  applyConsentChoice,
  canReplaceFromVault,
  consentDialogTitle,
  consentRequestId,
  EMPTY_TEAM_KEY_VAULT_STATE,
  formatLastUsed,
  injectedAsNote,
  keyRowView,
  loadKeyVault,
  loadTeamKeys,
  mergeAlias,
  nextConsentRequest,
  personalKeysToShare,
  removeAlias,
  skillUsageLabel,
  teamKeyCardView,
  usageRowText,
  usageRowView,
  type ConsentWriter,
} from '../src/lib/keys.ts'
import type { KeyConsentRequest, TeamKey, TeamKeyList, VaultKey } from '../src/lib/tauri.ts'

const vaultKey = (overrides: Partial<VaultKey> = {}): VaultKey => ({
  key: 'FAL_KEY',
  aliases: [],
  createdAt: 1,
  updatedAt: 2,
  usedBySkills: [
    { id: 'alpha', name: 'Alpha', declaredDescription: 'fal.ai API Key', declaredKey: 'FAL_KEY' },
    { id: 'beta', name: 'Beta', declaredDescription: 'fal.ai API Key', declaredKey: 'FAL_KEY' },
  ],
  allowedSkills: ['alpha'],
  autoAllow: false,
  overrideSkills: [],
  lastUsedAt: null,
  ...overrides,
})

const request = (overrides: Partial<KeyConsentRequest> = {}): KeyConsentRequest => ({
  skillId: 'store-image',
  skillName: 'Store Image',
  keys: ['FAL_KEY'],
  requestedAt: 100,
  ...overrides,
})

function recorder(): { calls: string[]; writer: ConsentWriter } {
  const calls: string[] = []
  return {
    calls,
    writer: {
      grantKeyAccess: async (skillId, key, once, account) => { calls.push(`grant:${skillId}:${key}:${once}:${account}`) },
      dismissKeyConsentRequest: async (skillId, account) => { calls.push(`dismiss:${skillId}:${account}`) },
      setKeyAutoAllow: async (enabled, key, account) => { calls.push(`auto:${enabled}:${key}:${account}`) },
    },
  }
}

test('vault rows summarise purpose, usage and differing overrides without values', () => {
  const row = keyRowView(vaultKey({ overrideSkills: ['beta'], lastUsedAt: 0 }), 10)
  assert.equal(row.purpose, 'fal.ai API Key')
  assert.deepEqual(row.usedBy, ['Alpha', 'Beta'])
  assert.equal(row.allowedCount, 1)
  assert.equal(row.notice, '有 1 个 Skill 使用不同的 FAL_KEY')
  assert.equal(row.lastUsed, '尚未使用')
  assert.equal(formatLastUsed(1_000, 1_000 + 5 * 60_000), '5 分钟前使用')
  assert.equal(formatLastUsed(1_000, 1_000 + 3 * 3_600_000), '3 小时前使用')
  assert.doesNotMatch(JSON.stringify(row), /value/i)
})

test('loading the vault keeps the account it was read for and fails closed', async () => {
  const loaded = await loadKeyVault('user-a', {
    listVaultKeys: async () => [vaultKey({ key: 'Z_KEY' }), vaultKey()],
    getKeyVaultSettings: async () => ({ autoAllow: true, migration: null }),
  })
  assert.equal(loaded.status, 'ready')
  assert.deepEqual(loaded.keys.map((key) => key.key), ['FAL_KEY', 'Z_KEY'])
  assert.equal(loaded.autoAllow, true)
  assert.equal(acceptsVaultResponse('user-a', loaded), true)
  assert.equal(acceptsVaultResponse('user-b', loaded), false)
  const failed = await loadKeyVault(null, {
    listVaultKeys: async () => { throw new Error('SkillHub 账号已切换，请重新打开钥匙页') },
    getKeyVaultSettings: async () => ({ autoAllow: false, migration: null }),
  })
  assert.equal(failed.status, 'error')
  assert.deepEqual(failed.keys, [])
  assert.match(failed.error ?? '', /账号已切换/)
})

test('consent choices map to allow, once and deny without storing a denial', async () => {
  assert.equal(consentDialogTitle(request()), 'Store Image 想使用你的 FAL_KEY')

  const allow = recorder()
  await applyConsentChoice(request({ keys: ['FAL_KEY', 'OPENAI_API_KEY'] }), 'allow', false, 'user-a', allow.writer)
  assert.deepEqual(allow.calls, ['grant:store-image:FAL_KEY:false:user-a', 'grant:store-image:OPENAI_API_KEY:false:user-a'])

  const once = recorder()
  await applyConsentChoice(request(), 'once', true, null, once.writer)
  assert.deepEqual(once.calls, ['auto:true:null:null', 'grant:store-image:FAL_KEY:true:null'])

  const deny = recorder()
  await applyConsentChoice(request(), 'deny', true, 'user-a', deny.writer)
  assert.deepEqual(deny.calls, ['dismiss:store-image:user-a'])
})

test('the oldest unanswered request is shown next', () => {
  const first = request({ skillId: 'a', requestedAt: 5 })
  const second = request({ skillId: 'b', requestedAt: 9 })
  assert.equal(nextConsentRequest([second, first], new Set()), first)
  assert.equal(nextConsentRequest([second, first], new Set([consentRequestId(first)])), second)
  assert.equal(nextConsentRequest([first], new Set([consentRequestId(first)])), null)
})

test('the Skill env tab no longer offers copying another Skill value', () => {
  const sheet = readFileSync(new URL('../src/components/SkillDetailSheet.tsx', import.meta.url), 'utf8')
  assert.doesNotMatch(sheet, /listReusableSkillEnvs|copySkillEnvValue|env-reuse-action|使用「\{reusable/)
  const keys = readFileSync(new URL('../src/components/SkillKeys.tsx', import.meta.url), 'utf8')
  assert.match(keys, /setSkillEnv\(managedSkillId, keyName, value, accountUserId, scope\)/)
  assert.match(keys, /void save\('skill'\)/)
  const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
  assert.match(app, /<KeyConsentDialog key=\{`consent:\$\{spaceKey\}`\} \/>/)
  const dialog = readFileSync(new URL('../src/components/KeyConsentDialog.tsx', import.meta.url), 'utf8')
  for (const label of ['允许', '仅这次', '拒绝', '以后不再询问，有能用的就用']) assert.ok(dialog.includes(label), label)
})

// ── Team key vault (#254) ──

const teamKey = (overrides: Partial<TeamKey> = {}): TeamKey => ({
  key: 'FAL_KEY',
  aliases: [],
  holder: { id: 'user-a', displayName: '小王' },
  revision: 2,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-02T00:00:00.000Z',
  canManage: false,
  inScopeSkills: [{ id: 'skill-1', name: '生图', declaredKey: 'FAL_KEY' }],
  exclusions: [],
  lastUsedAt: null,
  ...overrides,
})

test('team key cards name the holder and revision; in-scope Skills are on, excluded ones off', () => {
  const now = Date.parse('2026-10-05T03:00:00.000Z')
  const view = teamKeyCardView(teamKey({
    lastUsedAt: '2026-10-05T00:00:00.000Z',
    aliases: ['FAL_API_KEY'],
    inScopeSkills: [{ id: 'skill-1', name: '生图', declaredKey: 'FAL_API_KEY' }],
    exclusions: [{ skillId: 'skill-2', name: '翻译', createdAt: '2026-10-03T00:00:00.000Z' }],
  }), now)
  assert.equal(view.holder, '小王')
  assert.equal(view.holderId, 'user-a')
  assert.equal(view.revision, '第 2 版')
  assert.equal(view.lastUsed, '3 小时前')
  assert.deepEqual(view.aliases, ['FAL_API_KEY'])
  assert.equal(view.summary, '2 个 Skill 会用到，1 个启用')
  assert.deepEqual(view.chips.map((chip) => [chip.name, chip.enabled, chip.sub]), [['生图', true, '以 FAL_API_KEY 注入'], ['翻译', false, '']])
  assert.doesNotMatch(JSON.stringify(view), /"value"|ciphertext/i)
  assert.equal(teamKeyCardView(teamKey({ inScopeSkills: [] })).summary, '0 个 Skill 会用到，0 个启用')
  assert.equal(teamKeyCardView(teamKey()).lastUsed, '从未使用')
})

test('loading team keys is bound to the account and team it was read for', async () => {
  const list: TeamKeyList = { teamId: 'team-1', teamName: '产品组', isTeamOwner: true, credentials: [teamKey({ key: 'Z_KEY' }), teamKey()] }
  const loaded = await loadTeamKeys('user-a', 'team-1', { listTeamKeys: async () => list })
  assert.equal(loaded.status, 'ready')
  assert.equal(loaded.teamName, '产品组')
  assert.equal(loaded.isTeamOwner, true)
  assert.deepEqual(loaded.keys.map((key) => key.key), ['FAL_KEY', 'Z_KEY'])
  assert.equal(acceptsTeamKeyResponse('user-a', 'team-1', loaded), true)
  assert.equal(acceptsTeamKeyResponse('user-b', 'team-1', loaded), false)
  assert.equal(acceptsTeamKeyResponse('user-a', 'team-2', loaded), false)
  const failed = await loadTeamKeys('user-a', 'team-1', { listTeamKeys: async () => { throw new Error('Active team membership required') } })
  assert.equal(failed.status, 'error')
  assert.deepEqual(failed.keys, [])
  assert.equal(EMPTY_TEAM_KEY_VAULT_STATE.status, 'idle')
})

test('「放进团队」 offers personal vault keys the team does not hold; 团队「换新值」 needs a vault value', () => {
  const personal = [vaultKey({ key: 'OPENAI_API_KEY' }), vaultKey(), vaultKey({ key: 'HF_TOKEN' })]
  assert.deepEqual(personalKeysToShare(personal, [teamKey()]), ['HF_TOKEN', 'OPENAI_API_KEY'])
  assert.equal(canReplaceFromVault(personal, 'FAL_KEY'), true)
  assert.equal(canReplaceFromVault(personal, 'REPLICATE_API_TOKEN'), false)
})

test('usage rows read as who, through which Skill, how often', () => {
  const now = Date.parse('2026-10-05T00:10:00.000Z')
  assert.equal(usageRowText({ actor: { id: 'u', displayName: '小李' }, skill: { id: 's', name: '生图' }, count: 4, lastAt: '2026-10-05T00:00:00.000Z' }, now), '小李 通过「生图」使用 4 次 · 10 分钟前')
  assert.equal(usageRowText({ actor: null, skill: null, count: 1, lastAt: '2026-10-05T00:10:00.000Z' }, now), '已注销账号 通过「已删除的 Skill」使用 1 次 · 刚刚')
  assert.deepEqual(usageRowView({ actor: { id: 'u', displayName: '小李' }, skill: { id: 's', name: '生图' }, count: 4, lastAt: '2026-10-05T00:00:00.000Z' }, now), { actor: '小李', skill: '通过「生图」', count: '4 次', when: '10 分钟前' })
  assert.equal(usageRowView({ actor: null, skill: null, count: 1, lastAt: '2026-10-05T00:10:00.000Z' }, now).actor, '已注销账号')
})

test('the team key slice resets on every account change and lives on the 钥匙 page, not in 设置', () => {
  const store = readFileSync(new URL('../src/store/index.ts', import.meta.url), 'utf8')
  assert.equal(store.match(/teamKeyVault: EMPTY_TEAM_KEY_VAULT_STATE/g)?.length, 3)
  assert.match(store, /teamKeyVault: sameSession \? state\.teamKeyVault : EMPTY_TEAM_KEY_VAULT_STATE/)
  const settings = readFileSync(new URL('../src/pages/SettingsPage.tsx', import.meta.url), 'utf8')
  assert.doesNotMatch(settings, /TeamKeyList|settings-label">团队钥匙/)
  const page = readFileSync(new URL('../src/pages/KeysPage.tsx', import.meta.url), 'utf8')
  assert.match(page, /const team = useTeamKeys\(\)/)
  assert.match(page, /<TeamKeyList binding=\{team\} \/>/)
  const tauri = readFileSync(new URL('../src/lib/tauri.ts', import.meta.url), 'utf8')
  for (const command of ['list_team_keys', 'put_team_key', 'delete_team_key', 'set_team_key_exclusion', 'team_key_usage', 'provide_personal_env_to_team']) {
    assert.match(tauri, new RegExp(`invoke(<[A-Za-z]+>)?\\('${command}'`), command)
  }
  // putTeamKey sends only names and ids: the value is read natively.
  assert.match(tauri, /invoke<TeamKeyWrite>\('put_team_key', \{ space: await currentSpace\(\), teamId, key, variant, accountUserId \}\)/)
  const lib = readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8')
  for (const command of ['list_team_keys', 'put_team_key', 'delete_team_key', 'set_team_key_exclusion', 'set_team_key_aliases', 'team_key_usage']) {
    assert.match(lib, new RegExp(`team_keys::${command},`), command)
  }
  for (const command of ['set_vault_key_aliases', 'suggest_vault_key_alias', 'set_vault_key_skill_access']) {
    assert.match(lib, new RegExp(`commands::${command},`), command)
  }
})

// ── Aliases (#288) ──

test('alias helpers merge once, remove cleanly and tolerate an older native listing', () => {
  assert.deepEqual(mergeAlias(['FAL_AI_KEY'], 'FAL_API_KEY'), ['FAL_AI_KEY', 'FAL_API_KEY'])
  assert.deepEqual(mergeAlias(['FAL_API_KEY'], 'FAL_API_KEY'), ['FAL_API_KEY'])
  assert.deepEqual(removeAlias(['FAL_AI_KEY', 'FAL_API_KEY'], 'FAL_API_KEY'), ['FAL_AI_KEY'])
  assert.deepEqual(removeAlias([], 'FAL_API_KEY'), [])
  assert.deepEqual(aliasesOf({ aliases: ['FAL_API_KEY'] }), ['FAL_API_KEY'])
  assert.deepEqual(aliasesOf({}), [])
  // Undo of a link restores exactly the list before it.
  const before = ['FAL_AI_KEY']
  assert.deepEqual(removeAlias(mergeAlias(before, 'FAL_API_KEY'), 'FAL_API_KEY'), before)
})

test('a Skill served through an alias reads 「以 X 注入」; a direct match stays plain', () => {
  assert.equal(injectedAsNote('FAL_API_KEY', 'FAL_KEY'), '以 FAL_API_KEY 注入')
  assert.equal(injectedAsNote('FAL_KEY', 'FAL_KEY'), null)
  assert.equal(injectedAsNote(undefined, 'FAL_KEY'), null)
  assert.equal(skillUsageLabel({ name: 'Beta', declaredKey: 'FAL_API_KEY' }, 'FAL_KEY'), 'Beta（以 FAL_API_KEY 注入）')
})

test('alias tags render as bare mono tags after the main name, never with 「也叫」', () => {
  const card = readFileSync(new URL('../src/components/KeyCard.tsx', import.meta.url), 'utf8')
  assert.match(card, /<code className="key-card-name" title=\{name\}>\{name\}<\/code>\n[^]*?\{aliases\.map\(\(alias\) => <code key=\{alias\} className="key-alias-tag" title=\{aliasesTitle \?\? alias\}>\{alias\}<\/code>\)\}/)
  const team = readFileSync(new URL('../src/components/TeamKeyList.tsx', import.meta.url), 'utf8')
  const page = readFileSync(new URL('../src/pages/KeysPage.tsx', import.meta.url), 'utf8')
  assert.match(team, /names=\{<KeyNames name=\{view\.key\} aliases=\{view\.aliases\} \/>\}/)
  assert.match(page, /names=\{<KeyNames name=\{view\.key\} aliases=\{view\.aliases\} label=\{view\.label\} isDefault=\{view\.isDefault\} showDefault=\{view\.grouped\}/)
  for (const source of [card, team, page, readFileSync(new URL('../src/lib/keys.ts', import.meta.url), 'utf8')]) assert.doesNotMatch(source, /也叫/)
  const css = readFileSync(new URL('../src/components/KeyCard.css', import.meta.url), 'utf8')
  assert.match(css, /\.key-card-names \{[^}]*flex-wrap: wrap;/s)
  const global = readFileSync(new URL('../src/styles/global.css', import.meta.url), 'utf8')
  assert.match(global, /\.key-alias-tag \{[^}]*var\(--font-code\)/s)
})

test('alias commands are typed wrappers that send names only', () => {
  const tauri = readFileSync(new URL('../src/lib/tauri.ts', import.meta.url), 'utf8')
  assert.match(tauri, /invoke\('set_vault_key_aliases', \{ space: await currentSpace\(\), key, aliases, accountUserId \}\)/)
  assert.match(tauri, /invoke<VaultKeyAliasSuggestion \| null>\('suggest_vault_key_alias', \{ space: await currentSpace\(\), key, accountUserId \}\)/)
  assert.match(tauri, /invoke\('set_team_key_aliases', \{ space: await currentSpace\(\), teamId, key, aliases, accountUserId \}\)/)
  assert.match(tauri, /export type VaultKeyAliasSuggestion = \{ service: string; existingKey: string \}/)
})

test('「共享给团队」 hands the 钥匙 page a one-shot keysPageIntent that opens 团队 and is cleared (#289)', () => {
  const store = readFileSync(new URL('../src/store/index.ts', import.meta.url), 'utf8')
  assert.match(store, /export type KeysPageIntent = \{ tab: 'personal' \| 'team'; key\?: string \}/)
  assert.match(store, /keysPageIntent: KeysPageIntent \| null\n\s+setKeysPageIntent: \(intent: KeysPageIntent \| null\) => void/)
  assert.match(store, /keysPageIntent: null,\n\s+setKeysPageIntent: \(keysPageIntent\) => set\(\{ keysPageIntent \}\),/)
  const page = readFileSync(new URL('../src/pages/KeysPage.tsx', import.meta.url), 'utf8')
  assert.match(page, /useState<KeyScope>\(\(\) => keysPageIntent\?\.tab \?\? 'personal'\)/)
  assert.match(page, /if \(!keysPageIntent\) return\n\s+setScope\(keysPageIntent\.tab\)\n\s+if \(keysPageIntent\.key\) \{ setExpanded\(keysPageIntent\.key\); setFocusKey\(keysPageIntent\.key\) \}\n\s+setKeysPageIntent\(null\)/)
  // The auto-allow checkbox moved to 设置 › 通用 as a Switch.
  const vault = readFileSync(new URL('../src/pages/KeyVaultPage.tsx', import.meta.url), 'utf8')
  assert.doesNotMatch(vault, /type="checkbox"|setKeyAutoAllow|以后不再询问/)
})
