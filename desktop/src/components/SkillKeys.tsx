import { useCallback, useEffect, useRef, useState } from 'react'
import { openUrl } from '@tauri-apps/plugin-opener'
import { useStore, type EnvDep, type LocalSkill } from '../store/index.js'
import { Icon, type IconName } from './Icon.js'
import { Tooltip } from './Tooltip.js'
import { toast } from './Toast.js'
import {
  createVaultKeyVariant,
  deleteSkillEnv,
  getKeyVaultSettings,
  getLocalSkill,
  getSkillEnvSourcePolicy,
  listVaultKeys,
  setSkillEnv,
  setSkillEnvSource,
  setVaultKey,
  setVaultKeyAliases,
  suggestVaultKeyAlias,
  type SkillEnvScope,
  type SkillEnvSourcePolicyRow,
  type EnvSuggestion,
  type VaultKeyAliasSuggestion,
} from '../lib/tauri.js'
import { envConfidenceLabel, envEvidenceText } from '../lib/env-declaration.js'
import { readAuthSpace } from '../store/index.js'
import { ENV_READINESS_CHANGED_EVENT, type EnvReadinessChange } from '../lib/env-readiness.js'
import { reconcileLocalSkillRefresh } from '../lib/ui-helpers.js'
import { userMessage } from '../lib/user-message.js'
import {
  acceptsVaultResponse,
  aliasesOf,
  loadKeyVault,
  mergeAlias,
  primaryVaultKey,
  removeAlias,
  validateVariantLabel,
  variantChoices,
  variantDisplayName,
  vaultDefaultFor,
} from '../lib/keys.js'
import {
  KEY_COPY,
  aliasSuggestionSegments,
  aliasSuggestionText,
  dismissKeysExplainer,
  readKeysExplainerDismissed,
  currentSourceChoiceId,
  keyRowElements,
  keySourceChoices,
  keyRowStatus,
  openKeyConsent,
  type KeyRowStatus,
  type KeyViewerRole,
} from '../lib/skill-keys.js'
import './SkillKeys.css'

/** The sidecar id every native env command expects. */
export function managedKeySkillId(skill: LocalSkill): string {
  return skill.marketplaceLocalId ?? skill.id
}

/** Default descriptions the APP writes itself are not a declared purpose. */
const GENERATED_DESCRIPTIONS = new Set(['由用户手动添加', '由 SkillHub 静态分析检测'])

export function keyPurposeText(description: string | undefined | null): string | null {
  const text = description?.trim()
  return text && !GENERATED_DESCRIPTIONS.has(text) ? text : null
}

export type SkillKeyPolicy = {
  rows: SkillEnvSourcePolicyRow[]
  loading: boolean
  error: string | null
  reload: () => void
}

/**
 * Reads the resolved policy for one installed Skill and re-reads it whenever
 * a value, source or declaration changes (here, in the guide or on the 钥匙
 * page). The response carries names and states only.
 */
export function useSkillKeyPolicy(skill: LocalSkill): SkillKeyPolicy {
  const capabilities = useSpaceCapabilities()
  const currentUser = useStore((state) => state.currentUser)
  const authStatus = useStore((state) => state.authStatus)
  const managedSkillId = managedKeySkillId(skill)
  const declarationKey = skill.envDeps.map((dependency) => `${dependency.key}:${dependency.configured}:${dependency.pending ? 1 : 0}`).join('|')
  const [rows, setRows] = useState<SkillEnvSourcePolicyRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [version, setVersion] = useState(0)
  const rowsOwner = useRef<string | null>(null)
  const reload = useCallback((): void => setVersion((value) => value + 1), [])

  useEffect(() => {
    const onChange = (event: Event): void => {
      const detail = (event as CustomEvent<EnvReadinessChange | undefined>).detail
      if (!detail?.skillId || detail.skillId === managedSkillId) reload()
    }
    window.addEventListener(ENV_READINESS_CHANGED_EVENT, onChange)
    return () => window.removeEventListener(ENV_READINESS_CHANGED_EVENT, onChange)
  }, [managedSkillId, reload])

  useEffect(() => {
    let active = true
    // The native command uses these only to prove that the WebView and Runtime
    // Session still represent the same account. Native ownership metadata,
    // not this space's presence, decides whether any Server source is queried.
    const space = currentUser ? readAuthSpace() : null
    const accountUserId = currentUser?.id
    // Re-reads keep the previous rows on screen; another account or Skill never does.
    const owner = `${accountUserId ?? ''}:${managedSkillId}`
    if (rowsOwner.current !== owner) { rowsOwner.current = owner; setRows([]) }
    setError(null)
    setLoading(true)
    if (authStatus === 'restoring' || !skill.localPath) return () => { active = false }
    void getSkillEnvSourcePolicy(managedSkillId, accountUserId ?? null, capabilities.teamKeys)
      .then((next: SkillEnvSourcePolicyRow[]) => { if (active) setRows(next) })
      .catch((reason: unknown) => { if (active) { setRows([]); setError(userMessage(reason)) } })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [authStatus, currentUser, capabilities.teamKeys, declarationKey, managedSkillId, skill.localPath, version])

  return { rows, loading, error, reload }
}

// ── 「变量名不一致」 (#288) ──

// One native lookup per account + key; any key or value change drops them all.
const aliasSuggestions = new Map<string, Promise<VaultKeyAliasSuggestion | null>>()
let aliasCacheBound = false

function cachedAliasSuggestion(key: string, accountUserId: string | null): Promise<VaultKeyAliasSuggestion | null> {
  if (!aliasCacheBound && typeof window !== 'undefined') {
    window.addEventListener(ENV_READINESS_CHANGED_EVENT, () => aliasSuggestions.clear())
    aliasCacheBound = true
  }
  const id = `${accountUserId ?? ''}:${key}`
  let pending = aliasSuggestions.get(id)
  if (!pending) {
    // A failed lookup simply shows no prompt.
    pending = suggestVaultKeyAlias(key, accountUserId).catch(() => null)
    aliasSuggestions.set(id, pending)
  }
  return pending
}

/** The vault's same-service key under another name, while this row still needs a value. */
function useAliasSuggestion(key: string, enabled: boolean, accountUserId: string | null): VaultKeyAliasSuggestion | null {
  const [suggestion, setSuggestion] = useState<VaultKeyAliasSuggestion | null>(null)
  const [version, setVersion] = useState(0)

  useEffect(() => {
    const onChange = (): void => setVersion((value) => value + 1)
    window.addEventListener(ENV_READINESS_CHANGED_EVENT, onChange)
    return () => window.removeEventListener(ENV_READINESS_CHANGED_EVENT, onChange)
  }, [])

  useEffect(() => {
    setSuggestion(null)
    if (!enabled) return
    let active = true
    void cachedAliasSuggestion(key, accountUserId).then((next) => { if (active) setSuggestion(next) })
    return () => { active = false }
  }, [accountUserId, enabled, key, version])

  return suggestion
}

/** Keeps the store's vault slice (钥匙 page, team share choices) in step after an alias write. */
async function refreshKeyVault(accountUserId: string | null): Promise<void> {
  const next = await loadKeyVault(accountUserId, { listVaultKeys, getKeyVaultSettings })
  const state = useStore.getState()
  if (acceptsVaultResponse(state.currentUser?.id ?? null, next)) state.setKeyVault(next)
}

async function vaultAliases(existingKey: string, accountUserId: string | null): Promise<string[]> {
  const entry = primaryVaultKey(await listVaultKeys(accountUserId), existingKey)
  return entry ? aliasesOf(entry) : []
}

/**
 * 「你已有一把 fal.ai 钥匙：FAL_KEY …」: 「用 FAL_KEY」 adds this name as an
 * alias of the vault key (no value is copied or shown); 「填写新的值」 opens
 * the usual fill form.
 */
function KeyAliasSuggestion({ keyName, suggestion, panelId, onFillNew }: {
  keyName: string
  suggestion: VaultKeyAliasSuggestion
  panelId: string
  onFillNew: () => void
}) {
  const accountUserId = useStore((state) => state.currentUser?.id ?? null)
  const [linking, setLinking] = useState(false)
  const inFlight = useRef(false)
  const { service, existingKey } = suggestion

  const link = async (): Promise<void> => {
    if (inFlight.current) return
    inFlight.current = true
    setLinking(true)
    try {
      await setVaultKeyAliases(existingKey, mergeAlias(await vaultAliases(existingKey, accountUserId), keyName), accountUserId)
      await refreshKeyVault(accountUserId).catch(() => undefined)
      toast(KEY_COPY.aliasLinkedToast(keyName, existingKey), 'default', async () => {
        try {
          await setVaultKeyAliases(existingKey, removeAlias(await vaultAliases(existingKey, accountUserId), keyName), accountUserId)
          await refreshKeyVault(accountUserId).catch(() => undefined)
        } catch (reason: unknown) {
          toast(userMessage(reason), 'error')
        }
      })
    } catch (reason: unknown) {
      toast(userMessage(reason), 'error')
    } finally {
      inFlight.current = false
      setLinking(false)
    }
  }

  return <div className="key-alias-suggest" role="group" aria-label={aliasSuggestionText(service, existingKey, keyName)} aria-busy={linking}>
    <p>{aliasSuggestionSegments(service, existingKey, keyName).map((segment, index) => segment.code
      ? <code key={index} className="key-alias-tag">{segment.text}</code>
      : <span key={index}>{segment.text}</span>)}</p>
    <div className="key-req-panel-actions">
      <button type="button" className="btn btn-ghost btn-sm" disabled={linking} aria-controls={panelId} onClick={onFillNew}>{KEY_COPY.aliasFillNew}</button>
      <button type="button" className="btn btn-primary btn-sm" disabled={linking} onClick={() => void link()}>{linking ? KEY_COPY.aliasLinking : KEY_COPY.aliasUseButton(existingKey)}</button>
    </div>
  </div>
}

type BadgeView = { label: string; icon: IconName; tone: 'success' | 'warning' | 'muted' }

const STATUS_BADGES: Record<KeyRowStatus, BadgeView> = {
  ready: { label: KEY_COPY.ready, icon: 'check', tone: 'success' },
  needs_value: { label: KEY_COPY.needsValue, icon: 'key-round', tone: 'warning' },
  needs_choice: { label: KEY_COPY.choose, icon: 'list', tone: 'warning' },
  needs_consent: { label: KEY_COPY.awaitingConsent, icon: 'lock', tone: 'warning' },
  loading: { label: '读取中…', icon: 'clock', tone: 'muted' },
  error: { label: '读取失败', icon: 'warn', tone: 'muted' },
}

export function KeyStatusBadge({ status }: { status: KeyRowStatus }) {
  const badge = STATUS_BADGES[status]
  return <span className={`key-req-badge ${badge.tone}`}><Icon name={badge.icon} size={12} strokeWidth={1.9} />{badge.label}</span>
}

type ListProps = {
  skill: LocalSkill
  role: KeyViewerRole
  policy: SkillKeyPolicy
  /** Updates the Skill in the store after a value or declaration write. */
  replaceSkill?: (skill: LocalSkill) => void
  onConfirmPending?: (key: string) => Promise<void>
  /** The guide reuses the rows without the per-row author confirmation. */
  variant?: 'sheet' | 'guide'
}

export function KeyRequirementList({ skill, role, policy, replaceSkill, onConfirmPending, variant = 'sheet' }: ListProps) {
  return <ul className={`key-req-list ${variant}`} aria-label={`${skill.displayName} 需要的钥匙`}>
    {skill.envDeps.map((dependency) => <KeyRequirementRow
      key={dependency.key}
      skill={skill}
      dependency={dependency}
      role={role}
      policy={policy}
      replaceSkill={replaceSkill}
      onConfirmPending={variant === 'sheet' ? onConfirmPending : undefined}
    />)}
  </ul>
}

function KeyRequirementRow({ skill, dependency, role, policy, replaceSkill, onConfirmPending }: Omit<ListProps, 'variant'> & { dependency: EnvDep }) {
  const row = policy.rows.find((candidate) => candidate.key === dependency.key)
  const status = keyRowStatus(row, policy.loading && !row, Boolean(policy.error))
  const installed = Boolean(skill.localPath)
  const elements = keyRowElements({ role, status, row, dependency, installed })
  const [panel, setPanel] = useState<'fill' | 'choose' | null>(null)
  const [confirming, setConfirming] = useState(false)
  const purpose = keyPurposeText(dependency.description ?? row?.description)
  const panelId = `key-req-panel-${managedKeySkillId(skill)}-${dependency.key}`
  const accountUserId = useStore((state) => state.currentUser?.id ?? null)
  const suggestion = useAliasSuggestion(dependency.key, elements.primary === 'fill', accountUserId)
  const suggesting = Boolean(suggestion) && elements.primary === 'fill' && panel !== 'fill'

  // A resolved row closes a panel whose job is done (e.g. filled elsewhere).
  useEffect(() => {
    if (panel === 'fill' && status !== 'needs_value' && status !== 'loading') setPanel(null)
  }, [panel, status])

  const confirm = async (): Promise<void> => {
    if (!onConfirmPending || confirming) return
    setConfirming(true)
    try { await onConfirmPending(dependency.key) }
    finally { setConfirming(false) }
  }

  return <li className="key-req-row" data-state={status}>
    <div className="key-req-main">
      <div className="key-req-title">
        <code className="key-req-name" title={dependency.key}>{dependency.key}</code>
        <KeyStatusBadge status={status} />
        {elements.runtimeTag && <span className="key-req-tag">{KEY_COPY.runtimeRequest}</span>}
      </div>
      {purpose && <p className="key-req-purpose">{purpose}</p>}
      {elements.obtainUrl && <button type="button" className="key-req-obtain" onClick={() => void openUrl(elements.obtainUrl!).catch((reason: unknown) => toast(userMessage(reason), 'error'))}>
        获取方式<Icon name="arrow-right" size={12} />
      </button>}
    </div>
    <div className="key-req-action">
      {elements.using && (elements.switchable
        ? <button type="button" className="key-req-using switchable" aria-expanded={panel === 'choose'} aria-controls={panelId} onClick={() => setPanel(panel === 'choose' ? null : 'choose')}>
          {elements.using}<Icon name="chev" size={12} />
        </button>
        : <span className="key-req-using">{elements.using}</span>)}
      {elements.primary === 'fill' && !suggesting && <button type="button" className="btn btn-primary btn-sm" aria-expanded={panel === 'fill'} aria-controls={panelId} onClick={() => setPanel(panel === 'fill' ? null : 'fill')}>填写</button>}
      {elements.primary === 'choose' && <button type="button" className="btn btn-primary btn-sm" aria-expanded={panel === 'choose'} aria-controls={panelId} onClick={() => setPanel(panel === 'choose' ? null : 'choose')}>选择</button>}
      {elements.primary === 'consent' && <button type="button" className="btn btn-primary btn-sm" onClick={() => openKeyConsent({ skillId: managedKeySkillId(skill), skillName: skill.displayName, keys: [dependency.key], requestedAt: Date.now() })}>授权</button>}
      {elements.confirmPending && onConfirmPending && <button type="button" className="btn btn-ghost btn-sm" disabled={confirming} onClick={() => void confirm()}>{confirming ? '确认中…' : '确认需要'}</button>}
    </div>
    {suggesting && suggestion && <KeyAliasSuggestion keyName={dependency.key} suggestion={suggestion} panelId={panelId} onFillNew={() => setPanel('fill')} />}
    {panel === 'fill' && <KeyFillForm id={panelId} skill={skill} keyName={dependency.key} replaceSkill={replaceSkill} onDone={() => { setPanel(null); policy.reload() }} onCancel={() => setPanel(null)} />}
    {panel === 'choose' && row && <KeyChoiceList id={panelId} skill={skill} row={row} onDone={() => { setPanel(null); policy.reload() }} onCancel={() => setPanel(null)} />}
  </li>
}

/**
 * The existing password input, now inline: 「保存到钥匙库」 writes the account
 * vault (every Skill declaring the key can use it), 「仅此 Skill」 keeps it as
 * this Skill's own value. The value lives only in this input until saved and
 * is cleared right after; it is never echoed back.
 */
export function KeyFillForm({ id, skill, keyName, replaceSkill, onDone, onCancel }: {
  id: string
  skill: LocalSkill
  keyName: string
  replaceSkill?: (skill: LocalSkill) => void
  onDone: () => void
  onCancel: () => void
}) {
  const accountUserId = useStore((state) => state.currentUser?.id ?? null)
  const vault = useStore((state) => state.keyVault)
  const [value, setValue] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // #306 「存为带标签的新钥匙」: the label input shows once chosen.
  const [labeling, setLabeling] = useState(false)
  const [label, setLabel] = useState('')
  const inFlight = useRef(false)
  const managedSkillId = managedKeySkillId(skill)
  const vaultCurrent = vault.status === 'ready' && vault.accountUserId === accountUserId
  const defaultEntry = vaultCurrent ? vaultDefaultFor(vault.keys, keyName) : undefined

  // The third option needs to know whether the name already has a default value.
  useEffect(() => {
    if (vaultCurrent) return
    void refreshKeyVault(accountUserId).catch(() => undefined)
  }, [accountUserId, vaultCurrent])

  const saveAsVariant = async (): Promise<void> => {
    if (!value || !defaultEntry || inFlight.current) return
    const problem = validateVariantLabel(label, variantChoices(defaultEntry).map((choice) => choice.label))
    if (problem) { setError(problem); return }
    inFlight.current = true
    setSaving(true)
    setError(null)
    try {
      const trimmed = label.trim()
      const { variant } = await createVaultKeyVariant(defaultEntry.key, trimmed, value, accountUserId)
      setValue('')
      await setSkillEnvSource(managedSkillId, keyName, { kind: 'personalVariant', variant }, accountUserId)
      await refreshKeyVault(accountUserId).catch(() => undefined)
      toast(KEY_COPY.variantSavedToast(defaultEntry.key, trimmed))
      onDone()
    } catch (reason: unknown) {
      setError(userMessage(reason))
    } finally {
      inFlight.current = false
      setSaving(false)
    }
  }

  const save = async (scope: SkillEnvScope): Promise<void> => {
    if (!value || inFlight.current) return
    inFlight.current = true
    setSaving(true)
    setError(null)
    try {
      await setSkillEnv(managedSkillId, keyName, value, accountUserId, scope)
      setValue('')
      const local = await getLocalSkill(managedSkillId).catch(() => undefined)
      if (local && replaceSkill) replaceSkill(reconcileLocalSkillRefresh(skill, local))
      toast(scope === 'skill' ? `${keyName} 已保存，仅此 Skill 使用` : `${keyName} 已保存到你的钥匙库`)
      onDone()
    } catch (reason: unknown) {
      setError(userMessage(reason))
    } finally {
      inFlight.current = false
      setSaving(false)
    }
  }

  return <div className="key-req-panel" id={id}>
    <label className="secret-input-label">
      <span>{keyName}</span>
      <input type="password" autoFocus autoComplete="off" spellCheck={false} value={value} disabled={saving}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') void save('vault')
          if (event.key === 'Escape') { event.stopPropagation(); onCancel() }
        }}
        placeholder="粘贴钥匙后保存" />
    </label>
    <p className="key-req-hint">{labeling ? KEY_COPY.saveAsVariantHint : KEY_COPY.fillHint}</p>
    {labeling && <label className="secret-input-label">
      <span>{KEY_COPY.variantLabel}</span>
      <input className="key-alias-input" value={label} disabled={saving} autoComplete="off" spellCheck={false}
        placeholder={KEY_COPY.variantLabelPlaceholder}
        onChange={(event) => { setLabel(event.target.value); setError(null) }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') void saveAsVariant()
          if (event.key === 'Escape') { event.stopPropagation(); setLabeling(false) }
        }} />
    </label>}
    {error && <div className="banner banner-error" role="alert"><Icon name="warn" size={14} />{error}</div>}
    <div className="key-req-panel-actions">
      <button type="button" className="btn btn-ghost btn-sm" disabled={saving} onClick={labeling ? () => setLabeling(false) : onCancel}>取消</button>
      {labeling
        ? <button type="button" className="btn btn-primary btn-sm" disabled={!value || !label.trim() || saving} onClick={() => void saveAsVariant()}>{saving ? '保存中…' : KEY_COPY.saveAsVariant}</button>
        : <>
          <button type="button" className="btn btn-ghost btn-sm" disabled={!value || saving} onClick={() => void save('skill')}>{KEY_COPY.skillOnly}</button>
          {defaultEntry && <button type="button" className="btn btn-ghost btn-sm" disabled={!value || saving} onClick={() => { setLabeling(true); setError(null) }}>{KEY_COPY.saveAsVariant}</button>}
          <button type="button" className="btn btn-primary btn-sm" disabled={!value || saving} onClick={() => void save('vault')}>{saving ? '保存中…' : KEY_COPY.fillVault}</button>
        </>}
    </div>
  </div>
}

/**
 * 「更换」 on the 钥匙 page (#294): the same password input as
 * {@link KeyFillForm}, writing the account vault directly. Every Skill that
 * uses the vault value picks up the new one; per-Skill values are untouched.
 */
export function VaultKeyReplaceForm({ id, keyName, variant = null, label = null, onDone, onCancel }: {
  id: string
  keyName: string
  /** #306: the labelled variant to replace (`null` = the unlabelled value). */
  variant?: string | null
  label?: string | null
  onDone: () => void
  onCancel: () => void
}) {
  const accountUserId = useStore((state) => state.currentUser?.id ?? null)
  const [value, setValue] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inFlight = useRef(false)

  const save = async (): Promise<void> => {
    if (!value || inFlight.current) return
    inFlight.current = true
    setSaving(true)
    setError(null)
    try {
      await setVaultKey(keyName, value, accountUserId, variant)
      setValue('')
      toast(`${variantDisplayName(keyName, label)} 已更换，用钥匙库的 Skill 下次运行就会用新的`)
      onDone()
    } catch (reason: unknown) {
      setError(userMessage(reason))
    } finally {
      inFlight.current = false
      setSaving(false)
    }
  }

  return <div className="key-req-panel" id={id}>
    <label className="secret-input-label">
      <span>{variantDisplayName(keyName, label)}</span>
      <input type="password" autoFocus autoComplete="off" spellCheck={false} value={value} disabled={saving}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') void save()
          if (event.key === 'Escape') { event.stopPropagation(); onCancel() }
        }}
        placeholder="粘贴新的钥匙后保存" />
    </label>
    <p className="key-req-hint">{KEY_COPY.replaceHint}</p>
    {error && <div className="banner banner-error" role="alert"><Icon name="warn" size={14} />{error}</div>}
    <div className="key-req-panel-actions">
      <button type="button" className="btn btn-ghost btn-sm" disabled={saving} onClick={onCancel}>取消</button>
      <button type="button" className="btn btn-primary btn-sm" disabled={!value || saving} onClick={() => void save()}>{saving ? '保存中…' : KEY_COPY.fillVault}</button>
    </div>
  </div>
}

/** 「选择」: one radio per usable key; the pick is written as this Skill's policy. */
export function KeyChoiceList({ id, skill, row, onDone, onCancel }: {
  id: string
  skill: LocalSkill
  row: SkillEnvSourcePolicyRow
  onDone: () => void
  onCancel: () => void
}) {
  const currentUser = useStore((state) => state.currentUser)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inFlight = useRef(false)
  const managedSkillId = managedKeySkillId(skill)
  const choices = keySourceChoices(row)
  const current = currentSourceChoiceId(row)

  const run = async (action: () => Promise<void>, message: string): Promise<void> => {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setError(null)
    try {
      await action()
      toast(message)
      onDone()
    } catch (reason: unknown) {
      setError(userMessage(reason))
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  return <div className="key-req-panel" id={id}>
    <div className="key-req-choices" role="radiogroup" aria-label={`${row.key} 用哪把钥匙`}>
      {choices.map((choice) => {
        const value = choice.id
        const label = choice.label
        return <label key={value} className={`key-req-choice${value === current ? ' checked' : ''}`}>
          <input type="radio" name={`${id}-choice`} value={value} checked={value === current} disabled={busy || (choice.source.kind === 'team' && !currentUser)}
            onChange={() => {
              if (value === current) return
              // #306: 你的钥匙 · 公司 is written as { kind: 'personalVariant', variant }.
              void run(() => setSkillEnvSource(managedSkillId, row.key, choice.source, currentUser?.id ?? null), `${row.key} 已改用${label}`)
            }} />
          <span>{label}</span>
        </label>
      })}
    </div>
    {row.personalSource === 'override' && <button type="button" className="key-req-link" disabled={busy}
      onClick={() => void run(() => deleteSkillEnv(managedSkillId, row.key, currentUser?.id ?? null), `${row.key} 不再单独使用此 Skill 的值`)}>
      改用钥匙库里的 {row.key}
    </button>}
    {error && <div className="banner banner-error" role="alert"><Icon name="warn" size={14} />{error}</div>}
    <div className="key-req-panel-actions">
      <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={onCancel}>{busy ? '保存中…' : '收起'}</button>
    </div>
  </div>
}

/**
 * 「什么是钥匙？」 (#289 board 2): three short columns above 「需要的钥匙」.
 * 「不再显示」 is remembered on this computer.
 */
export function KeysExplainer() {
  const [dismissed, setDismissed] = useState(() => readKeysExplainerDismissed())
  if (dismissed) return null
  const columns: Array<{ icon: IconName; title: string; body: string }> = [
    { icon: 'key-round', title: KEY_COPY.explainerWhatTitle, body: KEY_COPY.explainerWhat },
    { icon: 'lock', title: KEY_COPY.explainerWhereTitle, body: KEY_COPY.explainerWhere },
    { icon: 'check', title: KEY_COPY.explainerHowTitle, body: KEY_COPY.explainerHow },
  ]
  return <section className="key-explainer" aria-labelledby="key-explainer-title">
    <div className="key-explainer-head">
      <h3 id="key-explainer-title"><Icon name="info" size={14} />{KEY_COPY.explainerTitle}</h3>
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => { dismissKeysExplainer(); setDismissed(true) }}>{KEY_COPY.explainerDismiss}</button>
    </div>
    <div className="key-explainer-columns">
      {columns.map((column) => <div key={column.title} className="key-explainer-column">
        <b><Icon name={column.icon} size={13} />{column.title}</b>
        <p>{column.body}</p>
      </div>)}
    </div>
  </section>
}

/** One 「重新检测」 result: name, confidence pill, and its evidence in a tooltip (#284). */
export function DetectedKeyRow({ suggestion, declared }: { suggestion: EnvSuggestion; declared: boolean }) {
  const evidence = envEvidenceText(suggestion)
  return <li className="key-detect-row">
    <code>{suggestion.key}</code>
    <span className={`key-confidence key-confidence-${suggestion.confidence}`}>{envConfidenceLabel(suggestion.confidence)}</span>
    {declared && <span className="key-detect-declared">已在清单</span>}
    {evidence && <Tooltip content={evidence} placement="top" align="end">
      <span className="key-detect-evidence" tabIndex={0} role="img" aria-label={`${suggestion.key} 的检测依据`}><Icon name="info" size={13} /></span>
    </Tooltip>}
  </li>
}
import { useSpaceCapabilities } from '../lib/use-space-capabilities.js'
