import type {
  KeyConsentRequest,
  SkillEnvSource,
  SkillEnvSourceOption,
  SkillEnvSourcePolicyRow,
} from './tauri.js'

/**
 * 「需要的钥匙」 (#255): the pure model behind the Skill detail section, the
 * list badges and the first-install guide. It reads only key names, states and
 * team names from the resolved policy; no function here ever sees a value.
 */

export const KEYS_SECTION_TITLE = '需要的钥匙'

export const KEY_COPY = {
  personal: '你的钥匙',
  personalOverride: '你的钥匙（仅此 Skill）',
  // #306 同名多把钥匙
  personalDefault: '你的钥匙（默认）',
  personalVariant: (label: string): string => `你的钥匙 · ${label}`,
  variantFallbackLabel: '另一把',
  unlabelledVariant: '不带标签的那一把',
  saveAsVariant: '存为带标签的新钥匙',
  saveAsVariantHint: '钥匙库里已经有这个变量名的默认值。存为带标签的新钥匙后，这个 Skill 用它，其他 Skill 继续用默认的那一把。',
  variantLabel: '标签',
  variantLabelPlaceholder: '例如 公司、个人、测试',
  variantSavedToast: (name: string, label: string): string => `已存为 ${name} · ${label}，这个 Skill 现在使用它`,
  needsChoice: '需要选择用哪把钥匙',
  using: '正在使用',
  fillHint: '保存到你的钥匙库，所有需要它的 Skill 都能用',
  fillVault: '保存到钥匙库',
  replaceHint: '新的值会替换钥匙库里的旧值，所有使用它的 Skill 都会用新的；单个 Skill 自己保存的值不受影响',
  skillOnly: '仅此 Skill',
  runtimeRequest: 'Agent 运行时发现需要',
  shareKeysToTeam: '共享钥匙给团队',
  // Skill 详情 · 钥匙 (#289 board 2)
  sectionSubtitle: '值保存在这台电脑的钥匙库里，界面不显示原文，也不会写进 Skill 包。',
  shareToTeam: '共享给团队',
  explainerTitle: '什么是钥匙？',
  explainerDismiss: '不再显示',
  explainerWhatTitle: '是什么',
  explainerWhat: '有些 Skill 需要外部服务（如 fal.ai 作图），要用到 API Key，才能正常使用。',
  explainerWhereTitle: '存在哪',
  explainerWhere: '明文存在你的电脑，不上传。共享给团队时会加密传到 SkillHub 服务器。一探 SkillHub 只在团队成员运行 Skill 时解密发给他，不会拿你的钥匙做别的事。',
  explainerHowTitle: '怎么用',
  explainerHow: '填一次，所有需要它的 Skill 都能用。Agent 运行 Skill 时自动带上。',
  declarationsTitle: '钥匙声明',
  declarationsSubtitle: '作者可见，决定这个 Skill 需要哪些钥匙',
  writeBack: '写回 SKILL.md',
  writeBackDone: '已写回 SKILL.md',
  awaitingConsent: '等待授权',
  ready: '可用',
  needsValue: '需要填写',
  choose: '需要选择',
  guideReady: '已就绪',
  // 「变量名不一致」（#288）：钥匙库里已有同一家服务的钥匙，只是名字不同。
  aliasSuggestionTitle: (service: string): string => `你已有一把 ${service} 钥匙：`,
  aliasSuggestionMiddle: '。它们是同一家服务的 Key，只是变量名不同。用它的话，运行这个 Skill 时会以 ',
  aliasSuggestionTail: ' 的名字注入，值不需要再填一遍。',
  aliasSuggestionBody: (key: string): string => `。它们是同一家服务的 Key，只是变量名不同。用它的话，运行这个 Skill 时会以 ${key} 的名字注入，值不需要再填一遍。`,
  aliasUseButton: (existingKey: string): string => `用 ${existingKey}`,
  aliasFillNew: '填写新的值',
  aliasLinking: '关联中…',
  aliasLinkedToast: (key: string, existingKey: string): string => `已关联：${key} 现在也使用你的 ${existingKey}`,
} as const

/** One piece of the alias prompt; `code` pieces render as mono tags. */
export type AliasSuggestionSegment = { text: string; code?: true }

/**
 * 「你已有一把 fal.ai 钥匙：FAL_KEY。它们是同一家服务的 Key，只是变量名不同。用它的话，
 * 运行这个 Skill 时会以 FAL_API_KEY 的名字注入，值不需要再填一遍。」
 */
export function aliasSuggestionSegments(service: string, existingKey: string, key: string): AliasSuggestionSegment[] {
  return [
    { text: KEY_COPY.aliasSuggestionTitle(service) },
    { text: existingKey, code: true },
    { text: KEY_COPY.aliasSuggestionMiddle },
    { text: key, code: true },
    { text: KEY_COPY.aliasSuggestionTail },
  ]
}

export function aliasSuggestionText(service: string, existingKey: string, key: string): string {
  return aliasSuggestionSegments(service, existingKey, key).map((segment) => segment.text).join('')
}

export function teamKeyLabel(teamName: string): string {
  return `${teamName} 团队的钥匙`
}

export function needsValueLabel(count: number): string {
  return `需要填写 ${count} 把钥匙`
}

export type KeyRowState = 'ready' | 'needs_value' | 'needs_choice'
/** What one row shows: a resolved state, or the consent / read status around it. */
export type KeyRowStatus = KeyRowState | 'needs_consent' | 'loading' | 'error'

type PolicyLike = Pick<SkillEnvSourcePolicyRow, 'valid' | 'options'> & Partial<Pick<SkillEnvSourcePolicyRow, 'state' | 'needsConsent' | 'selected' | 'effective' | 'personalSource' | 'personalVariants' | 'selectedVariant'>>

/** The native `state` wins; an older native layer without it is derived the same way. */
export function keyRowState(row: PolicyLike): KeyRowState {
  if (row.state) return row.state
  if (row.valid) return 'ready'
  return row.options.some((option) => option.available) ? 'needs_choice' : 'needs_value'
}

export function keyRowStatus(row: PolicyLike | undefined, loading: boolean, failed: boolean): KeyRowStatus {
  if (loading) return 'loading'
  if (failed) return 'error'
  if (!row) return 'needs_value'
  const state = keyRowState(row)
  return state === 'ready' && row.needsConsent ? 'needs_consent' : state
}

export function sourceKey(source: SkillEnvSource | SkillEnvSourceOption | null | undefined): string {
  if (!source) return ''
  if (source.kind === 'team') return `team:${source.teamId}`
  return source.kind === 'personalVariant' ? `personal:${source.variant ?? UNLABELLED_ID}` : 'personal'
}

/** Switcher id fragment of the unlabelled personal value (#306). */
const UNLABELLED_ID = 'unlabelled'

export function sourceFromOption(option: SkillEnvSourceOption): SkillEnvSource {
  // Options are personal or team; a labelled variant is offered by keySourceChoices (#306).
  return option.kind === 'team' ? { kind: 'team', teamId: option.teamId } : { kind: 'personal' }
}

export function sourceOptionLabel(option: SkillEnvSourceOption, personalSource?: SkillEnvSourcePolicyRow['personalSource']): string {
  if (option.kind === 'team') return teamKeyLabel(option.teamName || '团队')
  return personalSource === 'override' ? KEY_COPY.personalOverride : KEY_COPY.personal
}

/** Candidates a choice list offers: every usable source, once. */
export function keyChoices(row: PolicyLike): SkillEnvSourceOption[] {
  const seen = new Set<string>()
  return row.options.filter((option) => {
    const id = sourceKey(option)
    if (!option.available || seen.has(id)) return false
    seen.add(id)
    return true
  })
}

/** The labelled personal variants a Skill can pick (#306); the unlabelled entry is never listed. */
function labelledPersonalVariants(row: PolicyLike): { id: string; label: string | null; isDefault: boolean }[] {
  // The native list also holds the unlabelled value (`id: null`); only labelled ones can be picked by id.
  return (row.personalVariants ?? []).filter((entry): entry is { id: string; label: string | null; isDefault: boolean } => typeof entry.id === 'string' && entry.id.length > 0)
}

/**
 * The personal variant a run uses (#306): an explicit `personalVariant`
 * choice, else the native `selectedVariant`. Returns its label, or null for
 * the unlabelled value / a team source / this Skill's own value.
 */
export function personalVariantInUse(row: PolicyLike): string | null {
  if (row.personalSource === 'override') return null
  const effective = row.effective ?? row.selected ?? null
  if (effective?.kind === 'team') return null
  // Explicitly the unlabelled value: worth naming only when the default is a labelled one.
  if (effective?.kind === 'personalVariant' && effective.variant === null) {
    return unlabelledIsDefault(row) ? null : KEY_COPY.unlabelledVariant
  }
  const id = effective?.kind === 'personalVariant' ? effective.variant : row.selectedVariant ?? null
  if (!id) return null
  return labelledPersonalVariants(row).find((entry) => entry.id === id)?.label ?? (effective?.kind === 'personalVariant' ? KEY_COPY.variantFallbackLabel : null)
}

/** The unlabelled personal value exists and is not the default (the pointer sits on a labelled one). */
function unlabelledIsDefault(row: PolicyLike): boolean {
  return (row.personalVariants ?? []).find((entry) => entry.id === null || entry.id === '')?.isDefault ?? true
}

function hasNonDefaultUnlabelled(row: PolicyLike): boolean {
  return (row.personalVariants ?? []).some((entry) => (entry.id === null || entry.id === '') && !entry.isDefault)
}

/** One entry of the 「正在使用」 switcher: a team, the personal default, or a labelled personal variant (#306). */
export type KeySourceChoice = { id: string; label: string; source: SkillEnvSource }

/**
 * The switcher list: 你的钥匙（默认）, then 你的钥匙 · 公司 … (non-default
 * labelled variants), then each usable team. A personal key never needs a
 * choice: the default is always there.
 */
export function keySourceChoices(row: PolicyLike): KeySourceChoice[] {
  const choices: KeySourceChoice[] = []
  for (const option of keyChoices(row)) {
    if (option.kind === 'team') {
      choices.push({ id: sourceKey(option), label: sourceOptionLabel(option), source: sourceFromOption(option) })
      continue
    }
    const variants = row.personalSource === 'override' ? [] : labelledPersonalVariants(row)
    const personalLabel = row.personalSource === 'override' ? KEY_COPY.personalOverride : variants.length > 0 ? KEY_COPY.personalDefault : KEY_COPY.personal
    choices.push({ id: 'personal', label: personalLabel, source: { kind: 'personal' } })
    // The default sits on a labelled value: the unlabelled one is offered explicitly.
    if (row.personalSource !== 'override' && hasNonDefaultUnlabelled(row)) {
      choices.push({ id: `personal:${UNLABELLED_ID}`, label: KEY_COPY.personalVariant(KEY_COPY.unlabelledVariant), source: { kind: 'personalVariant', variant: null } })
    }
    for (const variant of variants) {
      if (variant.isDefault) continue
      choices.push({ id: `personal:${variant.id}`, label: KEY_COPY.personalVariant(variant.label ?? KEY_COPY.variantFallbackLabel), source: { kind: 'personalVariant', variant: variant.id } })
    }
  }
  return choices
}

/** The switcher entry that is checked now (`''` when nothing resolves). */
export function currentSourceChoiceId(row: PolicyLike): string {
  const choices = keySourceChoices(row)
  const effective = row.effective ?? row.selected ?? null
  if (!effective) return ''
  if (effective.kind === 'team') return sourceKey(effective)
  const id = effective.kind === 'personalVariant' ? effective.variant ?? UNLABELLED_ID : row.selectedVariant ?? null
  const variantId = id ? `personal:${id}` : null
  return variantId && choices.some((choice) => choice.id === variantId) ? variantId : 'personal'
}

/** 「使用：你的钥匙」 / 「使用：你的钥匙 · 公司」 / 「使用：XX 团队的钥匙」 for a ready row. */
export function usingLabel(row: PolicyLike): string | null {
  const effective = row.effective ?? row.selected ?? null
  const option = effective
    ? row.options.find((candidate) => sourceKey(candidate) === (effective.kind === 'personalVariant' ? 'personal' : sourceKey(effective)))
    : keyChoices(row)[0]
  if (!option) return null
  const variant = option.kind === 'personal' ? personalVariantInUse(row) : null
  return `使用：${variant ? KEY_COPY.personalVariant(variant) : sourceOptionLabel(option, row.personalSource)}`
}

/** Ready rows can be switched only when there is something to switch to. */
export function canSwitchSource(row: PolicyLike): boolean {
  return keySourceChoices(row).length > 1 || row.personalSource === 'override'
}

/** `obtain` links open in the system browser and must be https. */
export function safeObtainUrl(raw: string | undefined | null): string | null {
  if (!raw) return null
  try {
    const url = new URL(raw.trim())
    return url.protocol === 'https:' && url.hostname ? url.toString() : null
  } catch {
    return null
  }
}

// ── Who sees what ──

export type KeyViewerRole = 'author' | 'member' | 'guest' | 'signed_out'

export function keyViewerRole(input: { canManage: boolean; signedIn: boolean; teamSkill: boolean }): KeyViewerRole {
  if (input.canManage) return 'author'
  if (!input.signedIn) return 'signed_out'
  return input.teamSkill ? 'member' : 'guest'
}

export type KeyDependencyLike = { key: string; origin?: string; pending?: boolean; obtain?: string; description?: string }

export type KeyRowElements = {
  primary: 'fill' | 'choose' | 'consent' | null
  /** Grey 「使用：…」 text for a ready row. */
  using: string | null
  /** The 「使用：…」 text opens the choice list. */
  switchable: boolean
  runtimeTag: boolean
  confirmPending: boolean
  obtainUrl: string | null
}

export function keyRowElements(input: {
  role: KeyViewerRole
  status: KeyRowStatus
  row?: PolicyLike
  dependency: KeyDependencyLike
  installed: boolean
}): KeyRowElements {
  const { role, status, row, dependency, installed } = input
  const ready = status === 'ready' || status === 'needs_consent'
  const primary = !installed ? null
    : status === 'needs_value' ? 'fill'
      : status === 'needs_choice' ? 'choose'
        : status === 'needs_consent' ? 'consent'
          : null
  return {
    primary,
    using: ready && row ? usingLabel(row) : null,
    switchable: installed && status === 'ready' && Boolean(row && canSwitchSource(row)),
    runtimeTag: dependency.origin === 'runtime_request',
    confirmPending: role === 'author' && installed && dependency.origin === 'runtime_request' && dependency.pending === true,
    obtainUrl: safeObtainUrl(dependency.obtain),
  }
}

export type KeySectionElements = {
  /** 「钥匙声明」 disclosure: 手动添加 / 重新检测 / 写回 SKILL.md / 删除声明. */
  authorTools: boolean
  /** 「共享给团队」 button: opens the 钥匙 page on 团队 (#289; #294 adds the dialog). */
  shareHint: boolean
}

export function keySectionElements(role: KeyViewerRole, accountSyncRequired = false): KeySectionElements {
  return {
    authorTools: role === 'author',
    shareHint: role === 'author' && !accountSyncRequired,
  }
}

// ── 「什么是钥匙？」 explainer (#289) ──

export const KEYS_EXPLAINER_STORAGE_KEY = 'yitan-skillhub.keys-explainer-dismissed.v1'

export function readKeysExplainerDismissed(storage: GuideStorage | null = guideStorage()): boolean {
  try {
    return storage?.getItem(KEYS_EXPLAINER_STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

/** 「不再显示」: remembered on this computer; blocked storage only hides it for now. */
export function dismissKeysExplainer(storage: GuideStorage | null = guideStorage()): void {
  try {
    storage?.setItem(KEYS_EXPLAINER_STORAGE_KEY, '1')
  } catch {
    // Storage blocked: the card comes back next time, which is harmless.
  }
}

// ── First-install guide ──

export type KeyGuideSource = 'marketplace' | 'team' | 'local'

export const KEY_GUIDE_STORAGE_KEY = 'skillhub.keyInstallGuide.shown.v1'
export const KEY_GUIDE_EVENT = 'skillhub:key-install-guide'

export type KeyGuideRequest = { skillId: string }

type GuideStorage = Pick<Storage, 'getItem' | 'setItem'>

function guideStorage(): GuideStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

export function readShownKeyGuides(storage: GuideStorage | null = guideStorage()): Set<string> {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(KEY_GUIDE_STORAGE_KEY) ?? '[]')
    return new Set(Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [])
  } catch {
    return new Set()
  }
}

/** Remembered per Skill so closing the guide never brings it back automatically. */
export function rememberKeyGuideShown(skillId: string, storage: GuideStorage | null = guideStorage()): void {
  const shown = readShownKeyGuides(storage)
  if (shown.has(skillId)) return
  shown.add(skillId)
  try {
    storage?.setItem(KEY_GUIDE_STORAGE_KEY, JSON.stringify([...shown].slice(-500)))
  } catch {
    // Storage blocked: the guide may show again next time, which is harmless.
  }
}

/**
 * Only a completed Marketplace or team acquisition that declares at least one
 * key opens the guide, once per Skill. Local imports get the pre-publish
 * checklist instead; failed installs never reach this.
 */
export function shouldOpenKeyGuide(input: {
  source: KeyGuideSource
  succeeded: boolean
  declaredKeys: number
  alreadyShown: boolean
}): boolean {
  return input.succeeded
    && input.source !== 'local'
    && input.declaredKeys > 0
    && !input.alreadyShown
}

export function keyGuideSourceOf(skill: { acquisitionSource?: string }): KeyGuideSource {
  return skill.acquisitionSource === 'marketplace' || skill.acquisitionSource === 'team' ? skill.acquisitionSource : 'local'
}

/** Called after a successful install; dispatches the guide only when it should open. */
export function offerKeyInstallGuide(
  skill: { id: string; acquisitionSource?: string; envDeps: readonly unknown[] },
  storage: GuideStorage | null = guideStorage(),
): boolean {
  const open = shouldOpenKeyGuide({
    source: keyGuideSourceOf(skill),
    succeeded: true,
    declaredKeys: skill.envDeps.length,
    alreadyShown: readShownKeyGuides(storage).has(skill.id),
  })
  if (open && typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent<KeyGuideRequest>(KEY_GUIDE_EVENT, { detail: { skillId: skill.id } }))
  }
  return open
}

export function keyGuideSummary(statuses: readonly KeyRowStatus[]): { allReady: boolean; pending: number; title: string } {
  const pending = statuses.filter((status) => status !== 'ready').length
  const allReady = statuses.length > 0 && pending === 0
  return { allReady, pending, title: allReady ? KEY_COPY.guideReady : `还有 ${pending} 把钥匙要处理` }
}

// ── Consent ──

export const KEY_CONSENT_OPEN_EVENT = 'skillhub:key-consent-open'

/** Opens the first-use consent dialog for this Skill's keys from the detail row. */
export function openKeyConsent(request: KeyConsentRequest): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent<KeyConsentRequest>(KEY_CONSENT_OPEN_EVENT, { detail: request }))
}

// Pending runtime requests are confirmed through `confirmPendingKey` in env-declaration.ts (#284).
