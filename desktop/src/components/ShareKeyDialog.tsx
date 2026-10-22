import { useCallback, useEffect, useRef, useState } from 'react'
import FocusTrapDialog from './FocusTrapDialog.js'
import ConfirmModal from './ConfirmModal.js'
import { Icon } from './Icon.js'
import { toast } from './Toast.js'
import { apiGetTeamSkills } from '../lib/api.js'
import { readAuthSpace } from '../store/index.js'
import { deleteTeamKey, getKeyVaultSettings, listTeamKeys, listVaultKeys, putTeamKey, type TeamKey } from '../lib/tauri.js'
import { userMessage } from '../lib/user-message.js'
import {
  SHARE_DIALOG_COPY,
  acceptsVaultResponse,
  KEYS_PAGE_COPY,
  keyNames,
  loadKeyVault,
  primaryVaultKey,
  shareVariantOptions,
  shareButtonLabel,
  shareCandidates,
  shareDialogUsage,
  shareFailureLines,
  shareResultMessage,
  shareTeamLine,
  shareTeamState,
  skillInitials,
  teamSkillCountForKey,
} from '../lib/keys.js'
import { useStore } from '../store/index.js'

type TeamFacts = { keys: TeamKey[] | null; skillCount: number | null }

/**
 * 「共享 FAL_KEY 给团队」 (#294 board 6). Lists every team the account is in
 * with its size and how many of its shared Skills declare the key (or an
 * alias); teams already holding the key from you offer 停止共享. Shares run
 * one team at a time; the value is read natively from the account vault.
 */
export default function ShareKeyDialog({ keyName, initialVariant = null, onClose }: {
  keyName: string
  /** #306: the variant whose card opened the dialog (`null` = the default). */
  initialVariant?: string | null
  onClose: () => void
}) {
  const teams = useStore((state) => state.teams)
  const accountUserId = useStore((state) => state.currentUser?.id ?? null)
  const vaultKey = useStore((state) => primaryVaultKey(state.keyVault.keys, keyName))
  const variantOptions = vaultKey ? shareVariantOptions(vaultKey) : []
  const [shareVariant, setShareVariant] = useState<string | null>(() => initialVariant ?? variantOptions.find((option) => option.isDefault)?.id ?? null)
  const names = keyNames(vaultKey ?? { key: keyName })
  const namesId = names.join('|')
  const usage = shareDialogUsage(names)
  const [facts, setFacts] = useState<Record<string, TeamFacts>>({})
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [errors, setErrors] = useState<string[]>([])
  const [stopping, setStopping] = useState<{ id: string; name: string } | null>(null)
  const inFlight = useRef(false)

  const loadTeam = useCallback(async (teamId: string): Promise<void> => {
    const space = readAuthSpace()
    if (!space || !accountUserId) return
    const wanted = namesId.split('|')
    const [keys, skillCount] = await Promise.all([
      listTeamKeys(teamId, accountUserId).then((list) => list.credentials).catch(() => null),
      apiGetTeamSkills(teamId).then((skills) => teamSkillCountForKey(skills, wanted)).catch(() => null),
    ])
    setFacts((current) => ({ ...current, [teamId]: { keys, skillCount } }))
  }, [accountUserId, namesId])

  useEffect(() => {
    for (const team of teams) void loadTeam(team.id)
  }, [loadTeam, teams])

  const toggle = (teamId: string): void => setSelected((current) => {
    const next = new Set(current)
    if (next.has(teamId)) next.delete(teamId)
    else next.add(teamId)
    return next
  })

  const share = async (): Promise<void> => {
    const space = readAuthSpace()
    if (inFlight.current || selected.size === 0) return
    if (!space || !accountUserId) { toast('请重新登录后再试', 'error'); return }
    inFlight.current = true
    setBusy(true)
    setErrors([])
    const succeeded: string[] = []
    const failed: { team: string; error: string }[] = []
    for (const team of teams.filter((candidate) => selected.has(candidate.id))) {
      try {
        await putTeamKey(team.id, keyName, accountUserId, shareVariant)
        succeeded.push(team.name)
      } catch (reason: unknown) {
        failed.push({ team: team.name, error: userMessage(reason) })
      }
      await loadTeam(team.id)
    }
    inFlight.current = false
    setBusy(false)
    const message = shareResultMessage(keyName, succeeded, failed)
    if (failed.length === 0) {
      toast(message)
      onClose()
      return
    }
    toast(message, 'error')
    setErrors(shareFailureLines(failed))
    setSelected(new Set(teams.filter((team) => selected.has(team.id) && failed.some((failure) => failure.team === team.name)).map((team) => team.id)))
  }

  const stopSharing = async (): Promise<void> => {
    const space = readAuthSpace()
    const target = stopping
    if (!target || !space || !accountUserId || inFlight.current) return
    inFlight.current = true
    setBusy(true)
    try {
      await deleteTeamKey(target.id, keyName, accountUserId)
      toast(`已停止向 ${target.name} 共享 ${keyName}`)
      setStopping(null)
      await loadTeam(target.id)
    } catch (reason: unknown) {
      toast(userMessage(reason), 'error')
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  return <>
    <FocusTrapDialog className="modal-layer above-sheet" label={`共享 ${keyName} 给团队`} onEscape={onClose} escapeDisabled={busy || Boolean(stopping)}>
      <div className="modal-card share-key-dialog">
        <div className="modal-head">
          <div><h2>共享 <code className="key-card-name">{keyName}</code> 给团队</h2></div>
          <button type="button" className="ico-btn" onClick={onClose} disabled={busy} aria-label="关闭"><Icon name="x" size={16} /></button>
        </div>
        <div className="share-key-body">
          <p>{SHARE_DIALOG_COPY.stored}</p>
          <p>{usage.before}<code className="key-card-name">{usage.key}</code>{usage.after}</p>
          <p>{SHARE_DIALOG_COPY.trust}</p>
        </div>
        {variantOptions.length > 1 && <fieldset className="key-variant-choices share-key-variant" role="radiogroup" aria-busy={busy}>
          <legend>{KEYS_PAGE_COPY.shareWhich}</legend>
          {variantOptions.map((option) => <label key={option.id ?? ''} className={`key-req-choice${shareVariant === option.id ? ' checked' : ''}`}>
            <input type="radio" name="share-key-variant" checked={shareVariant === option.id} disabled={busy} onChange={() => setShareVariant(option.id)} />
            <span>{option.text}</span>
          </label>)}
        </fieldset>}
        {teams.length === 0
          ? <p className="modal-copy">{SHARE_DIALOG_COPY.noTeams}</p>
          : <fieldset className="share-key-teams" aria-busy={busy}>
            <legend>{SHARE_DIALOG_COPY.teamsLegend}</legend>
            {teams.map((team) => {
              const fact = facts[team.id]
              const state = shareTeamState(fact?.keys ?? null, keyName, accountUserId)
              const line = shareTeamLine(team.memberCount, fact?.skillCount ?? null)
              const avatar = <span className="share-key-team-avatar" aria-hidden="true">{skillInitials(team.name).slice(0, 1)}</span>
              if (state.kind === 'mine') return <div key={team.id} className="share-key-team is-static">
                <Icon name="check" size={16} className="share-key-team-check" />
                {avatar}
                <span className="share-key-team-copy"><b>{team.name}</b><span className="is-mine">{SHARE_DIALOG_COPY.mine}</span></span>
                <button type="button" className="btn btn-ghost btn-sm key-menu-danger" disabled={busy} onClick={() => setStopping({ id: team.id, name: team.name })}>{SHARE_DIALOG_COPY.stopSharing}</button>
              </div>
              const locked = state.kind === 'other' && !state.canManage
              const sub = state.kind === 'other'
                ? state.canManage ? `${line} · 会替换 ${state.holder} 放的钥匙` : `已有 ${state.holder} 放的同名钥匙`
                : line
              const checked = selected.has(team.id)
              return <label key={team.id} className={`share-key-team${checked ? ' is-selected' : ''}${locked ? ' is-disabled' : ''}`}>
                <input type="checkbox" checked={checked} disabled={busy || locked} onChange={() => toggle(team.id)} />
                {avatar}
                <span className="share-key-team-copy"><b>{team.name}</b><span>{sub}</span></span>
              </label>
            })}
          </fieldset>}
        <p className="share-key-note"><Icon name="info" size={14} /><span>{SHARE_DIALOG_COPY.footer}</span></p>
        {errors.length > 0 && <div className="banner banner-error" role="alert"><Icon name="warn" size={14} /><span>{errors.join('；')}</span></div>}
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={onClose}>{SHARE_DIALOG_COPY.cancel}</button>
          <button type="button" className="btn btn-primary" disabled={busy || selected.size === 0} onClick={() => void share()}>{busy ? '共享中…' : shareButtonLabel(selected.size)}</button>
        </div>
      </div>
    </FocusTrapDialog>
    {stopping && <ConfirmModal eyebrow="团队钥匙" title={`停止向 ${stopping.name} 共享 ${keyName}？`} description="团队成员运行 Skill 时将不能再用到这把钥匙；你自己的钥匙不受影响。" confirmLabel={SHARE_DIALOG_COPY.stopSharing} destructive busy={busy} onCancel={() => setStopping(null)} onConfirm={() => void stopSharing()} />}
  </>
}

/**
 * 「共享给团队」 from a Skill's 钥匙 section: one personal key for this
 * Skill opens the dialog straight away, several show a chooser first, none
 * falls back to `onFallback` (the 钥匙 page's 团队 tab).
 */
export function ShareKeyLauncher({ declaredKeys, onClose, onFallback }: {
  declaredKeys: readonly string[]
  onClose: () => void
  onFallback: () => void
}) {
  const accountUserId = useStore((state) => state.currentUser?.id ?? null)
  const vault = useStore((state) => state.keyVault)
  const setKeyVault = useStore((state) => state.setKeyVault)
  const [ready, setReady] = useState(vault.status === 'ready' && vault.accountUserId === accountUserId)
  const [chosen, setChosen] = useState<string | null>(null)
  const [pick, setPick] = useState<string | null>(null)
  const declaredId = declaredKeys.join('|')

  useEffect(() => {
    let active = true
    void loadKeyVault(accountUserId, { listVaultKeys, getKeyVaultSettings }).then((next) => {
      if (!active) return
      if (acceptsVaultResponse(useStore.getState().currentUser?.id ?? null, next)) setKeyVault(next)
      setReady(true)
    })
    return () => { active = false }
  }, [accountUserId, setKeyVault])

  const candidates = ready ? shareCandidates(vault.keys, declaredId.split('|')) : []
  const candidatesId = candidates.join('|')
  const fallbackRef = useRef(onFallback)
  fallbackRef.current = onFallback

  useEffect(() => {
    if (!ready) return
    const keys = candidatesId ? candidatesId.split('|') : []
    if (keys.length === 0) fallbackRef.current()
    else if (keys.length === 1) setChosen(keys[0] ?? null)
  }, [ready, candidatesId])

  if (!ready || candidates.length === 0) return null
  if (chosen) return <ShareKeyDialog keyName={chosen} onClose={onClose} />
  return <FocusTrapDialog className="modal-layer above-sheet" label={SHARE_DIALOG_COPY.chooserTitle} onEscape={onClose}>
    <div className="modal-card compact">
      <div className="modal-head">
        <div><span className="eyebrow">共享给团队</span><h2>{SHARE_DIALOG_COPY.chooserTitle}</h2></div>
        <button type="button" className="ico-btn" onClick={onClose} aria-label="关闭"><Icon name="x" size={16} /></button>
      </div>
      <p className="modal-copy">{SHARE_DIALOG_COPY.chooserHint}</p>
      <fieldset className="share-key-teams share-key-choices">
        <legend className="sr-only">钥匙</legend>
        {candidates.map((key) => <label key={key} className={`share-key-team${pick === key ? ' is-selected' : ''}`}>
          <input type="radio" name="share-key-choice" checked={pick === key} onChange={() => setPick(key)} />
          <code className="key-card-name">{key}</code>
        </label>)}
      </fieldset>
      <div className="modal-actions">
        <button type="button" className="btn btn-ghost" onClick={onClose}>{SHARE_DIALOG_COPY.cancel}</button>
        <button type="button" className="btn btn-primary" disabled={!pick} onClick={() => setChosen(pick)}>下一步</button>
      </div>
    </div>
  </FocusTrapDialog>
}
