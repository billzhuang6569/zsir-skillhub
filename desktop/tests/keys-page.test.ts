/** #294: 钥匙页卡片、逐个 Skill 启用 / 停用、共享弹窗多团队、关联变量名。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  KEYS_PAGE_COPY,
  SHARE_DIALOG_COPY,
  joinKeyNames,
  keyNames,
  keyUsageSummary,
  personalKeyCardView,
  shareButtonLabel,
  shareCandidates,
  shareDialogBody,
  shareFailureLines,
  TEAM_KEYS_UNAVAILABLE,
  isTeamKeysUnavailable,
  shareResultMessage,
  shareTeamLine,
  shareTeamState,
  skillInitials,
  teamMembersLine,
  teamSkillCountForKey,
  validateAliasName,
  vaultSkillChips,
  vaultSkillEnabled,
} from '../src/lib/keys.ts'
import type { TeamKey, VaultKey } from '../src/lib/tauri.ts'

const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

const vaultKey = (overrides: Partial<VaultKey> = {}): VaultKey => ({
  key: 'FAL_KEY',
  aliases: ['FAL_API_KEY'],
  createdAt: 1,
  updatedAt: 2,
  usedBySkills: [
    { id: 'imagegen', name: 'zsir-imagegen', declaredDescription: 'fal.ai API Key', declaredKey: 'FAL_KEY', requiresConsent: false, enabled: true },
    { id: 'seedance', name: 'seedance-prompt', declaredDescription: null, declaredKey: 'FAL_API_KEY', requiresConsent: true, enabled: true },
    { id: 'baoyu', name: 'baoyu-infographic', declaredDescription: null, declaredKey: 'FAL_KEY', requiresConsent: true, enabled: false },
  ],
  allowedSkills: ['seedance'],
  blockedSkills: [],
  autoAllow: false,
  overrideSkills: [],
  lastUsedAt: null,
  ...overrides,
})

const teamKey = (overrides: Partial<TeamKey> = {}): TeamKey => ({
  key: 'FAL_KEY',
  aliases: [],
  holder: { id: 'me', displayName: '小庄Sir' },
  revision: 1,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  canManage: true,
  inScopeSkills: [],
  exclusions: [],
  lastUsedAt: null,
  ...overrides,
})

test('the card summary counts Skills, enabled ones and Skills with their own value', () => {
  assert.equal(keyUsageSummary(4, 3), '4 个 Skill 会用到，3 个启用')
  assert.equal(keyUsageSummary(2, 1, 1), '2 个 Skill 会用到，1 个启用 · 1 个 Skill 使用不同的值')
  const view = personalKeyCardView(vaultKey({ overrideSkills: ['baoyu'], lastUsedAt: Date.parse('2026-10-13T10:00:00Z') }), false, Date.parse('2026-10-13T12:00:00Z'))
  assert.equal(view.summary, '3 个 Skill 会用到，2 个启用 · 1 个 Skill 使用不同的值')
  assert.equal(view.purpose, 'fal.ai API Key')
  assert.equal(view.lastUsed, '2 小时前')
  assert.deepEqual(view.aliases, ['FAL_API_KEY'])
  assert.equal(personalKeyCardView(vaultKey({ usedBySkills: [] })).purpose, KEYS_PAGE_COPY.noPurpose)
  assert.equal(personalKeyCardView(vaultKey({ usedBySkills: [] })).summary, '0 个 Skill 会用到，0 个启用')
})

test('Skill chips: alias Skills read 「以 X 注入」, overrides 「使用不同的值」, one chip per Skill', () => {
  const chips = vaultSkillChips(vaultKey({
    overrideSkills: ['baoyu'],
    usedBySkills: [
      ...vaultKey().usedBySkills,
      { id: 'seedance', name: 'seedance-prompt', declaredDescription: null, declaredKey: 'FAL_KEY', requiresConsent: true, enabled: true },
    ],
  }))
  assert.deepEqual(chips.map((chip) => [chip.id, chip.sub, chip.enabled, chip.override]), [
    ['imagegen', 'fal.ai API Key', true, false],
    ['seedance', '以 FAL_API_KEY 注入', true, false],
    ['baoyu', '使用不同的值', false, true],
  ])
})

test('the native enabled flag wins; an older listing falls back to the same rule', () => {
  const key = vaultKey({ allowedSkills: ['allowed'], blockedSkills: ['blocked'] })
  const legacy = (id: string, requiresConsent?: boolean) => ({ id, name: id, declaredDescription: null, declaredKey: 'FAL_KEY', requiresConsent })
  assert.equal(vaultSkillEnabled(key, { ...legacy('blocked', false), enabled: true }), true)
  assert.equal(vaultSkillEnabled(key, legacy('blocked', false)), false)
  assert.equal(vaultSkillEnabled(key, legacy('own', false)), true)
  assert.equal(vaultSkillEnabled(key, legacy('allowed', true)), true)
  assert.equal(vaultSkillEnabled(key, legacy('store', true)), false)
  assert.equal(vaultSkillEnabled(key, legacy('store', true), true), true)
  assert.equal(vaultSkillEnabled({ ...key, autoAllow: true }, legacy('store', true)), true)
})

test('alias names are upper-case variable names, never the main name or a duplicate', () => {
  assert.equal(validateAliasName('FAL_API_KEY', 'FAL_KEY', []), null)
  assert.equal(validateAliasName('', 'FAL_KEY', []), '请输入变量名')
  assert.match(validateAliasName('fal_api_key', 'FAL_KEY', []) ?? '', /大写字母开头/)
  assert.match(validateAliasName('1FAL', 'FAL_KEY', []) ?? '', /大写字母开头/)
  assert.match(validateAliasName(`A${'B'.repeat(100)}`, 'FAL_KEY', []) ?? '', /大写字母开头/)
  assert.equal(validateAliasName('FAL_KEY', 'FAL_KEY', []), 'FAL_KEY 就是这把钥匙的主名')
  assert.equal(validateAliasName('FAL_API_KEY', 'FAL_KEY', ['FAL_API_KEY']), 'FAL_API_KEY 已经关联过了')
})

test('share dialog copy lists the key and its aliases and counts team Skills by any of the names', () => {
  assert.deepEqual(keyNames(vaultKey()), ['FAL_KEY', 'FAL_API_KEY'])
  assert.equal(joinKeyNames(['FAL_KEY']), 'FAL_KEY')
  assert.equal(joinKeyNames(['FAL_KEY', 'FAL_API_KEY']), 'FAL_KEY 或 FAL_API_KEY')
  assert.equal(joinKeyNames(['A', 'B', 'C']), 'A、B 或 C')
  assert.deepEqual(shareDialogBody(['FAL_KEY', 'FAL_API_KEY']), [
    '钥匙会加密保存到一探 SkillHub。',
    '团队成员运行用到 FAL_KEY（或别名）的 Skill 时会自动带上它；界面里看不到原文，但 Skill 运行时能读到。',
    '请只共享给信任的人。',
  ])
  assert.equal(shareDialogBody(['FAL_KEY'])[1], '团队成员运行用到 FAL_KEY 的 Skill 时会自动带上它；界面里看不到原文，但 Skill 运行时能读到。')
  const skills = [
    { envDependencies: [{ key: 'FAL_KEY' }] },
    { envDependencies: [{ key: 'FAL_API_KEY' }, { key: 'OTHER' }] },
    { envDependencies: [{ key: 'OPENAI_API_KEY' }] },
    { envDependencies: null },
    {},
  ]
  assert.equal(teamSkillCountForKey(skills, ['FAL_KEY', 'FAL_API_KEY']), 2)
  assert.equal(teamSkillCountForKey(skills, ['FAL_KEY']), 1)
  assert.equal(shareTeamLine(6, 3), '6 人 · 团队里有 3 个 Skill 会用到')
  assert.equal(shareTeamLine(12, null), '12 人')
  assert.equal(teamMembersLine(6), '6 位成员 · 团队里任何成员都可以放钥匙')
  assert.equal(shareButtonLabel(0), '共享到 0 个团队')
  assert.equal(shareButtonLabel(2), '共享到 2 个团队')
  assert.equal(SHARE_DIALOG_COPY.footer, '共享后可以在「钥匙 · 团队」里逐个停用 Skill，并查看谁用过。成员退出团队后立即失去使用权。')
  assert.equal(SHARE_DIALOG_COPY.mine, '已共享 · 你是持有人')
})

test('a team row is selectable, yours (停止共享) or someone else\'s key', () => {
  assert.deepEqual(shareTeamState(null, 'FAL_KEY', 'me'), { kind: 'available' })
  assert.deepEqual(shareTeamState([teamKey({ key: 'OTHER' })], 'FAL_KEY', 'me'), { kind: 'available' })
  assert.deepEqual(shareTeamState([teamKey()], 'FAL_KEY', 'me'), { kind: 'mine' })
  assert.deepEqual(shareTeamState([teamKey({ holder: { id: 'u2', displayName: '王小明' }, canManage: false })], 'FAL_KEY', 'me'), { kind: 'other', holder: '王小明', canManage: false })
  assert.deepEqual(shareTeamState([teamKey({ holder: { id: 'u2', displayName: '王小明' } })], 'FAL_KEY', null), { kind: 'other', holder: '王小明', canManage: true })
})

test('「共享给团队」 from a Skill picks the vault keys it declares, by main name or alias', () => {
  const vault = [vaultKey(), vaultKey({ key: 'OPENAI_API_KEY', aliases: [] }), vaultKey({ key: 'HF_TOKEN', aliases: [] })]
  assert.deepEqual(shareCandidates(vault, ['FAL_API_KEY']), ['FAL_KEY'])
  assert.deepEqual(shareCandidates(vault, ['FAL_KEY', 'OPENAI_API_KEY']), ['FAL_KEY', 'OPENAI_API_KEY'])
  assert.deepEqual(shareCandidates(vault, ['NOTHING']), [])
  assert.equal(shareResultMessage('FAL_KEY', ['内容组', '研发组'], []), 'FAL_KEY 已共享到 内容组、研发组')
  assert.equal(shareResultMessage('FAL_KEY', ['内容组'], [{ team: '研发组', error: 'FAL_API_KEY 已经是另一把钥匙的变量名' }]), 'FAL_KEY 已共享到 内容组；研发组：FAL_API_KEY 已经是另一把钥匙的变量名')
  assert.equal(skillInitials('zsir-imagegen'), 'ZI')
  assert.equal(skillInitials('seedance'), 'SE')
  assert.equal(skillInitials('一探内容组'), '一探')
  assert.equal(skillInitials('  '), '?')
})

test('Skill chips are pressable buttons; the ⋯ menu is a keyboard menu', () => {
  const card = read('src/components/KeyCard.tsx')
  assert.match(card, /className=\{`key-skill-chip\$\{chip\.enabled \? ' is-on' : ''\}`\}\n\s+aria-pressed=\{chip\.enabled\}/)
  assert.match(card, /\{busy \? '…' : state\}/)
  assert.match(card, /aria-haspopup="menu"\n\s+aria-expanded=\{open\}/)
  assert.match(card, /role="menu" aria-label=\{label\} onKeyDown=\{onMenuKeyDown\}/)
  assert.match(card, /role="menuitem"/)
  assert.match(card, /if \(event\.key === 'Escape'\) \{ event\.preventDefault\(\); event\.stopPropagation\(\); close\(\); return \}/)
  assert.match(card, /nextRovingIndex\(index, buttons\.length, event\.key, 'vertical'\)/)
  const page = read('src/pages/KeysPage.tsx')
  assert.equal(KEYS_PAGE_COPY.moreLabel, '更多操作：更换、关联变量名、撤销')
  assert.match(page, /<MenuButton label=\{KEYS_PAGE_COPY\.moreLabel\} items=\{menuItems\(key\)\}>/)
  for (const id of ['replace', 'alias', 'setDefault', 'addVariant', 'renameLabel', 'revoke']) assert.match(page, new RegExp(`\\{ id: '${id}'`), id)
  assert.match(page, /return personalKeyMenuIds\(key\)\.map\(\(id\) => items\[id\]\)/)
  assert.match(page, /await setVaultKeySkillAccess\(key\.key, chip\.id, !chip\.enabled, accountUserId, key\.variant \?\? null\)/)
  assert.match(page, /<VaultKeyReplaceForm id=\{`\$\{domId\}-replace`\} keyName=\{key\.key\} variant=\{view\.variant\}/)
  assert.match(page, /\{shareKey && <ShareKeyDialog keyName=\{shareKey\.key\} initialVariant=\{shareKey\.variant \?\? null\} onClose=\{\(\) => setShareKey\(null\)\} \/>\}/)
  assert.equal(KEYS_PAGE_COPY.skillsTitle, '可以用这把钥匙的 Skill')
  assert.equal(KEYS_PAGE_COPY.skillsHint, '点击卡片启用或停用')
})

test('team tab: picker, 放进我的钥匙, holder chip, exclusion toggles and lazy usage for holder/owner', () => {
  const team = read('src/components/TeamKeyList.tsx')
  assert.match(team, /teams\.length <= 3\n\s+\? <SegmentedControl mode="radiogroup"/)
  assert.match(team, /label=\{KEYS_PAGE_COPY\.putMine\}/)
  assert.match(team, /<UserChip name=\{view\.holder\} me=\{view\.holderId === accountUserId\} \/> 放的钥匙 · \{view\.revision\} · 最近使用 \{view\.lastUsed\}/)
  assert.match(team, /readOnly=\{!view\.canManage\}/)
  assert.match(team, /setTeamKeyExclusion\(teamId, key\.key, chip\.id, chip\.enabled, current\.userId\)/)
  assert.match(team, /const loadUsageFor = expandedKey\?\.canManage \? expandedKey\.key : null/)
  assert.match(team, /\{view\.canManage && <KeySkillSection title=\{KEYS_PAGE_COPY\.usageTitle\} hint=\{KEYS_PAGE_COPY\.usageHint\}>/)
  assert.match(team, /if \(!currentUser\) return [^\n]*KEYS_PAGE_COPY\.teamSignedOut/)
  assert.equal(KEYS_PAGE_COPY.teamSignedOut, '登录后可以查看团队钥匙')
  assert.equal(KEYS_PAGE_COPY.usageTitle, '最近 30 天谁用过')
  assert.equal(KEYS_PAGE_COPY.usageHint, '只有放钥匙的人和团队负责人能看到')
})

test('team 「换新值」 explains itself, takes the value from 个人 only on an explicit click, and 撤销 says what members see (#320)', () => {
  const team = read('src/components/TeamKeyList.tsx')
  assert.equal(KEYS_PAGE_COPY.teamReplace, '换新值')
  assert.equal(KEYS_PAGE_COPY.teamReplaceHint, '换新值后，团队里用到它的 Skill 下次运行就会改用新值，旧值不再使用。')
  assert.equal(KEYS_PAGE_COPY.teamReplaceFromMine, '用我的个人钥匙替换')
  assert.match(KEYS_PAGE_COPY.teamRevokeHint, /^撤销后，团队成员不再拿到这把钥匙；没有自己同名钥匙的成员再运行用到它的 Skill 会提示缺少钥匙/)
  // The row button only opens the panel; nothing is written until the explicit secondary action.
  assert.match(team, /aria-label=\{`\$\{KEYS_PAGE_COPY\.teamReplace\}：\$\{key\.key\}`\} aria-expanded=\{replaceOpen\} aria-controls=\{replaceOpen \? replacePanelId : undefined\} disabled=\{busy\} onClick=\{\(\) => setReplacing\(replaceOpen \? null : key\.key\)\}>\{KEYS_PAGE_COPY\.teamReplace\}<\/button>/)
  assert.match(team, /<div className="key-req-panel" id=\{replacePanelId\} role="group" aria-label=\{`\$\{KEYS_PAGE_COPY\.teamReplace\}：\$\{key\.key\}`\}>\n\s+<p className="key-req-hint">\{KEYS_PAGE_COPY\.teamReplaceHint\}<\/p>/)
  assert.match(team, /replaceable \? KEYS_PAGE_COPY\.teamReplaceSource : KEYS_PAGE_COPY\.teamReplaceNeedsMine/)
  assert.match(team, /\{replaceable && <button type="button" className="btn btn-soft btn-sm"[^\n]*putTeamKey\(teamId, key\.key, current\.userId\)[^\n]*\{KEYS_PAGE_COPY\.teamReplaceFromMine\}<\/button>\}/)
  assert.match(team, /aria-label=\{`\$\{KEYS_PAGE_COPY\.revoke\}：\$\{key\.key\}`\} title=\{KEYS_PAGE_COPY\.teamRevokeHint\}/)
  assert.match(team, /<ConfirmModal eyebrow="团队钥匙" title=\{`从团队撤销 \$\{revoking\}？`\} description=\{KEYS_PAGE_COPY\.teamRevokeHint\}/)
  assert.doesNotMatch(team, /KEYS_PAGE_COPY\.replace\}|更换团队钥匙/)
})

test('the share dialog traps focus, lists teams as checkboxes and shares one team at a time', () => {
  const dialog = read('src/components/ShareKeyDialog.tsx')
  assert.match(dialog, /<FocusTrapDialog className="modal-layer above-sheet" label=\{`共享 \$\{keyName\} 给团队`\}/)
  assert.match(dialog, /<h2>共享 <code className="key-card-name">\{keyName\}<\/code> 给团队<\/h2>/)
  assert.match(dialog, /<fieldset className="share-key-teams"/)
  assert.match(dialog, /<input type="checkbox" checked=\{checked\}/)
  assert.match(dialog, /for \(const team of teams\.filter\(\(candidate\) => selected\.has\(candidate\.id\)\)\) \{\n\s+try \{\n\s+await putTeamKey\(team\.id, keyName, accountUserId, shareVariant\)/)
  assert.match(dialog, /disabled=\{busy \|\| selected\.size === 0\}/)
  assert.match(dialog, /await deleteTeamKey\(target\.id, keyName, accountUserId\)/)
  assert.match(dialog, /apiGetTeamSkills\(teamId\)\.then\(\(skills\) => teamSkillCountForKey\(skills, wanted\)\)/)
  // From a Skill: one key → dialog, several → chooser, none → the 团队 tab.
  assert.match(dialog, /if \(keys\.length === 0\) fallbackRef\.current\(\)\n\s+else if \(keys\.length === 1\) setChosen\(keys\[0\] \?\? null\)/)
})

test('关联变量名 edits the list locally and writes it once; native errors show inline', () => {
  const editor = read('src/components/KeyAliasEditor.tsx')
  assert.match(editor, /const problem = validateAliasName\(name, keyName, names\)/)
  assert.match(editor, /await setVaultKeyAliases\(keyName, names, accountUserId\)/)
  assert.match(editor, /aria-label=\{`移除 \$\{name\}`\}/)
  assert.match(editor, /role="alert" id="key-alias-error"/)
})

test('set_vault_key_skill_access is a typed wrapper sending names and ids only, registered natively', () => {
  const tauri = read('src/lib/tauri.ts')
  assert.match(tauri, /invoke\('set_vault_key_skill_access', \{ space: await currentSpace\(\), key, skillId, enabled, variant, accountUserId \}\)/)
  assert.match(tauri, /blockedSkills\?: string\[\]/)
  assert.match(tauri, /requiresConsent\?: boolean/)
  assert.match(read('src-tauri/src/lib.rs'), /commands::set_vault_key_skill_access,/)
  const vault = read('src-tauri/src/key_vault.rs')
  assert.match(vault, /pub\(crate\) blocked_skills: Vec<String>,/)
  // #306: blocks key on the served identity (`NAME` or `NAME__V<n>`).
  assert.match(vault, /if meta\.blocks\(skill_id, &identity\) \{\n\s+return None;/)
})

test('a Server without team keys shows one plain notice, not 「Not Found」', () => {
  const rust = read('src-tauri/src/team_keys.rs')
  assert.match(rust, new RegExp(`"${TEAM_KEYS_UNAVAILABLE}"`))
  assert.equal(isTeamKeysUnavailable(TEAM_KEYS_UNAVAILABLE), true)
  assert.equal(isTeamKeysUnavailable('Team key not found'), false)
  assert.deepEqual(shareFailureLines([
    { team: '产品组', error: TEAM_KEYS_UNAVAILABLE },
    { team: '设计组', error: TEAM_KEYS_UNAVAILABLE },
    { team: '运营组', error: '网络超时' },
  ]), [TEAM_KEYS_UNAVAILABLE, '运营组：网络超时'])
  const team = read('src/components/TeamKeyList.tsx')
  assert.match(team, /isTeamKeysUnavailable\(state\.error\)\s*\? <p className="share-key-note keys-team-unavailable" role="status">/)
  assert.match(read('src/components/ShareKeyDialog.tsx'), /setErrors\(shareFailureLines\(failed\)\)/)
})
