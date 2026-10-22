import { useEffect, useState, type ReactNode } from 'react'
import DocHelp from '../components/DocHelp.js'
import { Icon } from '../components/Icon.js'
import { toast } from '../components/Toast.js'
import ConfirmModal from '../components/ConfirmModal.js'
import KeyAliasEditor from '../components/KeyAliasEditor.js'
import { useSpaceCapabilities } from '../lib/use-space-capabilities.js'
import ShareKeyDialog from '../components/ShareKeyDialog.js'
import KeyVariantDialog, { type KeyVariantDialogMode } from '../components/KeyVariantDialog.js'
import TeamKeyList, { useTeamKeys } from '../components/TeamKeyList.js'
import { SegmentedControl } from '../components/SegmentedControl.js'
import { KeyCard, KeyNames, KeySkillChipButton, KeySkillSection, MenuButton, type MenuItem } from '../components/KeyCard.js'
import { VaultKeyReplaceForm } from '../components/SkillKeys.js'
import { SkeletonBlock } from '../components/StateViews.js'
import { LOADING_COPY } from '../lib/state-copy.js'
import { BlankDragSpacer } from '../components/WindowDragRegion.js'
import { PageHeading } from '../components/PageHeading.js'
import {
  convertSkillOverrideToVariant,
  createVaultKeyVariant,
  deleteVaultKey,
  setVaultDefaultVariant,
  setVaultKeySkillAccess,
  setVaultKeyVariantLabel,
  type VaultKey,
} from '../lib/tauri.js'
import { userMessage } from '../lib/user-message.js'
import {
  KEY_TABS,
  KEYS_EMPTY_COPY,
  KEYS_PAGE_COPY,
  convertedToast,
  overrideListLabel,
  overrideSkillEntries,
  personalKeyCardView,
  personalKeyMenuIds,
  variantChoices,
  variantDisplayName,
  vaultKeyDisplayName,
  vaultKeyIdentity,
  type KeyScope,
  type KeySkillChip,
  type PersonalKeyMenuId,
} from '../lib/keys.js'
import { useStore } from '../store/index.js'
import './KeysPage.css'

type KeysPageProps = {
  /** Personal vault keys (names and metadata only). */
  keys: readonly VaultKey[]
  /** Account-level 「以后不再询问」 switch: every Skill that asks is allowed. */
  autoAllow: boolean
  /** Re-reads the personal vault. */
  reload: () => Promise<void>
  /** 列表上方的状态区（读取出错时的重试）。 */
  notice?: ReactNode
  /** 数据仍在读取时为 true，屏幕阅读器可感知。 */
  busy?: boolean
  /** 首次读取尚未完成：显示与列表布局匹配的骨架，而不是空态。 */
  loading?: boolean
}

type PersonalPanel = { key: string; kind: 'replace' } | null

/** The open 「添加另一把」 / 「重命名标签」 / 「转成一把带标签的钥匙」 dialog (#306). */
type VariantDialog = { mode: KeyVariantDialogMode; key: VaultKey; skill?: { id: string; name: string } } | null

/** DOM-safe id fragment of a card identity (`FAL_KEY::v1` → `FAL_KEY--v1`). */
function cardDomId(identity: string): string {
  return `personal-key-${identity.replace(/[^A-Za-z0-9_-]/g, '-')}`
}

/**
 * 「钥匙」 (#294 boards 4–6): 个人 / 团队 tabs. Each key is a card whose
 * header opens the Skills that can use it; a Skill card toggles it on or off
 * for that Skill. 「共享」 opens the multi-team share dialog.
 */
export default function KeysPage({ keys, autoAllow, reload, notice, busy = false, loading = false }: KeysPageProps) {
  const keysPageIntent = useStore((state) => state.keysPageIntent)
  const setKeysPageIntent = useStore((state) => state.setKeysPageIntent)
  const currentUser = useStore((state) => state.currentUser)
  const accountUserId = currentUser?.id ?? null
  const [scope, setScope] = useState<KeyScope>(() => keysPageIntent?.tab ?? 'personal')
  const [expanded, setExpanded] = useState<string | null>(() => keysPageIntent?.key ?? null)
  const [focusKey, setFocusKey] = useState<string | null>(null)
  const [panel, setPanel] = useState<PersonalPanel>(null)
  const [aliasKey, setAliasKey] = useState<VaultKey | null>(null)
  const capabilities = useSpaceCapabilities()
  const [shareKey, setShareKey] = useState<VaultKey | null>(null)
  const [revoking, setRevoking] = useState<VaultKey | null>(null)
  const [variantDialog, setVariantDialog] = useState<VariantDialog>(null)
  const [overridesOpen, setOverridesOpen] = useState<string | null>(null)
  const [revokeBusy, setRevokeBusy] = useState(false)
  const [busyChip, setBusyChip] = useState<string | null>(null)
  const team = useTeamKeys()

  // 「共享给团队」 from a Skill's 钥匙 section lands on the right tab once; a key is expanded and focused.
  useEffect(() => {
    if (!keysPageIntent) return
    setScope(keysPageIntent.tab)
    if (keysPageIntent.key) { setExpanded(keysPageIntent.key); setFocusKey(keysPageIntent.key) }
    setKeysPageIntent(null)
  }, [keysPageIntent, setKeysPageIntent])

  useEffect(() => {
    if (!focusKey || !keys.some((key) => vaultKeyIdentity(key) === focusKey)) return
    const header = document.getElementById(`${cardDomId(focusKey)}-head`)
    if (!header) return
    header.focus()
    header.scrollIntoView?.({ block: 'nearest' })
    setFocusKey(null)
  }, [focusKey, keys, scope])

  const counts: Record<KeyScope, number> = { personal: keys.length, team: team.state?.keys.length ?? 0 }

  const toggleChip = async (key: VaultKey, chip: KeySkillChip): Promise<void> => {
    const id = `${vaultKeyIdentity(key)}:${chip.id}`
    if (busyChip) return
    setBusyChip(id)
    try {
      await setVaultKeySkillAccess(key.key, chip.id, !chip.enabled, accountUserId, key.variant ?? null)
      await reload()
    } catch (error: unknown) {
      toast(userMessage(error), 'error')
    } finally {
      setBusyChip(null)
    }
  }

  const revoke = async (): Promise<void> => {
    if (!revoking) return
    setRevokeBusy(true)
    try {
      await deleteVaultKey(revoking.key, accountUserId, revoking.variant ?? null)
      toast(revoking.variant ? `${vaultKeyDisplayName(revoking)} 已撤销，用它的 Skill 改用默认的那一把` : `${revoking.key} 已撤销，使用它的 Skill 需要重新填写`)
      setRevoking(null)
      await reload()
    } catch (error: unknown) {
      // e.g. 「还有带标签的钥匙，先把其中一把设为默认后再撤销」.
      toast(userMessage(error), 'error')
    } finally {
      setRevokeBusy(false)
    }
  }

  const makeDefault = async (key: VaultKey): Promise<void> => {
    try {
      await setVaultDefaultVariant(key.key, key.variant ?? null, accountUserId)
      toast(`${vaultKeyDisplayName(key)} 已设为默认，没有单独选择的 Skill 都会用它`)
      await reload()
    } catch (error: unknown) {
      toast(userMessage(error), 'error')
    }
  }

  /** Writes the open variant dialog; errors stay inline in the dialog. */
  const submitVariant = async (label: string, value: string): Promise<void> => {
    if (!variantDialog) return
    const { mode, key, skill } = variantDialog
    if (mode === 'add') {
      await createVaultKeyVariant(key.key, label, value, accountUserId)
      toast(`已添加 ${variantDisplayName(key.key, label)}`)
    } else if (mode === 'rename' && key.variant) {
      await setVaultKeyVariantLabel(key.key, key.variant, label, accountUserId)
      toast(`标签已改为「${label}」`)
    } else if (mode === 'convert' && skill) {
      await convertSkillOverrideToVariant(skill.id, key.key, label, accountUserId)
      toast(convertedToast(key.key, label, skill.name))
    }
    await reload()
  }

  const menuItems = (key: VaultKey): MenuItem[] => {
    const identity = vaultKeyIdentity(key)
    const items: Record<PersonalKeyMenuId, MenuItem> = {
      replace: { id: 'replace', label: KEYS_PAGE_COPY.replace, icon: 'refresh', onSelect: () => setPanel({ key: identity, kind: 'replace' }) },
      alias: { id: 'alias', label: KEYS_PAGE_COPY.linkNames, icon: 'link', onSelect: () => setAliasKey(key) },
      setDefault: { id: 'setDefault', label: KEYS_PAGE_COPY.setDefault, icon: 'badge-check', onSelect: () => void makeDefault(key) },
      addVariant: { id: 'addVariant', label: KEYS_PAGE_COPY.addVariant, icon: 'tag', onSelect: () => setVariantDialog({ mode: 'add', key }) },
      renameLabel: { id: 'renameLabel', label: KEYS_PAGE_COPY.renameLabel, icon: 'pencil', onSelect: () => setVariantDialog({ mode: 'rename', key }) },
      revoke: { id: 'revoke', label: KEYS_PAGE_COPY.revoke, icon: 'trash', danger: true, onSelect: () => setRevoking(key) },
    }
    return personalKeyMenuIds(key).map((id) => items[id])
  }

  const personal = loading && keys.length === 0
    ? <SkeletonBlock layout="rows" count={3} label={LOADING_COPY.keys} />
    : keys.length === 0
    ? <div className="keys-empty">
      <span className="keys-empty-icon" aria-hidden="true"><Icon name="key-round" size={22} /></span>
      <p>{KEYS_EMPTY_COPY}</p>
    </div>
    : <div className="keys-cards">{keys.map((key) => {
      const view = personalKeyCardView(key, autoAllow)
      const identity = vaultKeyIdentity(key)
      const domId = cardDomId(identity)
      const open = expanded === identity
      const replacing = panel?.key === identity && panel.kind === 'replace'
      // The native listing puts the per-Skill overrides on the default row only.
      const overrides = overrideSkillEntries(key)
      const overridesExpanded = overridesOpen === identity
      return <KeyCard
        key={identity}
        id={domId}
        tone="personal"
        className={view.variant !== null ? 'key-card-variant' : undefined}
        open={open}
        onToggle={() => setExpanded(open ? null : identity)}
        names={<KeyNames name={view.key} aliases={view.aliases} label={view.label} isDefault={view.isDefault} showDefault={view.grouped} aliasesTitle={view.aliasesEditable ? undefined : KEYS_PAGE_COPY.aliasesOnDefault} />}
        meta={<span>{view.purpose} · 最近使用 {view.lastUsed}</span>}
        summary={view.summary}
        actions={<>
          {capabilities.teamKeys && <button type="button" className="btn btn-ghost btn-sm keys-share-button" disabled={!currentUser} title={currentUser ? undefined : '登录后可以共享给团队'} onClick={() => setShareKey(key)}><Icon name="share" size={13} />{KEYS_PAGE_COPY.share}</button>}
          <MenuButton label={KEYS_PAGE_COPY.moreLabel} items={menuItems(key)}><Icon name="more" size={16} /></MenuButton>
        </>}
        panel={replacing ? <VaultKeyReplaceForm id={`${domId}-replace`} keyName={key.key} variant={view.variant} label={view.label} onCancel={() => setPanel(null)} onDone={() => { setPanel(null); void reload() }} /> : undefined}
      >
        <KeySkillSection title={KEYS_PAGE_COPY.skillsTitle} hint={KEYS_PAGE_COPY.skillsHint}>
          {view.chips.length === 0
            ? <p className="key-card-empty">{KEYS_PAGE_COPY.noSkills}</p>
            : <div className="key-skill-list">{view.chips.map((chip) => <KeySkillChipButton key={chip.id} chip={chip} busy={busyChip === `${identity}:${chip.id}`} onToggle={(target) => void toggleChip(key, target)} />)}</div>}
        </KeySkillSection>
        {overrides.length > 0 && <section className="key-card-section">
          <button type="button" className="key-override-toggle" aria-expanded={overridesExpanded} aria-controls={`${domId}-overrides`} onClick={() => setOverridesOpen(overridesExpanded ? null : identity)}>
            {overrideListLabel(overrides.length)}<Icon name="chev" size={12} className="key-card-chev" />
          </button>
          {overridesExpanded && <ul className="key-override-list" id={`${domId}-overrides`}>
            {overrides.map((skill) => <li key={skill.id}>
              <span>{skill.name}</span>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setVariantDialog({ mode: 'convert', key, skill })}>{KEYS_PAGE_COPY.convertToVariant}</button>
            </li>)}
          </ul>}
        </section>}
      </KeyCard>
    })}</div>

  return <>
    <PageHeading
      title={KEYS_PAGE_COPY.title}
      subtitle={scope === 'team' ? KEYS_PAGE_COPY.teamSubtitle : KEYS_PAGE_COPY.personalSubtitle}
      actions={<>
        <DocHelp topic="keys" variant="section" label="钥匙是怎么用的" />
        <BlankDragSpacer />
        <SegmentedControl
          aria-label={KEYS_PAGE_COPY.tabsLabel}
          className="keys-tabs"
          value={scope}
          onChange={setScope}
          options={KEY_TABS.filter(tab => tab.scope === 'personal' || capabilities.teamKeys).map((tab) => ({ value: tab.scope, label: tab.label, icon: tab.icon, count: counts[tab.scope] }))}
        />
      </>}
    />
    <div className="page-body keys-page">
      <section id="keys-panel" role="tabpanel" aria-label={scope === 'team' ? '团队钥匙' : '个人钥匙'} aria-busy={scope === 'personal' ? busy : undefined}>
        {scope === 'personal' && notice && <div className="keys-notice">{notice}</div>}
        {scope === 'personal' ? personal : <TeamKeyList binding={team} />}
      </section>
    </div>
    {aliasKey && <KeyAliasEditor keyName={aliasKey.key} aliases={aliasKey.aliases ?? []} onClose={() => setAliasKey(null)} onSaved={() => void reload()} />}
    {shareKey && <ShareKeyDialog keyName={shareKey.key} initialVariant={shareKey.variant ?? null} onClose={() => setShareKey(null)} />}
    {variantDialog && <KeyVariantDialog
      mode={variantDialog.mode}
      keyName={variantDialog.key.key}
      existingLabels={variantChoices(variantDialog.key).map((choice) => choice.label)}
      initialLabel={variantDialog.mode === 'rename' ? variantDialog.key.label ?? null : null}
      skillName={variantDialog.skill?.name}
      onSubmit={submitVariant}
      onClose={() => setVariantDialog(null)}
    />}
    {revoking && <ConfirmModal eyebrow="钥匙" title={`撤销 ${vaultKeyDisplayName(revoking)}？`} description={revoking.variant ? '这把带标签的钥匙会被删除，选了它的 Skill 改用默认的那一把。' : '钥匙库中的值会被删除，所有使用它的 Skill 都需要重新填写；单个 Skill 自己保存的值不受影响。'} confirmLabel={KEYS_PAGE_COPY.revoke} destructive busy={revokeBusy} onCancel={() => setRevoking(null)} onConfirm={() => void revoke()} />}
  </>
}
