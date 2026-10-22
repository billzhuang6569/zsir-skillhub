import { useCallback, useEffect, useRef, useState } from 'react'
import { useSpaceCapabilities } from '../lib/use-space-capabilities.js'
import { emptyStateActions } from '../lib/onboarding.js'
import { useMediaUrl } from '../lib/media.js'
import { useStore } from '../store/index.js'
import { Icon } from '../components/Icon.js'
import { BlankDragSpacer } from '../components/WindowDragRegion.js'
import { PageHeading } from '../components/PageHeading.js'
import { apiCreateTeam, apiGetJoinRequests, apiGetNotifications, apiGetTeam, apiGetTeams, apiRequestJoinTeam } from '../lib/api.js'
import { toast } from '../components/Toast.js'
import type { Team } from '../store/index.js'
import { UserChip } from '../components/UserChip.js'
import FocusTrapDialog from '../components/FocusTrapDialog.js'
import { EmptyState, LoadError, SkeletonBlock } from '../components/StateViews.js'
import { EMPTY_COPY, LOADING_COPY, loadFailedMessage } from '../lib/state-copy.js'
import './TeamsPage.css'
import { partitionTeams, teamErrorMessage } from '../lib/ui-helpers.js'

type TeamDialog = 'create' | 'join' | null
const COLORS = ['#1859e6', '#7c5cf0', '#0ea968', '#e08a1e', '#e0509e']

function TeamAvatar({ team, compact = false }: { team: Team; compact?: boolean }) {
  const imageUrl = useMediaUrl(team.avatarUrl)
  const [avatarFailed, setAvatarFailed] = useState(false)
  useEffect(() => setAvatarFailed(false), [imageUrl])
  return <span className={`team-avatar${compact ? ' compact' : ''}`} style={{ background: team.color }}>
    <span>{team.name.trim().slice(0, 1) || 'T'}</span>
    {imageUrl && !avatarFailed && <img src={imageUrl} alt="" onError={() => setAvatarFailed(true)} />}
  </span>
}

type TeamOwner = { id: string; displayName: string; avatarUrl?: string | null }

/** `N 成员 · N 个共享 Skill · N 把钥匙` (keys only when the Server reports any). */
export function teamMetaText(team: Pick<Team, 'memberCount' | 'sharedCount' | 'credentialCount'>): string {
  const parts = [`${team.memberCount} 成员`, `${team.sharedCount} 个共享 Skill`]
  if (team.credentialCount) parts.push(`${team.credentialCount} 把钥匙`)
  return parts.join(' · ')
}

function TeamListRow({ team, owner, pending, currentUserId, active }: { team: Team; owner?: TeamOwner; pending: number; currentUserId: string | null; active: boolean }) {
  const openTeamSheet = useStore((state) => state.openTeamSheet)
  return <button type="button" className={`team-list-row${active ? ' active' : ''}`} aria-current={active ? 'true' : undefined} onClick={() => openTeamSheet(team.id)}>
    <TeamAvatar team={team} compact />
    <span className="team-list-copy">
      <span className="team-list-name">{team.name}</span>
      <span className="team-list-meta">{teamMetaText(team)}{team.role === 'member' && owner && <> · 创建者 <UserChip name={owner.displayName} me={owner.id === currentUserId} avatarUrl={owner.avatarUrl} /></>}</span>
    </span>
    {team.role === 'owner' && pending > 0 && <span className="team-list-pending" aria-label={`${pending} 个待处理申请`}>{pending > 99 ? '99+' : pending}</span>}
    <Icon name="right" size={14} />
  </button>
}

export default function TeamsPage() {
  const { teams, setTeams, setNotifications, currentUser, sheet } = useStore()
  const [dialog, setDialog] = useState<TeamDialog>(null)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [color, setColor] = useState(COLORS[0])
  const [teamId, setTeamId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [owners, setOwners] = useState<Record<string, TeamOwner>>({})
  const ownersRef = useRef<Record<string, TeamOwner>>({})
  const [pendingRequests, setPendingRequests] = useState<Record<string, number>>({})
  const [loadingTeams, setLoadingTeams] = useState(true)
  const [teamLoadError, setTeamLoadError] = useState<string | null>(null)
  const mountedRef = useRef(true)
  const teamLoadInFlight = useRef<Promise<boolean> | null>(null)
  const { owned: myTeams, joined: joinedTeams } = partitionTeams(teams)
  const openTeamId = sheet?.kind === 'team' ? sheet.teamId : null

  const loadTeams = useCallback((): Promise<boolean> => {
    if (teamLoadInFlight.current) return teamLoadInFlight.current
    if (mountedRef.current) {
      setLoadingTeams(true)
      setTeamLoadError(null)
    }
    const request = apiGetTeams()
      .then((freshTeams) => {
        if (mountedRef.current) {
          setTeams(freshTeams)
          setTeamLoadError(null)
        }
        return true
      })
      .catch((reason: unknown) => {
        if (mountedRef.current) setTeamLoadError(teamErrorMessage(reason))
        return false
      })
    teamLoadInFlight.current = request
    void request.finally(() => {
      if (teamLoadInFlight.current === request) teamLoadInFlight.current = null
      if (mountedRef.current) setLoadingTeams(false)
    })
    return request
  }, [setTeams])

  useEffect(() => {
    mountedRef.current = true
    void loadTeams()
    return () => { mountedRef.current = false }
  }, [loadTeams])

  // Joined rows name the creator; owned rows count pending join requests (#295 board 8).
  // Re-read on every team list refresh, so approving a request in the detail clears the badge.
  useEffect(() => {
    if (!currentUser) return
    let active = true
    const expectedUserId = currentUser.id
    const owned = teams.filter((team) => team.role === 'owner')
    // A creator never changes, so each joined team's detail is read once.
    const joined = teams.filter((team) => team.role === 'member' && !ownersRef.current[team.id])
    void Promise.allSettled(owned.map((team) => apiGetJoinRequests(team.id))).then((results) => {
      if (!active || useStore.getState().currentUser?.id !== expectedUserId) return
      const counts: Record<string, number> = {}
      results.forEach((result, index) => {
        const team = owned[index]
        if (team && result.status === 'fulfilled') counts[team.id] = result.value.filter((request) => request.status === 'pending' || !request.status).length
      })
      setPendingRequests(counts)
    })
    void Promise.allSettled(joined.map((team) => apiGetTeam(team.id))).then((results) => {
      if (!active || useStore.getState().currentUser?.id !== expectedUserId) return
      const found: Record<string, TeamOwner> = { ...ownersRef.current }
      results.forEach((result, index) => {
        const team = joined[index]
        if (team && result.status === 'fulfilled' && result.value.owner) found[team.id] = { id: result.value.owner.id, displayName: result.value.owner.displayName, avatarUrl: result.value.owner.avatarUrl }
      })
      ownersRef.current = found
      setOwners(found)
    })
    return () => { active = false }
  }, [currentUser?.id, teams])

  useEffect(() => {
    if (!dialog || busy) return
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setDialog(null)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [busy, dialog])

  const refresh = async (): Promise<void> => {
    const [, notificationsResult] = await Promise.allSettled([loadTeams(), apiGetNotifications()])
    if (notificationsResult.status === 'fulfilled') {
      setNotifications(notificationsResult.value)
    } else {
      toast(`通知刷新失败：${teamErrorMessage(notificationsResult.reason)}`, 'error')
    }
  }
  const openDialog = (kind: Exclude<TeamDialog, null>): void => {
    setDialog(kind); setName(''); setDescription(''); setTeamId(''); setColor(COLORS[0]); setError(null)
  }
  const create = async (): Promise<void> => {
    if (!name.trim()) return
    setBusy(true); setError(null)
    try {
      const created = await apiCreateTeam({ name: name.trim(), description: description.trim() || undefined, color })
      await refresh(); setDialog(null); toast(`团队「${created.name}」已创建`)
    } catch (reason: unknown) { setError(teamErrorMessage(reason)) } finally { setBusy(false) }
  }
  const join = async (): Promise<void> => {
    if (!teamId.trim()) return
    setBusy(true); setError(null)
    try {
      await apiRequestJoinTeam(teamId.trim())
      setDialog(null); toast('加入申请已提交，等待团队 Owner 审批')
    } catch (reason: unknown) { setError(teamErrorMessage(reason)) } finally { setBusy(false) }
  }
  return <>
    <PageHeading title="My Team" subtitle="管理团队、成员与共享 Skill" actions={<><BlankDragSpacer /><button className="btn btn-ghost" onClick={() => openDialog('join')}><Icon name="user-plus" size={14} />加入团队</button><button className="btn btn-primary" onClick={() => openDialog('create')}><Icon name="plus" size={14} />创建</button></>} />
    <div className="page-body teams-page-body">
      {teamLoadError && <LoadError message={loadFailedMessage('团队数据', teamLoadError)} retrying={loadingTeams} onRetry={() => void loadTeams()} />}
      {loadingTeams && teams.length === 0 ? <SkeletonBlock layout="cards" label={LOADING_COPY.teams} /> : <>
      <section className="team-list-group" aria-labelledby="team-group-owned">
        <h2 id="team-group-owned" className="team-list-heading">我创建的 · {myTeams.length}</h2>
        {myTeams.length === 0 ? <TeamEmpty onCreate={() => openDialog('create')} /> : <div className="team-list">{myTeams.map((team) => <TeamListRow key={team.id} team={team} pending={pendingRequests[team.id] ?? 0} currentUserId={currentUser?.id ?? null} active={openTeamId === team.id} />)}</div>}
      </section>
      <section className="team-list-group" aria-labelledby="team-group-joined">
        <h2 id="team-group-joined" className="team-list-heading">已加入的 · {joinedTeams.length}</h2>
        {joinedTeams.length === 0 ? <div className="team-list-empty"><Icon name="team" size={18} /><span><b>{EMPTY_COPY.teamsJoinedNone.title}</b>{EMPTY_COPY.teamsJoinedNone.hint}</span><button type="button" className="btn btn-ghost btn-sm" onClick={() => openDialog('join')}><Icon name="user-plus" size={13} />使用团队 ID 加入</button></div> : <div className="team-list">{joinedTeams.map((team) => <TeamListRow key={team.id} team={team} owner={owners[team.id]} pending={0} currentUserId={currentUser?.id ?? null} active={openTeamId === team.id} />)}</div>}
      </section>
      </>}
    </div>

    {dialog && <FocusTrapDialog className="modal-layer" label={dialog === 'create' ? '创建团队' : '加入团队'} onEscape={() => setDialog(null)} escapeDisabled={busy}><div className="modal-card compact"><div className="modal-head"><div><span className="eyebrow">团队管理</span><h2>{dialog === 'create' ? '创建团队' : '加入团队'}</h2></div><button className="ico-btn" aria-label="关闭团队对话框" onClick={() => !busy && setDialog(null)}><Icon name="x" size={16} /></button></div>
      {dialog === 'create' ? <div className="form-stack"><label>团队名称<input value={name} maxLength={40} onChange={(event) => setName(event.target.value)} autoFocus /></label><label>团队说明<textarea value={description} maxLength={200} rows={3} onChange={(event) => setDescription(event.target.value)} /></label><div><span className="form-label">团队颜色</span><div className="color-options">{COLORS.map((value) => <button key={value} className={color === value ? 'selected' : ''} style={{ background: value }} onClick={() => setColor(value)} aria-label={`选择颜色 ${value}`} />)}</div></div></div> : <div className="form-stack"><p className="modal-copy">输入 Owner 提供的团队 ID。申请会真实写入服务端，Owner 可在团队详情中审批。</p><label>团队 ID<input value={teamId} onChange={(event) => setTeamId(event.target.value)} autoFocus placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" /></label></div>}
      {error && <div className="banner banner-error"><Icon name="warn" size={14} />{error}</div>}<div className="modal-actions"><button className="btn btn-ghost" onClick={() => setDialog(null)} disabled={busy}>取消</button><button className="btn btn-primary" onClick={() => void (dialog === 'create' ? create() : join())} disabled={busy || (dialog === 'create' ? !name.trim() : !teamId.trim())}>{busy ? '处理中…' : dialog === 'create' ? '创建' : '提交申请'}</button></div>
    </div></FocusTrapDialog>}
  </>
}

function TeamEmpty({ onCreate }: { onCreate: () => void }) {
  const capabilities = useSpaceCapabilities()
  return <EmptyState copy={EMPTY_COPY.teamsOwnedNone} icon="team">{emptyStateActions(capabilities, 'teams').includes('create-team') && <button className="btn btn-primary" onClick={onCreate}><Icon name="plus" size={14} />创建团队</button>}</EmptyState>
}
