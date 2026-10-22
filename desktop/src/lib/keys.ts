import type { KeyConsentRequest, KeyVaultSettings, TeamKey, TeamKeyList, TeamKeyUsageRow, VaultKey, VaultKeyVariantRef, VaultMigrationReport } from './tauri.js'

/**
 * Data layer for the 「钥匙」 page and the first-use consent dialog (#253).
 *
 * Every native call is injected so this module stays pure and testable; the
 * React side passes the `tauri.ts` wrappers. Nothing here ever handles a key
 * value: listings carry names, purposes, Skill ids and timestamps only.
 */

export type KeyVaultStatus = 'idle' | 'loading' | 'ready' | 'error'

export type KeyVaultState = {
  /** Runtime identity the data belongs to (`null` = local guest). */
  accountUserId: string | null
  status: KeyVaultStatus
  keys: VaultKey[]
  autoAllow: boolean
  migration: VaultMigrationReport | null
  error: string | null
}

export const EMPTY_KEY_VAULT_STATE: KeyVaultState = {
  accountUserId: null,
  status: 'idle',
  keys: [],
  autoAllow: false,
  migration: null,
  error: null,
}

export type KeyVaultReader = {
  listVaultKeys: (accountUserId: string | null) => Promise<VaultKey[]>
  getKeyVaultSettings: (accountUserId: string | null) => Promise<KeyVaultSettings>
}

export async function loadKeyVault(accountUserId: string | null, reader: KeyVaultReader): Promise<KeyVaultState> {
  try {
    const [keys, settings] = await Promise.all([
      reader.listVaultKeys(accountUserId),
      reader.getKeyVaultSettings(accountUserId),
    ])
    return {
      accountUserId,
      status: 'ready',
      keys: sortVaultKeys(keys),
      autoAllow: settings.autoAllow,
      migration: settings.migration,
      error: null,
    }
  } catch (error: unknown) {
    return {
      ...EMPTY_KEY_VAULT_STATE,
      accountUserId,
      status: 'error',
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

// ── Labelled variants (#306): one name, several values, always one default ──

/** The variant id of a row (`null` = the unlabelled value). */
export function variantOf(key: Pick<VaultKey, 'variant'>): string | null {
  return key.variant ?? null
}

type LabelledVariant = VaultKeyVariantRef & { id: string }

/** The labelled variants of the name; an older native layer without them reads as none. */
export function labelledVariants(key: Pick<VaultKey, 'variants'>): LabelledVariant[] {
  return Array.isArray(key.variants) ? key.variants.filter((entry): entry is LabelledVariant => typeof entry.id === 'string' && entry.id.length > 0) : []
}

/** The name has more than one value. */
export function hasVariants(key: Pick<VaultKey, 'variants'>): boolean {
  return variantChoices(key).length > 1
}

/** Whether this row is the value Skills use by default. Older listings: the only (unlabelled) row. */
export function isDefaultVariant(key: Pick<VaultKey, 'variant' | 'isDefault' | 'variants'>): boolean {
  if (typeof key.isDefault === 'boolean') return key.isDefault
  const variant = variantOf(key)
  const variants = labelledVariants(key)
  return variant === null ? !variants.some((entry) => entry.isDefault) : variants.some((entry) => entry.id === variant && entry.isDefault)
}

export type VariantChoice = { id: string | null; label: string | null; isDefault: boolean }

/**
 * Every value of the name, the unlabelled one first. The native list
 * already holds it (`id: null`, present only when it has a value); an older
 * listing without `variants` is one unlabelled default.
 */
export function variantChoices(key: Pick<VaultKey, 'variants'>): VariantChoice[] {
  const all = Array.isArray(key.variants) ? key.variants : []
  if (all.length === 0) return [{ id: null, label: null, isDefault: true }]
  const unlabelled = all.filter((entry) => entry.id === null || entry.id === '')
  return [
    ...unlabelled.slice(0, 1).map((entry) => ({ id: null, label: null, isDefault: entry.isDefault })),
    ...labelledVariants(key).map((entry) => ({ id: entry.id, label: entry.label, isDefault: entry.isDefault })),
  ]
}

/**
 * Aliases belong to the name: they are edited on the unlabelled card, or on
 * the default card when the name has no unlabelled value.
 */
export function ownsNameSettings(key: Pick<VaultKey, 'variant' | 'isDefault' | 'variants'>): boolean {
  if (variantOf(key) === null) return true
  return !variantChoices(key).some((choice) => choice.id === null) && isDefaultVariant(key)
}

/** 「FAL_KEY」 / 「FAL_KEY · 公司」. */
export function variantDisplayName(name: string, label: string | null | undefined): string {
  const text = label?.trim()
  return text ? `${name} · ${text}` : name
}

/** The display name of one vault row. */
export function vaultKeyDisplayName(key: Pick<VaultKey, 'key' | 'label'>): string {
  return variantDisplayName(key.key, key.label)
}

/** Stable identity of one card / row: the name, plus `::variant` for a labelled one. */
export function vaultKeyIdentity(key: Pick<VaultKey, 'key' | 'variant'>): string {
  const variant = variantOf(key)
  return variant === null ? key.key : `${key.key}::${variant}`
}

/** Same names adjacent, the unlabelled row first, then labelled ones by label. */
export function compareVaultKeys(left: VaultKey, right: VaultKey): number {
  const byName = left.key.localeCompare(right.key)
  if (byName !== 0) return byName
  const leftVariant = variantOf(left)
  const rightVariant = variantOf(right)
  if (leftVariant === null || rightVariant === null) return leftVariant === rightVariant ? 0 : leftVariant === null ? -1 : 1
  // The native list order (creation order) first; labels only for rows it does not list.
  const order = variantChoices(left).map((choice) => choice.id)
  const leftIndex = order.indexOf(leftVariant)
  const rightIndex = order.indexOf(rightVariant)
  if (leftIndex >= 0 && rightIndex >= 0) return leftIndex - rightIndex
  return (left.label ?? leftVariant).localeCompare(right.label ?? rightVariant, 'zh-CN')
}

export function sortVaultKeys(keys: readonly VaultKey[]): VaultKey[] {
  return [...keys].sort(compareVaultKeys)
}

/** The row holding the name's aliases and per-Skill overrides: the unlabelled one (or the first row). */
export function primaryVaultKey(keys: readonly VaultKey[], name: string): VaultKey | undefined {
  const rows = keys.filter((key) => key.key === name)
  return rows.find((key) => variantOf(key) === null) ?? rows[0]
}

/**
 * A vault row answering to `name` (its main name or an alias), preferring
 * the unlabelled one: the name already has a value, so 「存为带标签的新钥匙」
 * is offered (#306).
 */
export function vaultDefaultFor(keys: readonly VaultKey[], name: string): VaultKey | undefined {
  const rows = keys.filter((key) => keyNames(key).includes(name))
  return rows.find((key) => variantOf(key) === null) ?? rows.find((key) => isDefaultVariant(key)) ?? rows[0]
}

/** Personal vault names, once each (a name with variants lists several rows). */
export function vaultKeyNames(keys: readonly VaultKey[]): string[] {
  return [...new Set(keys.map((key) => key.key))]
}

export const VARIANT_LABEL_MAX = 24

/** Client-side check before creating or renaming a variant; the native side has the final say. */
export function validateVariantLabel(raw: string, existingLabels: readonly (string | null | undefined)[], current: string | null = null): string | null {
  const label = raw.trim()
  if (!label) return KEYS_PAGE_COPY.variantLabelEmpty
  if ([...label].length > VARIANT_LABEL_MAX) return `标签最多 ${VARIANT_LABEL_MAX} 个字`
  if (label === current) return null
  if (existingLabels.some((existing) => existing?.trim() === label)) return `标签「${label}」已存在`
  return null
}

export type PersonalKeyMenuId = 'replace' | 'alias' | 'setDefault' | 'addVariant' | 'renameLabel' | 'revoke'

/**
 * ⋯ menu of a personal card: 关联变量名 only on the unlabelled card (aliases
 * belong to the name), 设为默认 on non-default cards, 重命名标签 on labelled ones.
 */
export function personalKeyMenuIds(key: Pick<VaultKey, 'variant' | 'isDefault' | 'variants'>): PersonalKeyMenuId[] {
  const labelled = variantOf(key) !== null
  const ids: PersonalKeyMenuId[] = ['replace']
  if (ownsNameSettings(key)) ids.push('alias')
  if (!isDefaultVariant(key)) ids.push('setDefault')
  ids.push('addVariant')
  if (labelled) ids.push('renameLabel')
  ids.push('revoke')
  return ids
}

/** The Skills keeping their own value for the name: 「K 个 Skill 使用不同的值」 → 转成一把带标签的钥匙. */
export function overrideSkillEntries(key: Pick<VaultKey, 'overrideSkills' | 'usedBySkills'>): { id: string; name: string }[] {
  const names = new Map(key.usedBySkills.map((skill) => [skill.id, skill.name]))
  return [...new Set(key.overrideSkills)].map((id) => ({ id, name: names.get(id) ?? id }))
}

export function overrideListLabel(count: number): string {
  return `${count} 个 Skill 使用不同的值`
}

export function convertedToast(name: string, label: string, skillName: string): string {
  return `已转成 ${variantDisplayName(name, label)}，${skillName} 现在使用它`
}

// ── Variant identities in consent requests (#306) ──

export type KeyIdentity = { key: string; variant: string | null; display: string }

const SYNTHETIC_VARIANT = /^(.+?)__(V\d+)$/i

/**
 * A consent request names a labelled value as a synthetic identity
 * (`FAL_KEY__V1`). Resolve it to key + variant and a display name: the
 * native `displayKeys` entry when given, else the vault rows, else a neutral
 * 「FAL_KEY · 另一把」 — never `__V1`.
 */
export function resolveKeyIdentity(identity: string, vault: readonly VaultKey[], display?: string | null): KeyIdentity {
  const carried = display?.trim() || null
  const row = vault.find((key) => {
    const variant = variantOf(key)
    return variant !== null && identity.toUpperCase() === `${key.key}__${variant}`.toUpperCase()
  })
  if (row) return { key: row.key, variant: variantOf(row), display: carried ?? vaultKeyDisplayName(row) }
  const match = SYNTHETIC_VARIANT.exec(identity)
  if (match) {
    const base = match[1]!
    const variant = match[2]!
    const fromVault = labelledVariants(primaryVaultKey(vault, base) ?? {}).find((entry) => entry.id.toUpperCase() === variant.toUpperCase())?.label
    const safe = carried && !SYNTHETIC_VARIANT.test(carried) ? carried : null
    return { key: base, variant, display: safe ?? variantDisplayName(base, fromVault ?? KEYS_PAGE_COPY.variantFallbackLabel) }
  }
  return { key: identity, variant: null, display: carried ?? identity }
}

export function consentKeyIdentities(request: Pick<KeyConsentRequest, 'keys' | 'displayKeys'>, vault: readonly VaultKey[] = []): KeyIdentity[] {
  return request.keys.map((identity, index) => resolveKeyIdentity(identity, vault, request.displayKeys?.[index]))
}

export function consentKeysText(request: Pick<KeyConsentRequest, 'keys' | 'displayKeys'>, vault: readonly VaultKey[] = []): string {
  return consentKeyIdentities(request, vault).map((identity) => identity.display).join('、')
}

/** A response is applied only if the account did not change meanwhile. */
export function acceptsVaultResponse(currentAccountUserId: string | null, response: KeyVaultState): boolean {
  return response.accountUserId === currentAccountUserId
}

/** 「用途」: the distinct descriptions the declaring Skills give for the key. */
export function keyPurpose(key: VaultKey): string | null {
  const purposes = [...new Set(key.usedBySkills
    .map((skill) => skill.declaredDescription?.trim())
    .filter((value): value is string => Boolean(value)))]
  return purposes.length > 0 ? purposes.join(' · ') : null
}

// ── Aliases (#288): one value, several variable names ──

/** The alias list of a vault or team key; an older native layer without it reads as none. */
export function aliasesOf(key: { aliases?: readonly string[] | null }): string[] {
  return Array.isArray(key.aliases) ? [...key.aliases] : []
}

/** Adds `name` once, keeping the existing order. */
export function mergeAlias(aliases: readonly string[], name: string): string[] {
  return aliases.includes(name) ? [...aliases] : [...aliases, name]
}

/** Drops `name`; the rest keep their order. */
export function removeAlias(aliases: readonly string[], name: string): string[] {
  return aliases.filter((alias) => alias !== name)
}

/** 「以 FAL_API_KEY 注入」 when a Skill declares another name than the key it is served from. */
export function injectedAsNote(declaredKey: string | null | undefined, key: string): string | null {
  return declaredKey && declaredKey !== key ? `以 ${declaredKey} 注入` : null
}

/** A Skill name in a usage list, with the alias it is injected as. */
export function skillUsageLabel(skill: { name: string; declaredKey?: string | null }, key: string): string {
  const note = injectedAsNote(skill.declaredKey, key)
  return note ? `${skill.name}（${note}）` : skill.name
}

/** 「有 N 个 Skill 使用不同的 KEY」, or null when every Skill uses the vault value. */
export function overrideNotice(key: VaultKey): string | null {
  const count = key.overrideSkills.length
  return count > 0 ? `有 ${count} 个 Skill 使用不同的 ${key.key}` : null
}

export function formatLastUsed(lastUsedAt: number | null, now: number = Date.now()): string {
  if (!lastUsedAt) return '尚未使用'
  const minutes = Math.max(0, Math.floor((now - lastUsedAt) / 60_000))
  if (minutes < 1) return '刚刚使用'
  if (minutes < 60) return `${minutes} 分钟前使用`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前使用`
  return `${Math.floor(hours / 24)} 天前使用`
}

export type KeyRowView = {
  key: string
  purpose: string | null
  lastUsed: string
  usedBy: string[]
  allowedCount: number
  notice: string | null
}

export function keyRowView(key: VaultKey, now: number = Date.now()): KeyRowView {
  return {
    key: key.key,
    purpose: keyPurpose(key),
    lastUsed: formatLastUsed(key.lastUsedAt, now),
    usedBy: key.usedBySkills.map((skill) => skill.name),
    allowedCount: key.allowedSkills.length,
    notice: overrideNotice(key),
  }
}

// ── First-use consent ──

export type ConsentChoice = 'allow' | 'once' | 'deny'

export function consentDialogTitle(request: KeyConsentRequest, vault: readonly VaultKey[] = []): string {
  return `${request.skillName} 想使用你的 ${consentKeysText(request, vault)}`
}

export type ConsentWriter = {
  grantKeyAccess: (skillId: string, key: string, once: boolean, accountUserId: string | null, variant: string | null) => Promise<void>
  dismissKeyConsentRequest: (skillId: string, accountUserId: string | null) => Promise<void>
  setKeyAutoAllow: (enabled: boolean, key: string | null, accountUserId: string | null) => Promise<void>
}

/**
 * 允许 → remembered for this Skill; 仅这次 → a one-shot grant for the next run;
 * 拒绝 → nothing is stored. 「以后不再询问，有能用的就用」 turns on the
 * account-level switch, and only together with 允许 / 仅这次.
 */
export async function applyConsentChoice(
  request: KeyConsentRequest,
  choice: ConsentChoice,
  dontAskAgain: boolean,
  accountUserId: string | null,
  writer: ConsentWriter,
  vault: readonly VaultKey[] = [],
): Promise<void> {
  if (choice === 'deny') {
    await writer.dismissKeyConsentRequest(request.skillId, accountUserId)
    return
  }
  if (dontAskAgain) await writer.setKeyAutoAllow(true, null, accountUserId)
  for (const { key, variant } of consentKeyIdentities(request, vault)) {
    await writer.grantKeyAccess(request.skillId, key, choice === 'once', accountUserId, variant)
  }
}

/** The request to show next: the oldest one not answered in this session. */
export function nextConsentRequest(requests: KeyConsentRequest[], answered: ReadonlySet<string>): KeyConsentRequest | null {
  return [...requests]
    .sort((left, right) => left.requestedAt - right.requestedAt)
    .find((request) => !answered.has(consentRequestId(request))) ?? null
}

export function consentRequestId(request: KeyConsentRequest): string {
  return `${request.skillId}:${request.requestedAt}`
}

// ── Team key vault (#254) ──
//
// One value per (team, KEY) on the Server. The data layer below only handles
// metadata: holder, Skills in scope, exclusions and usage counts.

export type TeamKeyVaultState = {
  /** Account the data belongs to; responses for another account are dropped. */
  accountUserId: string | null
  teamId: string | null
  status: KeyVaultStatus
  teamName: string
  isTeamOwner: boolean
  keys: TeamKey[]
  error: string | null
}

export const EMPTY_TEAM_KEY_VAULT_STATE: TeamKeyVaultState = {
  accountUserId: null,
  teamId: null,
  status: 'idle',
  teamName: '',
  isTeamOwner: false,
  keys: [],
  error: null,
}

export type TeamKeyReader = {
  listTeamKeys: (teamId: string) => Promise<TeamKeyList>
}

export async function loadTeamKeys(accountUserId: string, teamId: string, reader: TeamKeyReader): Promise<TeamKeyVaultState> {
  try {
    const list = await reader.listTeamKeys(teamId)
    return {
      accountUserId,
      teamId,
      status: 'ready',
      teamName: list.teamName,
      isTeamOwner: list.isTeamOwner,
      keys: [...list.credentials].sort((left, right) => left.key.localeCompare(right.key)),
      error: null,
    }
  } catch (error: unknown) {
    return {
      ...EMPTY_TEAM_KEY_VAULT_STATE,
      accountUserId,
      teamId,
      status: 'error',
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/** Applied only while both the account and the selected team are unchanged. */
export function acceptsTeamKeyResponse(currentAccountUserId: string | null, currentTeamId: string | null, response: TeamKeyVaultState): boolean {
  return response.accountUserId === currentAccountUserId && response.teamId === currentTeamId
}

function isoToMs(value: string | null): number | null {
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

/** Personal vault keys that this team does not hold yet: 「放进团队」 choices. */
export function personalKeysToShare(personal: VaultKey[], team: TeamKey[]): string[] {
  const held = new Set(team.map((key) => key.key))
  return vaultKeyNames(personal).filter((key) => !held.has(key)).sort((left, right) => left.localeCompare(right))
}

/**
 * 团队 「换新值」 (#320) takes the new value from the account vault's key of
 * the same name, so the confirm button needs a vault value for it.
 */
export function canReplaceFromVault(personal: VaultKey[], key: string): boolean {
  return personal.some((entry) => entry.key === key)
}

export function usageRowText(row: TeamKeyUsageRow, now: number = Date.now()): string {
  const actor = row.actor?.displayName ?? '已注销账号'
  const skill = row.skill?.name ?? '已删除的 Skill'
  return `${actor} 通过「${skill}」使用 ${row.count} 次 · ${formatLastUsed(isoToMs(row.lastAt), now).replace('使用', '')}`.trim()
}

// ── 「钥匙」页（#262 → #294：卡片、逐个 Skill 启用、共享弹窗） ─────────────

export type KeyScope = 'personal' | 'team'

export type KeyTab = { scope: KeyScope; label: string; icon: 'user-round' | 'users-round' }

export const KEY_TABS: readonly KeyTab[] = [
  { scope: 'personal', label: '个人', icon: 'user-round' },
  { scope: 'team', label: '团队', icon: 'users-round' },
]

// Same sentence as EMPTY_COPY.keysNone in state-copy.ts (kept literal so this module stays import-free for tests).
export const KEYS_EMPTY_COPY = '还没有钥匙。安装需要钥匙的 Skill 后，在它的详情里填写，这里就会出现。'

export const KEYS_PAGE_COPY = {
  title: '钥匙',
  personalSubtitle: '个人钥匙以明文保存在这台电脑上，不会自动上传',
  teamSubtitle: '团队钥匙加密保存在一探 SkillHub，团队成员运行 Skill 时会用到',
  tabsLabel: '钥匙归属',
  noPurpose: '未填写用途',
  skillsTitle: '可以用这把钥匙的 Skill',
  teamSkillsTitle: '团队里可以用这把钥匙的 Skill',
  skillsHint: '点击卡片启用或停用',
  noSkills: '还没有 Skill 声明这把钥匙',
  enabled: '已启用',
  disabled: '未启用',
  overrideSub: '使用不同的值',
  share: '共享',
  moreLabel: '更多操作：更换、关联变量名、撤销',
  replace: '更换',
  linkNames: '关联变量名',
  revoke: '撤销',
  // #306 带标签的钥匙
  defaultTag: '默认',
  setDefault: '设为默认',
  addVariant: '添加另一把（带标签）',
  renameLabel: '重命名标签',
  convertToVariant: '转成一把带标签的钥匙',
  variantLabelField: '标签',
  variantLabelPlaceholder: '例如 公司、个人、测试',
  variantLabelEmpty: '请输入标签',
  variantValueField: '钥匙的值',
  variantAddTitle: '添加另一把',
  variantAddHint: '同一个变量名的另一个值，用标签区分。Skill 默认仍用「默认」那一把，可以在 Skill 详情里改用这一把。',
  variantRenameTitle: '重命名标签',
  variantConvertTitle: '转成一把带标签的钥匙',
  variantConvertHint: '这个 Skill 自己保存的值会变成一把带标签的钥匙，它会继续使用这个值；其他 Skill 也可以改用它。',
  variantFallbackLabel: '另一把',
  unlabelled: '不带标签的那一把',
  aliasesOnDefault: '变量名属于整个名字，在不带标签的那张卡片上修改',
  shareWhich: '共享哪一把',

  teamSignedOut: '登录后可以查看团队钥匙',
  teamNoTeams: '还没有团队。创建或加入团队后，可以把钥匙放进团队，团队成员装上 Skill 就能直接用。',
  teamEmpty: '团队还没有钥匙。把你的钥匙放进团队后，团队成员不用再各自填写。',
  teamAnyMember: '团队里任何成员都可以放钥匙',
  putMine: '放进我的钥匙',
  putMineEmpty: '「个人」里的钥匙都已在这个团队中',
  usageTitle: '最近 30 天谁用过',
  usageHint: '只有放钥匙的人和团队负责人能看到',
  usageNone: '最近 30 天没有人用过',
  teamReadOnlyHint: '只有放钥匙的人和团队负责人可以启用或停用',
  // #320 团队钥匙「换新值」与「撤销」的说明
  teamReplace: '换新值',
  teamReplaceHint: '换新值后，团队里用到它的 Skill 下次运行就会改用新值，旧值不再使用。',
  teamReplaceSource: '新值取自你「个人」里的同名钥匙，请先确认那里已经是新值。',
  teamReplaceNeedsMine: '你的「个人」里还没有这把钥匙。先在「个人」里填写新值，再回来替换。',
  teamReplaceFromMine: '用我的个人钥匙替换',
  teamReplaceHolder: '替换后，你会成为放这把钥匙的人。',
  teamRevokeHint: '撤销后，团队成员不再拿到这把钥匙；没有自己同名钥匙的成员再运行用到它的 Skill 会提示缺少钥匙，需要自己填写或改选其他来源。你自己的个人钥匙不受影响。',
} as const

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** 「最近使用」的相对时间；无效或缺失时间显示「从未使用」。接受 ISO 字符串或毫秒。 */
export function formatKeyLastUsed(lastUsedAt: string | number | null | undefined, now: number = Date.now()): string {
  if (lastUsedAt === null || lastUsedAt === undefined || lastUsedAt === '' || lastUsedAt === 0) return '从未使用'
  const time = typeof lastUsedAt === 'number' ? lastUsedAt : new Date(lastUsedAt).getTime()
  if (Number.isNaN(time)) return '从未使用'
  const elapsed = Math.max(0, now - time)
  if (elapsed < MINUTE) return '刚刚'
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)} 分钟前`
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)} 小时前`
  if (elapsed < 30 * DAY) return `${Math.floor(elapsed / DAY)} 天前`
  return new Date(time).toLocaleDateString('zh-CN')
}

/** `N 个 Skill 会用到，M 个启用`，有逐个 Skill 的不同值时追加 `· K 个 Skill 使用不同的值`。 */
export function keyUsageSummary(total: number, enabled: number, overrides = 0): string {
  const base = `${total} 个 Skill 会用到，${enabled} 个启用`
  return overrides > 0 ? `${base} · ${overrides} 个 Skill 使用不同的值` : base
}

/** Two-letter avatar initials: `zsir-imagegen` → `ZI`, `生图` → `生图`. */
export function skillInitials(name: string): string {
  const words = name.trim().split(/[\s_\-.]+/).filter(Boolean)
  if (words.length === 0) return '?'
  const letters = words.length > 1 ? `${[...words[0]!][0] ?? ''}${[...words[1]!][0] ?? ''}` : [...words[0]!].slice(0, 2).join('')
  return letters.toUpperCase()
}

export type KeySkillChip = {
  id: string
  name: string
  /** 「以 FAL_API_KEY 注入」 / 「使用不同的值」 / declared purpose / empty. */
  sub: string
  enabled: boolean
  /** The Skill keeps its own value for this key (the per-Skill override). */
  override: boolean
}

type VaultSkillLike = VaultKey['usedBySkills'][number] & { requiresConsent?: boolean; enabled?: boolean }

/**
 * Enabled = not turned off for this Skill ∧ (it never asks ∨ the key or
 * account auto-allows ∨ it is allowed). The native listing computes it
 * (`enabled`); this fallback reads the same fields for an older listing.
 */
export function vaultSkillEnabled(key: VaultKey, skill: VaultSkillLike, accountAutoAllow = false): boolean {
  if (typeof skill.enabled === 'boolean') return skill.enabled
  if ((key.blockedSkills ?? []).includes(skill.id)) return false
  if (skill.requiresConsent === false) return true
  return accountAutoAllow || key.autoAllow || key.allowedSkills.includes(skill.id)
}

/** One chip per Skill (a Skill declaring both the key and an alias appears once). */
export function vaultSkillChips(key: VaultKey, accountAutoAllow = false): KeySkillChip[] {
  const chips = new Map<string, KeySkillChip>()
  for (const skill of key.usedBySkills as VaultSkillLike[]) {
    if (chips.has(skill.id)) continue
    const override = key.overrideSkills.includes(skill.id)
    chips.set(skill.id, {
      id: skill.id,
      name: skill.name,
      sub: override ? KEYS_PAGE_COPY.overrideSub : injectedAsNote(skill.declaredKey, key.key) ?? skill.declaredDescription?.trim() ?? '',
      enabled: vaultSkillEnabled(key, skill, accountAutoAllow),
      override,
    })
  }
  return [...chips.values()]
}

export type PersonalKeyCardView = {
  key: string
  /** #306: `null` = the unlabelled value. */
  variant: string | null
  /** #306: 「公司」 on a labelled card. */
  label: string | null
  /** #306: carries the 「默认」 tag when the name has several values. */
  isDefault: boolean
  /** #306: the name has labelled variants (cards are grouped, 默认 shows). */
  grouped: boolean
  /** #306: aliases are edited on the unlabelled card only. */
  aliasesEditable: boolean
  aliases: string[]
  purpose: string
  lastUsed: string
  summary: string
  chips: KeySkillChip[]
}

export function personalKeyCardView(key: VaultKey, accountAutoAllow = false, now: number = Date.now()): PersonalKeyCardView {
  const chips = vaultSkillChips(key, accountAutoAllow)
  const purpose = key.usedBySkills.map((skill) => skill.declaredDescription?.trim()).find((value): value is string => Boolean(value))
  const variant = variantOf(key)
  return {
    key: key.key,
    variant,
    label: variant === null ? null : key.label ?? null,
    isDefault: isDefaultVariant(key),
    grouped: hasVariants(key),
    aliasesEditable: ownsNameSettings(key),
    aliases: aliasesOf(key),
    purpose: purpose ?? KEYS_PAGE_COPY.noPurpose,
    lastUsed: formatKeyLastUsed(key.lastUsedAt, now),
    summary: keyUsageSummary(chips.length, chips.filter((chip) => chip.enabled).length, key.overrideSkills.length),
    chips,
  }
}

/** Team chips: Skills in scope are enabled, excluded ones are not. */
export function teamSkillChips(key: TeamKey): KeySkillChip[] {
  const chips = new Map<string, KeySkillChip>()
  for (const skill of key.inScopeSkills) {
    if (!chips.has(skill.id)) chips.set(skill.id, { id: skill.id, name: skill.name, sub: injectedAsNote(skill.declaredKey, key.key) ?? '', enabled: true, override: false })
  }
  for (const exclusion of key.exclusions) {
    if (!chips.has(exclusion.skillId)) chips.set(exclusion.skillId, { id: exclusion.skillId, name: exclusion.name, sub: '', enabled: false, override: false })
  }
  return [...chips.values()]
}

export type TeamKeyCardView = {
  key: string
  aliases: string[]
  holder: string
  holderId: string
  revision: string
  lastUsed: string
  summary: string
  chips: KeySkillChip[]
  canManage: boolean
}

export function teamKeyCardView(key: TeamKey, now: number = Date.now()): TeamKeyCardView {
  const chips = teamSkillChips(key)
  return {
    key: key.key,
    aliases: aliasesOf(key),
    holder: key.holder.displayName,
    holderId: key.holder.id,
    revision: `第 ${key.revision} 版`,
    lastUsed: formatKeyLastUsed(key.lastUsedAt, now),
    summary: keyUsageSummary(chips.length, chips.filter((chip) => chip.enabled).length),
    chips,
    canManage: key.canManage,
  }
}

export type UsageRowView = { actor: string; skill: string; count: string; when: string }

export function usageRowView(row: TeamKeyUsageRow, now: number = Date.now()): UsageRowView {
  return {
    actor: row.actor?.displayName ?? '已注销账号',
    skill: `通过「${row.skill?.name ?? '已删除的 Skill'}」`,
    count: `${row.count} 次`,
    when: formatKeyLastUsed(row.lastAt, now),
  }
}

/** 「N 位成员 · 团队里任何成员都可以放钥匙」. */
export function teamMembersLine(memberCount: number): string {
  return `${memberCount} 位成员 · ${KEYS_PAGE_COPY.teamAnyMember}`
}

// ── 关联变量名 ──

export const ALIAS_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,99}$/

/** Client-side check before `set_vault_key_aliases`; the native side has the final say (clashes). */
export function validateAliasName(name: string, mainKey: string, aliases: readonly string[]): string | null {
  if (!name) return '请输入变量名'
  if (!ALIAS_NAME_PATTERN.test(name)) return '变量名以大写字母开头，只能包含大写字母、数字和下划线'
  if (name === mainKey) return `${name} 就是这把钥匙的主名`
  if (aliases.includes(name)) return `${name} 已经关联过了`
  return null
}

// ── 共享弹窗 ──

/** Mirrors `TEAM_KEYS_UNAVAILABLE` in `team_keys.rs`: the Server answered a team-key route with a route-miss 404. */
export const TEAM_KEYS_UNAVAILABLE = '当前 SkillHub 服务器还没有团队钥匙功能，请等服务器更新后再试'

export function isTeamKeysUnavailable(message: string | null | undefined): boolean {
  return message === TEAM_KEYS_UNAVAILABLE
}

/** Per-team failures as 「团队：原因」, except 「服务器还没有团队钥匙」 shows once, as-is. */
export function shareFailureLines(failed: readonly { team: string; error: string }[]): string[] {
  const unavailable = failed.some((failure) => isTeamKeysUnavailable(failure.error))
  const others = failed.filter((failure) => !isTeamKeysUnavailable(failure.error)).map((failure) => `${failure.team}：${failure.error}`)
  return unavailable ? [TEAM_KEYS_UNAVAILABLE, ...others] : others
}

/** The names a team key answers to: main name first, then its aliases. */
export function keyNames(key: { key: string; aliases?: readonly string[] | null }): string[] {
  return [key.key, ...aliasesOf(key).filter((alias) => alias !== key.key)]
}

/** 「FAL_KEY」 / 「FAL_KEY 或 FAL_API_KEY」 / 「A、B 或 C」. */
export function joinKeyNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join('、')} 或 ${names[names.length - 1]}`
}

/** The middle line of the share dialog, split so the key name can render as <code>. */
export function shareDialogUsage(names: readonly string[]): { before: string; key: string; after: string } {
  return {
    before: '团队成员运行用到 ',
    key: names[0] ?? '',
    after: `${names.length > 1 ? '（或别名）' : ' '}的 Skill 时会自动带上它；界面里看不到原文，但 Skill 运行时能读到。`,
  }
}

/** Three short lines: where it is stored, when it is used, whom to share with. */
export function shareDialogBody(names: readonly string[]): string[] {
  const usage = shareDialogUsage(names)
  return [SHARE_DIALOG_COPY.stored, `${usage.before}${usage.key}${usage.after}`, SHARE_DIALOG_COPY.trust]
}

export const SHARE_DIALOG_COPY = {
  stored: '钥匙会加密保存到一探 SkillHub。',
  trust: '请只共享给信任的人。',
  teamsLegend: '选择团队',
  footer: '共享后可以在「钥匙 · 团队」里逐个停用 Skill，并查看谁用过。成员退出团队后立即失去使用权。',
  mine: '已共享 · 你是持有人',
  stopSharing: '停止共享',
  cancel: '取消',
  noTeams: '你还没有加入团队。创建或加入团队后再来共享。',
  chooserTitle: '共享哪一把钥匙？',
  chooserHint: '这个 Skill 用到了好几把钥匙，选一把共享给团队。',
} as const

/** 「共享哪一把」 radios (#306): 默认 first, then the other values by label. */
export function shareVariantOptions(key: Pick<VaultKey, 'variants'>): { id: string | null; text: string; isDefault: boolean }[] {
  const choices = variantChoices(key)
  const ordered = [...choices.filter((choice) => choice.isDefault), ...choices.filter((choice) => !choice.isDefault)]
  return ordered.map((choice) => ({
    id: choice.id,
    isDefault: choice.isDefault,
    text: choice.isDefault
      ? choice.label ? `${KEYS_PAGE_COPY.defaultTag}（${choice.label}）` : KEYS_PAGE_COPY.defaultTag
      : choice.label ?? KEYS_PAGE_COPY.unlabelled,
  }))
}

export function shareButtonLabel(count: number): string {
  return `共享到 ${count} 个团队`
}

type TeamSkillLike = { envDependencies?: readonly { key: string }[] | null }

/** 「团队里有 M 个 Skill 会用到」: team Skills declaring the key or any of its aliases. */
export function teamSkillCountForKey(skills: readonly TeamSkillLike[], names: readonly string[]): number {
  const wanted = new Set(names)
  return skills.filter((skill) => (skill.envDependencies ?? []).some((dependency) => wanted.has(dependency.key))).length
}

export function shareTeamLine(memberCount: number, skillCount: number | null): string {
  return skillCount === null ? `${memberCount} 人` : `${memberCount} 人 · 团队里有 ${skillCount} 个 Skill 会用到`
}

export type ShareTeamState =
  /** The team has no key of this name: selectable. */
  | { kind: 'available' }
  /** You hold it there: 「已共享 · 你是持有人」 + 停止共享. */
  | { kind: 'mine' }
  /** Someone else's key of the same name; replaceable only by the team owner. */
  | { kind: 'other'; holder: string; canManage: boolean }

export function shareTeamState(teamKeys: readonly TeamKey[] | null, key: string, accountUserId: string | null): ShareTeamState {
  const held = teamKeys?.find((entry) => entry.key === key)
  if (!held) return { kind: 'available' }
  if (accountUserId && held.holder.id === accountUserId) return { kind: 'mine' }
  return { kind: 'other', holder: held.holder.displayName, canManage: held.canManage }
}

/** Personal vault keys a Skill can share: the key or one of its aliases is declared by the Skill. */
export function shareCandidates(vault: readonly VaultKey[], declaredKeys: readonly string[]): string[] {
  const declared = new Set(declaredKeys)
  return vaultKeyNames(vault.filter((key) => keyNames(key).some((name) => declared.has(name))))
}

/** Sequential share results → one toast line. */
export function shareResultMessage(key: string, succeeded: readonly string[], failed: readonly { team: string; error: string }[]): string {
  const parts: string[] = []
  if (succeeded.length > 0) parts.push(`${key} 已共享到 ${succeeded.join('、')}`)
  for (const failure of failed) parts.push(`${failure.team}：${failure.error}`)
  return parts.join('；')
}
