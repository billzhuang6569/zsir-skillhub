import { useSpaceCapabilities } from '../lib/use-space-capabilities.js'
import type { SpaceHandle } from '../lib/tauri.js'
import { useCallback, useEffect, useState } from 'react'
import { useStore } from '../store/index.js'
import { Icon } from './Icon.js'
import { toast } from './Toast.js'
import ConfirmModal from './ConfirmModal.js'
import { SegmentedControl } from './SegmentedControl.js'
import { UserChip } from './UserChip.js'
import { LoadError, SkeletonBlock } from './StateViews.js'
import { KeyCard, KeyNames, KeySkillChipButton, KeySkillSection, MenuButton } from './KeyCard.js'
import { readAuthSpace } from '../store/index.js'
import {
  deleteTeamKey,
  listTeamKeys,
  putTeamKey,
  setTeamKeyExclusion,
  teamKeyUsage,
  type TeamKey,
  type TeamKeyUsage,
} from '../lib/tauri.js'
import { ENV_READINESS_CHANGED_EVENT } from '../lib/env-readiness.js'
import { LOADING_COPY, loadFailedMessage } from '../lib/state-copy.js'
import { userMessage } from '../lib/user-message.js'
import {
  KEYS_PAGE_COPY,
  TEAM_KEYS_UNAVAILABLE,
  acceptsTeamKeyResponse,
  canReplaceFromVault,
  isTeamKeysUnavailable,
  loadTeamKeys,
  personalKeysToShare,
  teamKeyCardView,
  teamMembersLine,
  usageRowView,
  type KeySkillChip,
  type TeamKeyVaultState,
} from '../lib/keys.js'

export type TeamKeysBinding = {
  teamId: string | null
  setTeamId: (teamId: string) => void
  /** The store slice when it belongs to this account and team, else null. */
  state: TeamKeyVaultState | null
  reload: () => Promise<void>
}

/**
 * Loads the selected team's keys into the store slice (#254) and re-reads
 * them after any key change. Lives on the 钥匙 page so the 团队 tab count is
 * known before the tab is opened.
 */
export function useTeamKeys(): TeamKeysBinding {
  const capabilities = useSpaceCapabilities()
  const accountUserId = useStore((state) => state.currentUser?.id ?? null)
  const teams = useStore((state) => state.teams)
  const activeTeamId = useStore((state) => state.activeTeamId)
  const teamKeyVault = useStore((state) => state.teamKeyVault)
  const setTeamKeyVault = useStore((state) => state.setTeamKeyVault)
  const [teamId, setTeamId] = useState<string | null>(activeTeamId ?? teams[0]?.id ?? null)

  useEffect(() => {
    if (teamId && teams.some((team) => team.id === teamId)) return
    setTeamId(activeTeamId ?? teams[0]?.id ?? null)
  }, [activeTeamId, teamId, teams])

  const reload = useCallback(async (): Promise<void> => {
    const space = readAuthSpace()
    if (!capabilities.teamKeys || !accountUserId || !teamId || !space) return
    if (useStore.getState().teamKeyVault.teamId !== teamId) {
      setTeamKeyVault({ ...useStore.getState().teamKeyVault, accountUserId, teamId, status: 'loading', keys: [], error: null })
    }
    const next = await loadTeamKeys(accountUserId, teamId, { listTeamKeys: (id) => listTeamKeys(id, accountUserId) })
    if (useStore.getState().authSpace === space && acceptsTeamKeyResponse(useStore.getState().currentUser?.id ?? null, teamId, next)) setTeamKeyVault(next)
  }, [accountUserId, teamId, capabilities.teamKeys, setTeamKeyVault])

  useEffect(() => {
    void reload()
    const refresh = (): void => { void reload() }
    window.addEventListener(ENV_READINESS_CHANGED_EVENT, refresh)
    return () => window.removeEventListener(ENV_READINESS_CHANGED_EVENT, refresh)
  }, [reload])

  const state = teamKeyVault.teamId === teamId && teamKeyVault.accountUserId === accountUserId ? teamKeyVault : null
  return { teamId, setTeamId, state, reload }
}

/**
 * 「钥匙 · 团队」 (#294 board 5, moved here from 设置). Any member can put one
 * of their vault keys into the team; the holder and the team owner can
 * 换新值 (#320: write the same-named vault value as the next revision; the
 * writer becomes the holder), revoke, turn Skills off and read the usage record. Values never
 * pass through here: the native side reads the account vault.
 */
export default function TeamKeyList({ binding }: { binding: TeamKeysBinding }) {
  const currentUser = useStore((state) => state.currentUser)
  const teams = useStore((state) => state.teams)
  const personal = useStore((state) => state.keyVault.keys)
  const { teamId, setTeamId, state, reload } = binding
  const accountUserId = currentUser?.id ?? null
  const [busy, setBusy] = useState(false)
  const [busyChip, setBusyChip] = useState<string | null>(null)
  const [revoking, setRevoking] = useState<string | null>(null)
  const [replacing, setReplacing] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [usage, setUsage] = useState<TeamKeyUsage | null>(null)
  const [usageError, setUsageError] = useState<string | null>(null)

  useEffect(() => { setExpanded(null); setReplacing(null); setUsage(null) }, [teamId])

  const session = (): { space: SpaceHandle; userId: string } | null => {
    const space = readAuthSpace()
    return space && accountUserId ? { space, userId: accountUserId } : null
  }

  const run = async (action: (current: { space: SpaceHandle; userId: string }) => Promise<void>, success: string): Promise<void> => {
    const current = session()
    if (!current) { toast('请重新登录后再试', 'error'); return }
    setBusy(true)
    try {
      await action(current)
      toast(success)
      await reload()
    } catch (error: unknown) {
      toast(userMessage(error), 'error')
    } finally {
      setBusy(false)
    }
  }

  const loadUsage = useCallback(async (key: string): Promise<void> => {
    const space = readAuthSpace()
    if (!space || !accountUserId || !teamId) return
    setUsageError(null)
    try {
      setUsage(await teamKeyUsage(teamId, key, accountUserId))
    } catch (error: unknown) {
      setUsageError(userMessage(error))
    }
  }, [accountUserId, teamId])

  const keys = state?.keys ?? []
  const expandedKey = keys.find((key) => key.key === expanded) ?? null
  const loadUsageFor = expandedKey?.canManage ? expandedKey.key : null
  useEffect(() => {
    setUsage(null)
    if (loadUsageFor) void loadUsage(loadUsageFor)
  }, [loadUsage, loadUsageFor])

  if (!currentUser) return <div className="keys-empty"><span className="keys-empty-icon" aria-hidden="true"><Icon name="users-round" size={22} /></span><p>{KEYS_PAGE_COPY.teamSignedOut}</p></div>
  if (teams.length === 0 || !teamId) return <div className="keys-empty"><span className="keys-empty-icon" aria-hidden="true"><Icon name="users-round" size={22} /></span><p>{KEYS_PAGE_COPY.teamNoTeams}</p></div>

  const team = teams.find((candidate) => candidate.id === teamId)
  const shareable = personalKeysToShare(personal, keys)
  const toggleChip = (key: TeamKey, chip: KeySkillChip): void => {
    setBusyChip(`${key.key}:${chip.id}`)
    void run(async (current) => { await setTeamKeyExclusion(teamId, key.key, chip.id, chip.enabled, current.userId) },
      chip.enabled ? `${chip.name} 已停用团队的 ${key.key}` : `${chip.name} 已启用团队的 ${key.key}`).finally(() => setBusyChip(null))
  }

  return <div className="keys-team" aria-busy={state?.status === 'loading' || busy}>
    <div className="keys-team-bar">
      <span className="keys-team-label" id="keys-team-picker-label">团队</span>
      {teams.length <= 3
        ? <SegmentedControl mode="radiogroup" size="sm" aria-label="选择团队" value={teamId} onChange={setTeamId} options={teams.map((item) => ({ value: item.id, label: item.name }))} />
        : <select className="compact-select" aria-labelledby="keys-team-picker-label" value={teamId} onChange={(event) => setTeamId(event.target.value)}>{teams.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>}
      <span className="keys-team-line">{team ? teamMembersLine(team.memberCount) : KEYS_PAGE_COPY.teamAnyMember}</span>
      <MenuButton
        label={KEYS_PAGE_COPY.putMine}
        className="btn btn-primary btn-sm"
        align="end"
        disabled={busy || state?.status !== 'ready' || shareable.length === 0}
        title={shareable.length === 0 ? KEYS_PAGE_COPY.putMineEmpty : undefined}
        items={shareable.map((key) => ({ id: key, label: key, icon: 'key-round', onSelect: () => void run(async (current) => { await putTeamKey(teamId, key, current.userId) }, `${key} 已放进${team?.name ?? '团队'}`) }))}
      ><Icon name="plus" size={13} />{KEYS_PAGE_COPY.putMine}</MenuButton>
    </div>
    {state?.status === 'error' && (isTeamKeysUnavailable(state.error)
      ? <p className="share-key-note keys-team-unavailable" role="status"><Icon name="info" size={14} /><span>{TEAM_KEYS_UNAVAILABLE}</span></p>
      : <LoadError message={loadFailedMessage('团队钥匙', state.error)} onRetry={() => void reload()} />)}
    {(!state || state.status === 'loading' || state.status === 'idle') && <SkeletonBlock layout="rows" count={2} label={LOADING_COPY.keys} />}
    {state?.status === 'ready' && keys.length === 0 && <div className="keys-empty"><span className="keys-empty-icon" aria-hidden="true"><Icon name="key-round" size={22} /></span><p>{KEYS_PAGE_COPY.teamEmpty}</p></div>}
    {state?.status === 'ready' && keys.length > 0 && <div className="keys-cards">
      {keys.map((key) => {
        const view = teamKeyCardView(key)
        const open = expanded === key.key
        const replaceable = canReplaceFromVault(personal, key.key)
        const replaceOpen = view.canManage && replacing === key.key
        const replacePanelId = `team-key-${key.key}-replace`
        return <KeyCard
          key={key.key}
          id={`team-key-${key.key}`}
          tone="team"
          open={open}
          onToggle={() => setExpanded(open ? null : key.key)}
          names={<KeyNames name={view.key} aliases={view.aliases} />}
          meta={<><UserChip name={view.holder} me={view.holderId === accountUserId} /> 放的钥匙 · {view.revision} · 最近使用 {view.lastUsed}</>}
          summary={view.summary}
          actions={view.canManage ? <>
            <button type="button" className="btn btn-ghost btn-sm" aria-label={`${KEYS_PAGE_COPY.teamReplace}：${key.key}`} aria-expanded={replaceOpen} aria-controls={replaceOpen ? replacePanelId : undefined} disabled={busy} onClick={() => setReplacing(replaceOpen ? null : key.key)}>{KEYS_PAGE_COPY.teamReplace}</button>
            <button type="button" className="btn btn-ghost btn-sm key-menu-danger" aria-label={`${KEYS_PAGE_COPY.revoke}：${key.key}`} title={KEYS_PAGE_COPY.teamRevokeHint} disabled={busy} onClick={() => setRevoking(key.key)}>{KEYS_PAGE_COPY.revoke}</button>
          </> : undefined}
          panel={replaceOpen ? <div className="key-req-panel" id={replacePanelId} role="group" aria-label={`${KEYS_PAGE_COPY.teamReplace}：${key.key}`}>
            <p className="key-req-hint">{KEYS_PAGE_COPY.teamReplaceHint}</p>
            <p className="key-req-hint">{replaceable ? KEYS_PAGE_COPY.teamReplaceSource : KEYS_PAGE_COPY.teamReplaceNeedsMine}{replaceable && view.holderId !== accountUserId ? ` ${KEYS_PAGE_COPY.teamReplaceHolder}` : ''}</p>
            <div className="key-req-panel-actions">
              <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setReplacing(null)}>取消</button>
              {replaceable && <button type="button" className="btn btn-soft btn-sm" disabled={busy} onClick={() => void run(async (current) => { await putTeamKey(teamId, key.key, current.userId); setReplacing(null) }, `团队的 ${key.key} 已换成新值`)}>{KEYS_PAGE_COPY.teamReplaceFromMine}</button>}
            </div>
          </div> : undefined}
        >
          <KeySkillSection title={KEYS_PAGE_COPY.teamSkillsTitle} hint={view.canManage ? KEYS_PAGE_COPY.skillsHint : KEYS_PAGE_COPY.teamReadOnlyHint}>
            {view.chips.length === 0
              ? <p className="key-card-empty">{KEYS_PAGE_COPY.noSkills}</p>
              : <div className="key-skill-list">{view.chips.map((chip) => <KeySkillChipButton key={chip.id} chip={chip} readOnly={!view.canManage} busy={busyChip === `${key.key}:${chip.id}`} onToggle={(target) => toggleChip(key, target)} />)}</div>}
          </KeySkillSection>
          {view.canManage && <KeySkillSection title={KEYS_PAGE_COPY.usageTitle} hint={KEYS_PAGE_COPY.usageHint}>
            {usageError
              ? <LoadError message={loadFailedMessage('使用记录', usageError)} onRetry={() => void loadUsage(key.key)} />
              : usage?.key !== key.key
              ? <SkeletonBlock layout="rows" count={2} compact label={LOADING_COPY.keys} />
              : usage.usage.length === 0
              ? <p className="key-card-empty">{KEYS_PAGE_COPY.usageNone}</p>
              : <div className="key-usage-list" role="list">{usage.usage.map((row, index) => {
                const item = usageRowView(row)
                return <div className="key-usage-row" role="listitem" key={`${row.actor?.id ?? 'gone'}:${row.skill?.id ?? 'gone'}:${index}`}>
                  <span><UserChip name={item.actor} me={Boolean(row.actor && row.actor.id === accountUserId)} /></span>
                  <span>{item.skill}</span>
                  <span className="key-usage-count">{item.count}</span>
                  <span className="key-usage-when">{item.when}</span>
                </div>
              })}</div>}
          </KeySkillSection>}
        </KeyCard>
      })}
    </div>}
    {revoking && <ConfirmModal eyebrow="团队钥匙" title={`从团队撤销 ${revoking}？`} description={KEYS_PAGE_COPY.teamRevokeHint} confirmLabel={KEYS_PAGE_COPY.revoke} destructive busy={busy} onCancel={() => setRevoking(null)} onConfirm={() => { const key = revoking; void run(async (current) => { await deleteTeamKey(teamId, key, current.userId); setRevoking(null) }, `${key} 已从团队撤销`) }} />}
  </div>
}
