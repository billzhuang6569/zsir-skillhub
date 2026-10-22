/** #306: 同名多把钥匙——带标签的变体、永远有默认、Skill 可指定用哪一把。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  KEYS_PAGE_COPY,
  applyConsentChoice,
  consentDialogTitle,
  consentKeysText,
  convertedToast,
  isDefaultVariant,
  overrideListLabel,
  overrideSkillEntries,
  personalKeyCardView,
  personalKeyMenuIds,
  personalKeysToShare,
  primaryVaultKey,
  resolveKeyIdentity,
  shareCandidates,
  shareVariantOptions,
  sortVaultKeys,
  validateVariantLabel,
  variantChoices,
  variantDisplayName,
  vaultDefaultFor,
  vaultKeyIdentity,
} from '../src/lib/keys.ts'
import {
  KEY_COPY,
  canSwitchSource,
  currentSourceChoiceId,
  keySourceChoices,
  personalVariantInUse,
  sourceKey,
  usingLabel,
} from '../src/lib/skill-keys.ts'
import { consentEntry, runFailureEntry } from '../src/lib/notification-center.ts'
import type { KeyConsentRequest, SkillEnvSourcePolicyRow, VaultKey } from '../src/lib/tauri.ts'

const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

// The native list holds every value of the name, the unlabelled one as `id: null`.
const variants = [{ id: null, label: null, isDefault: true }, { id: 'v1', label: '公司', isDefault: false }]
const movedDefault = [{ id: null, label: null, isDefault: false }, { id: 'v1', label: '公司', isDefault: true }]

const row = (overrides: Partial<VaultKey> = {}): VaultKey => ({
  key: 'FAL_KEY',
  aliases: ['FAL_API_KEY'],
  createdAt: 1,
  updatedAt: 2,
  usedBySkills: [
    { id: 'imagegen', name: 'zsir-imagegen', declaredDescription: 'fal.ai API Key', declaredKey: 'FAL_KEY', requiresConsent: false, enabled: true },
    { id: 'seedance', name: 'seedance-prompt', declaredDescription: null, declaredKey: 'FAL_KEY', requiresConsent: false, enabled: true },
  ],
  allowedSkills: [],
  blockedSkills: [],
  autoAllow: false,
  overrideSkills: [],
  lastUsedAt: null,
  variant: null,
  label: null,
  isDefault: true,
  variants,
  ...overrides,
})

const company = (overrides: Partial<VaultKey> = {}): VaultKey => row({ variant: 'v1', label: '公司', isDefault: false, overrideSkills: [], ...overrides })
const onlyLabelled = [{ id: 'v1', label: '公司', isDefault: true }, { id: 'v2', label: '测试', isDefault: false }]

test('identity = name + label: display names, card identities and grouping order', () => {
  assert.equal(variantDisplayName('FAL_KEY', null), 'FAL_KEY')
  assert.equal(variantDisplayName('FAL_KEY', ' 公司 '), 'FAL_KEY · 公司')
  assert.equal(vaultKeyIdentity(row()), 'FAL_KEY')
  assert.equal(vaultKeyIdentity(company()), 'FAL_KEY::v1')
  const sorted = sortVaultKeys([
    company({ variant: 'v2', label: '测试' }),
    row({ key: 'OPENAI_API_KEY', variants: [] }),
    company(),
    row(),
    row({ key: 'A_KEY', variants: [] }),
  ])
  // Labels sort by zh-CN collation: 测试 (cè) before 公司 (gōng).
  assert.deepEqual(sorted.map((key) => vaultKeyIdentity(key)), ['A_KEY', 'FAL_KEY', 'FAL_KEY::v2', 'FAL_KEY::v1', 'OPENAI_API_KEY'])
  const both = [{ id: null, label: null, isDefault: true }, { id: 'v2', label: '测试', isDefault: false }, { id: 'v1', label: '公司', isDefault: false }]
  assert.deepEqual(sortVaultKeys([company({ variants: both }), company({ variant: 'v2', label: '测试', variants: both })]).map((key) => key.variant), ['v2', 'v1'], 'native order wins')
  assert.equal(primaryVaultKey([company(), row()], 'FAL_KEY')?.variant, null)
  assert.deepEqual(personalKeysToShare([row(), company()], []), ['FAL_KEY'])
  assert.deepEqual(shareCandidates([row(), company()], ['FAL_API_KEY']), ['FAL_KEY'])
})

test('there is always a default: the unlabelled one unless a labelled variant says so', () => {
  assert.deepEqual(variantChoices(row()), [
    { id: null, label: null, isDefault: true },
    { id: 'v1', label: '公司', isDefault: false },
  ])
  assert.deepEqual(variantChoices(row({ variants: movedDefault })).map((choice) => choice.isDefault), [false, true])
  assert.equal(isDefaultVariant({ variant: null, variants: movedDefault }), false)
  assert.equal(isDefaultVariant({ variant: 'v1', variants: movedDefault }), true)
  // No unlabelled value: the native list omits it and no phantom entry is added.
  assert.deepEqual(variantChoices({ variants: onlyLabelled }).map((choice) => choice.id), ['v1', 'v2'])
  // An older listing without the #306 fields is one unlabelled default.
  assert.equal(isDefaultVariant({}), true)
  assert.deepEqual(variantChoices({}), [{ id: null, label: null, isDefault: true }])
})

test('card view: label chip, 默认 only when the name has several values, aliases editable on the unlabelled card', () => {
  const main = personalKeyCardView(row())
  assert.equal(main.label, null)
  assert.equal(main.isDefault, true)
  assert.equal(main.grouped, true)
  assert.equal(main.aliasesEditable, true)
  const variant = personalKeyCardView(company())
  assert.equal(variant.label, '公司')
  assert.equal(variant.isDefault, false)
  assert.equal(variant.aliasesEditable, false)
  assert.deepEqual(variant.aliases, ['FAL_API_KEY'])
  assert.equal(personalKeyCardView(row({ variants: [] })).grouped, false)
  assert.equal(personalKeyCardView(row({ variants: [{ id: null, label: null, isDefault: true }] })).grouped, false)
  // Without an unlabelled value the default card owns the aliases.
  assert.equal(personalKeyCardView(company({ isDefault: true, variants: onlyLabelled })).aliasesEditable, true)
})

test('⋯ menu: 关联变量名 on the unlabelled card, 设为默认 on non-default ones, 重命名标签 on labelled ones', () => {
  assert.deepEqual(personalKeyMenuIds(row()), ['replace', 'alias', 'addVariant', 'revoke'])
  assert.deepEqual(personalKeyMenuIds(company()), ['replace', 'setDefault', 'addVariant', 'renameLabel', 'revoke'])
  assert.deepEqual(personalKeyMenuIds(row({ isDefault: false, variants: movedDefault })), ['replace', 'alias', 'setDefault', 'addVariant', 'revoke'])
  assert.deepEqual(personalKeyMenuIds(company({ isDefault: true, variants: movedDefault })), ['replace', 'addVariant', 'renameLabel', 'revoke'])
  assert.deepEqual(personalKeyMenuIds(company({ isDefault: true, variants: onlyLabelled })), ['replace', 'alias', 'addVariant', 'renameLabel', 'revoke'])
})

test('labels: required, at most 24 characters, unique per name; renaming to itself is fine', () => {
  assert.equal(validateVariantLabel('  ', []), KEYS_PAGE_COPY.variantLabelEmpty)
  assert.equal(validateVariantLabel('公'.repeat(24), []), null)
  assert.equal(validateVariantLabel('公'.repeat(25), []), '标签最多 24 个字')
  assert.equal(validateVariantLabel(' 公司 ', [null, '公司']), '标签「公司」已存在')
  assert.equal(validateVariantLabel('公司', [null, '公司'], '公司'), null)
  assert.equal(validateVariantLabel('个人', [null, '公司']), null)
})

test('override line: the Skills keeping their own value, and the conversion toast', () => {
  const key = row({ overrideSkills: ['seedance', 'seedance', 'gone'] })
  assert.deepEqual(overrideSkillEntries(key), [{ id: 'seedance', name: 'seedance-prompt' }, { id: 'gone', name: 'gone' }])
  assert.equal(overrideListLabel(2), '2 个 Skill 使用不同的值')
  assert.equal(convertedToast('FAL_KEY', '公司', 'seedance-prompt'), '已转成 FAL_KEY · 公司，seedance-prompt 现在使用它')
})

test('share dialog radios: 默认 first, then labelled values; a labelled default reads 默认（公司）', () => {
  assert.deepEqual(shareVariantOptions(row()), [
    { id: null, isDefault: true, text: '默认' },
    { id: 'v1', isDefault: false, text: '公司' },
  ])
  assert.deepEqual(shareVariantOptions(row({ variants: movedDefault })), [
    { id: 'v1', isDefault: true, text: '默认（公司）' },
    { id: null, isDefault: false, text: KEYS_PAGE_COPY.unlabelled },
  ])
  assert.equal(shareVariantOptions(row({ variants: [] })).length, 1)
})

test('「存为带标签的新钥匙」 is offered only when the name (or an alias) already has an unlabelled value', () => {
  assert.equal(vaultDefaultFor([row(), company()], 'FAL_API_KEY')?.variant, null)
  assert.equal(vaultDefaultFor([company({ isDefault: true, variants: onlyLabelled })], 'FAL_KEY')?.variant, 'v1')
  assert.equal(vaultDefaultFor([row()], 'OPENAI_API_KEY'), undefined)
})

test('consent: a synthetic variant identity never shows raw, and is granted as key + variant', async () => {
  const vault = [row(), company()]
  assert.deepEqual(resolveKeyIdentity('FAL_KEY__V1', [row(), company({ variant: 'V1' })]), { key: 'FAL_KEY', variant: 'V1', display: 'FAL_KEY · 公司' })
  assert.deepEqual(resolveKeyIdentity('FAL_KEY__v1', vault), { key: 'FAL_KEY', variant: 'v1', display: 'FAL_KEY · 公司' })
  // The native displayKeys entry wins; never a raw synthetic name; else a neutral fallback.
  assert.equal(resolveKeyIdentity('FAL_KEY__V3', [], 'FAL_KEY · 测试').display, 'FAL_KEY · 测试')
  assert.equal(resolveKeyIdentity('FAL_KEY__V3', [], 'FAL_KEY__V3').display, `FAL_KEY · ${KEYS_PAGE_COPY.variantFallbackLabel}`)
  assert.equal(resolveKeyIdentity('FAL_KEY__V3', []).display, `FAL_KEY · ${KEYS_PAGE_COPY.variantFallbackLabel}`)
  assert.equal(consentKeysText({ keys: ['FAL_KEY__V3', 'A'], displayKeys: ['FAL_KEY · 测试', 'A'] }), 'FAL_KEY · 测试、A')
  assert.deepEqual(resolveKeyIdentity('FAL_KEY', vault), { key: 'FAL_KEY', variant: null, display: 'FAL_KEY' })
  assert.equal(resolveKeyIdentity('MY__KEY', []).display, 'MY__KEY')

  const request: KeyConsentRequest = { skillId: 'seedance', skillName: 'seedance-prompt', keys: ['FAL_KEY__v1', 'OPENAI_API_KEY'], requestedAt: 1 }
  assert.equal(consentKeysText(request, vault), 'FAL_KEY · 公司、OPENAI_API_KEY')
  assert.equal(consentDialogTitle(request, vault), 'seedance-prompt 想使用你的 FAL_KEY · 公司、OPENAI_API_KEY')
  for (const text of [consentDialogTitle(request, vault), JSON.stringify(consentEntry(request, vault).title)]) assert.doesNotMatch(text, /__v1/i)

  const grants: unknown[][] = []
  await applyConsentChoice(request, 'allow', false, 'u1', {
    grantKeyAccess: async (...args) => { grants.push(args) },
    dismissKeyConsentRequest: async () => undefined,
    setKeyAutoAllow: async () => undefined,
  }, vault)
  assert.deepEqual(grants, [['seedance', 'FAL_KEY', false, 'u1', 'v1'], ['seedance', 'OPENAI_API_KEY', false, 'u1', null]])

  const failure = runFailureEntry({ version: 1, skillId: 'seedance', at: 1, outcome: 'failed', reasonCode: 'needs_consent', keys: ['FAL_KEY__v1'], exitCode: null, agent: null, message: null }, 'seedance-prompt', 2, vault)
  assert.doesNotMatch(JSON.stringify(failure.description), /__v1/)
})

const policy = (overrides: Partial<SkillEnvSourcePolicyRow> = {}): SkillEnvSourcePolicyRow => ({
  key: 'FAL_KEY',
  required: true,
  selected: null,
  effective: { kind: 'personal' },
  valid: true,
  state: 'ready',
  options: [{ kind: 'personal', available: true }, { kind: 'team', teamId: 't1', teamName: '一探', available: true }],
  personalSource: 'vault',
  personalVariants: [{ id: null, label: null, isDefault: true }, { id: 'v1', label: '公司', isDefault: false }],
  selectedVariant: null,
  ...overrides,
})

test('Skill detail switcher: 你的钥匙（默认）, 你的钥匙 · 公司, then teams; picking a variant writes personal_variant', () => {
  const choices = keySourceChoices(policy())
  assert.deepEqual(choices.map((choice) => [choice.id, choice.label]), [
    ['personal', KEY_COPY.personalDefault],
    ['personal:v1', '你的钥匙 · 公司'],
    ['team:t1', '一探 团队的钥匙'],
  ])
  assert.deepEqual(choices[1]!.source, { kind: 'personalVariant', variant: 'v1' })
  assert.equal(sourceKey({ kind: 'personalVariant', variant: 'v1' }), 'personal:v1')
  assert.equal(currentSourceChoiceId(policy()), 'personal')
  assert.equal(usingLabel(policy()), '使用：你的钥匙')
  // The Skill uses 公司 (explicit choice, or as the native selectedVariant says).
  const onVariant = policy({ selected: { kind: 'personalVariant', variant: 'v1' }, effective: { kind: 'personalVariant', variant: 'v1' }, selectedVariant: 'v1' })
  assert.equal(currentSourceChoiceId(onVariant), 'personal:v1')
  assert.equal(personalVariantInUse(onVariant), '公司')
  assert.equal(usingLabel(onVariant), '使用：你的钥匙 · 公司')
  assert.equal(usingLabel(policy({ selectedVariant: 'v1' })), '使用：你的钥匙 · 公司')
  // Without variants nothing changes; a personal key alone never offers a switch.
  const plain = policy({ personalVariants: [{ id: null, label: null, isDefault: true }], options: [{ kind: 'personal', available: true }] })
  assert.deepEqual(keySourceChoices(plain).map((choice) => choice.label), [KEY_COPY.personal])
  assert.equal(canSwitchSource(plain), false)
  assert.equal(canSwitchSource(policy({ options: [{ kind: 'personal', available: true }] })), true)
  // The default variant is not listed twice; a team source never shows a variant label.
  const moved = policy({ personalVariants: [{ id: null, label: null, isDefault: false }, { id: 'v1', label: '公司', isDefault: true }], selectedVariant: 'v1' })
  // Default on 公司: 你的钥匙（默认） first, then the unlabelled value explicitly (variant: null).
  assert.deepEqual(keySourceChoices(moved).map((choice) => [choice.id, choice.label]), [
    ['personal', KEY_COPY.personalDefault],
    ['personal:unlabelled', '你的钥匙 · 不带标签的那一把'],
    ['team:t1', '一探 团队的钥匙'],
  ])
  assert.deepEqual(keySourceChoices(moved)[1]!.source, { kind: 'personalVariant', variant: null })
  assert.equal(usingLabel(moved), '使用：你的钥匙 · 公司')
  assert.equal(currentSourceChoiceId(moved), 'personal')
  const onUnlabelled = { ...moved, selected: { kind: 'personalVariant' as const, variant: null }, effective: { kind: 'personalVariant' as const, variant: null }, selectedVariant: null }
  assert.equal(currentSourceChoiceId(onUnlabelled), 'personal:unlabelled')
  assert.equal(usingLabel(onUnlabelled), '使用：你的钥匙 · 不带标签的那一把')
  // While the unlabelled value is the default, no extra entry and no label.
  assert.equal(keySourceChoices(policy()).some((choice) => choice.id === 'personal:unlabelled'), false)
  assert.equal(usingLabel(policy({ effective: { kind: 'personalVariant', variant: null } })), '使用：你的钥匙')
  assert.equal(usingLabel(policy({ effective: { kind: 'team', teamId: 't1' }, selectedVariant: 'v1' })), '使用：一探 团队的钥匙')
})

test('wrappers: every #306 command passes accountUserId and the optional variant', () => {
  const tauri = read('src/lib/tauri.ts')
  assert.match(tauri, /invoke<\{ variant: string \}>\('create_vault_key_variant', \{ space: await currentSpace\(\), key, label, value, accountUserId \}\)/)
  assert.match(tauri, /invoke\('set_vault_key', \{ space: await currentSpace\(\), key, value, variant, accountUserId \}\)/)
  assert.match(tauri, /invoke\('set_vault_key_variant_label', \{ space: await currentSpace\(\), key, variant, label, accountUserId \}\)/)
  assert.match(tauri, /invoke\('set_vault_default_variant', \{ space: await currentSpace\(\), key, variant, accountUserId \}\)/)
  assert.match(tauri, /invoke\('delete_vault_key', \{ space: await currentSpace\(\), key, variant, accountUserId \}\)/)
  assert.match(tauri, /invoke<\{ variant: string \}>\('convert_skill_override_to_variant', \{ space: await currentSpace\(\), skillId, key, label, accountUserId \}\)/)
  assert.match(tauri, /invoke\('grant_key_access', \{ space: space \?\? await currentSpace\(\), skillId, key, once, variant, accountUserId \}\)/)
  assert.match(tauri, /invoke\('revoke_key_access', \{ space: await currentSpace\(\), skillId, key, variant, accountUserId \}\)/)
  assert.match(tauri, /invoke\('set_key_auto_allow', \{ space: space \?\? await currentSpace\(\), enabled, key, variant, accountUserId \}\)/)
  assert.match(tauri, /\| \{ kind: 'personalVariant'; variant: string \| null \}/)
  assert.match(tauri, /personalVariants\?: PersonalKeyVariantOption\[\]/)
  assert.match(tauri, /selectedVariant\?: string \| null/)
})

test('markup: cards per variant with 默认 tag and grouping, menu entries, override conversion, share radio, fill option', () => {
  const card = read('src/components/KeyCard.tsx')
  assert.match(card, /\{label && <span className="key-variant-label" title=\{label\}>· \{label\}<\/span>\}/)
  assert.match(card, /\{showDefault && isDefault && <span className="key-default-tag">\{KEYS_PAGE_COPY\.defaultTag\}<\/span>\}/)
  assert.match(read('src/components/KeyCard.css'), /\.key-card-variant \{[^}]*margin-left/s)

  const page = read('src/pages/KeysPage.tsx')
  assert.match(page, /className=\{view\.variant !== null \? 'key-card-variant' : undefined\}/)
  assert.match(page, /await setVaultDefaultVariant\(key\.key, key\.variant \?\? null, accountUserId\)/)
  assert.match(page, /await createVaultKeyVariant\(key\.key, label, value, accountUserId\)/)
  assert.match(page, /await setVaultKeyVariantLabel\(key\.key, key\.variant, label, accountUserId\)/)
  assert.match(page, /await convertSkillOverrideToVariant\(skill\.id, key\.key, label, accountUserId\)/)
  assert.match(page, /toast\(convertedToast\(key\.key, label, skill\.name\)\)/)
  assert.match(page, /await deleteVaultKey\(revoking\.key, accountUserId, revoking\.variant \?\? null\)/)
  assert.match(page, /className="key-override-toggle" aria-expanded=\{overridesExpanded\}/)
  assert.match(page, /\{KEYS_PAGE_COPY\.convertToVariant\}/)
  assert.match(page, /const overrides = overrideSkillEntries\(key\)/)
  assert.equal(KEYS_PAGE_COPY.setDefault, '设为默认')
  assert.equal(KEYS_PAGE_COPY.addVariant, '添加另一把（带标签）')
  assert.equal(KEYS_PAGE_COPY.renameLabel, '重命名标签')
  assert.equal(KEYS_PAGE_COPY.convertToVariant, '转成一把带标签的钥匙')
  assert.equal(KEYS_PAGE_COPY.defaultTag, '默认')

  const dialog = read('src/components/KeyVariantDialog.tsx')
  assert.match(dialog, /const problem = validateVariantLabel\(label, existingLabels, mode === 'rename' \? initialLabel : null\)/)
  assert.match(dialog, /\{withValue && <label className="secret-input-label">/)
  assert.match(dialog, /role="alert" id="key-variant-error"/)

  const share = read('src/components/ShareKeyDialog.tsx')
  assert.match(share, /\{variantOptions\.length > 1 && <fieldset className="key-variant-choices share-key-variant" role="radiogroup"/)
  assert.match(share, /<legend>\{KEYS_PAGE_COPY\.shareWhich\}<\/legend>/)
  assert.match(share, /<input type="radio" name="share-key-variant" checked=\{shareVariant === option\.id\}/)
  assert.equal(KEYS_PAGE_COPY.shareWhich, '共享哪一把')

  const keys = read('src/components/SkillKeys.tsx')
  assert.match(keys, /const choices = keySourceChoices\(row\)\n\s+const current = currentSourceChoiceId\(row\)/)
  assert.match(keys, /await setSkillEnvSource\(managedSkillId, keyName, \{ kind: 'personalVariant', variant \}, accountUserId\)/)
  assert.match(keys, /\{defaultEntry && <button type="button" className="btn btn-ghost btn-sm"[^\n]*>\{KEY_COPY\.saveAsVariant\}<\/button>\}/)
  assert.match(keys, /await setVaultKey\(keyName, value, accountUserId, variant\)/)
  assert.equal(KEY_COPY.saveAsVariant, '存为带标签的新钥匙')

  const consent = read('src/components/KeyConsentDialog.tsx')
  assert.match(consent, /const title = consentDialogTitle\(request, vaultKeys\)/)
  assert.match(consent, /\{consentKeysText\(request, vaultKeys\)\}/)
  assert.doesNotMatch(consent, /request\.keys\.join/)
})
