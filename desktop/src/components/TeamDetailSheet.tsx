import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Icon, type IconName } from './Icon.js'
import { useMediaUrl } from '../lib/media.js'
import { SkillAvatarIcon } from './SkillAvatarIcon.js'
import { UserChip } from './UserChip.js'
import { useStore } from '../store/index.js'
import {
  apiApproveJoinRequest, apiDissolveTeam, apiGetJoinRequests, apiGetNotifications,
  apiGetTeam, apiGetTeamSkills, apiGetTeams, apiKickMember,
  apiLeaveTeam, apiRejectJoinRequest, apiUnshareSkill, apiUpdateTeam,
} from '../lib/api.js'
import type {
  ApiJoinRequest, ApiSkill, ApiTeamDetail, ApiUser,
} from '../lib/api.js'
import { listTeamKeys, type TeamKey } from '../lib/tauri.js'
import { readAuthSpace } from '../store/index.js'
import { toast } from './Toast.js'
import AvatarUploader from './AvatarUploader.js'
import ConfirmModal from './ConfirmModal.js'
import FocusTrapDialog from './FocusTrapDialog.js'
import { nextRovingIndex, settledCollection, teamErrorMessage } from '../lib/ui-helpers.js'
import TeamInviteCreatorDialog from './TeamInviteCreatorDialog.js'
import TeamActivityFeed from './TeamActivityFeed.js'
import { skillListText } from '../lib/skill-title.js'
import { notificationTimeLabel } from '../lib/notification-center.js'
import { LoadError, SkeletonBlock } from './StateViews.js'
import { EMPTY_COPY, LOADING_COPY, RETRY_LABEL, loadFailedMessage } from '../lib/state-copy.js'
import './TeamDetailSheet.css'

type TeamConfirmation =
  | { type: 'remove'; userId: string; displayName: string }
  | { type: 'unshare'; skillId: string; displayName: string }
  | { type: 'exit' }
  | null

type TeamDetailTab = 'members' | 'skills' | 'keys' | 'activity'

type TeamKeysState =
  | { status: 'idle' | 'loading' }
  | { status: 'ready'; keys: TeamKey[] }
  | { status: 'error'; error: string }

function displayText(value: string | null | undefined, fallback: string): string {
  const text = value?.trim()
  return text ? text : fallback
}

function accountIdentityText(email: string | null | undefined, fallback: string): string {
  const text = email?.trim()
  return text ? `${text} · 邮箱未验证` : fallback
}

function initialOf(value: string | null | undefined): string {
  return Array.from(displayText(value, 'T'))[0]?.toLocaleUpperCase() ?? 'T'
}

function Avatar({ user, fallbackName, className = '' }: { user?: ApiUser; fallbackName: string; className?: string }) {
  const url = useMediaUrl(user?.avatarUrl)
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [url])
  const name = displayText(user?.displayName, fallbackName)
  return <span className={`team-person-avatar ${className}`} aria-label={`${name}的头像`}>
    {url && !failed
      ? <img src={url} alt="" onError={() => setFailed(true)} />
      : <span aria-hidden="true">{initialOf(name)}</span>}
  </span>
}

function TeamAvatar({ name, avatarUrl, color }: { name: string; avatarUrl?: string | null; color?: string }) {
  const url = useMediaUrl(avatarUrl)
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [url])
  return <span className="team-detail-avatar" style={{ background: color || 'var(--color-brand)' }} aria-label={`${displayText(name, '团队')}的头像`}>
    {url && !failed
      ? <img src={url} alt="" onError={() => setFailed(true)} />
      : <span aria-hidden="true">{initialOf(name)}</span>}
  </span>
}

export default function TeamDetailSheet({ teamId }: { teamId: string }) {
  const {
    teams, setTeams, setNotifications,
    activeTeamId, closeSheet, setView, setActiveTeam, currentUser, skillTitlePreference, setKeysPageIntent,
  } = useStore()
  const summary = teams.find((team) => team.id === teamId)
  const isActive = activeTeamId === teamId
  const [detail, setDetail] = useState<ApiTeamDetail | null>(null)
  const [requests, setRequests] = useState<ApiJoinRequest[]>([])
  const [skills, setSkills] = useState<ApiSkill[]>([])
  const [skillsError, setSkillsError] = useState<string | null>(null)
  const [requestsError, setRequestsError] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmation, setConfirmation] = useState<TeamConfirmation>(null)
  const [inviteOpen, setInviteOpen] = useState(false)
  const [tab, setTab] = useState<TeamDetailTab>('members')
  const [moreOpen, setMoreOpen] = useState(false)
  const [teamKeys, setTeamKeys] = useState<TeamKeysState>({ status: 'idle' })
  const moreRef = useRef<HTMLDivElement>(null)
  const moreButtonRef = useRef<HTMLButtonElement>(null)
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([])

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      const team = await apiGetTeam(teamId)
      const loadedAsOwner = team.ownerId === currentUser?.id
      const [skillsResult, requestsResult] = await Promise.allSettled([
        apiGetTeamSkills(teamId),
        loadedAsOwner ? apiGetJoinRequests(teamId) : Promise.resolve([]),
      ])
      const loadedSkills = settledCollection(skillsResult)
      const loadedRequests = settledCollection(requestsResult)
      setDetail(team)
      setName(team.name ?? '')
      setDescription(team.description ?? '')
      setSkills(loadedSkills.items)
      setRequests(loadedRequests.items)
      setSkillsError(loadedSkills.error ? teamErrorMessage(loadedSkills.error) : null)
      setRequestsError(loadedRequests.error ? teamErrorMessage(loadedRequests.error) : null)
    } catch (reason: unknown) {
      setError(teamErrorMessage(reason))
    } finally {
      setLoading(false)
    }
  }, [currentUser?.id, teamId])

  useEffect(() => {
    setDetail(null)
    setSkills([])
    setRequests([])
    setSkillsError(null)
    setRequestsError(null)
    setTab('members')
    setTeamKeys({ status: 'idle' })
    setMoreOpen(false)
    void load()
  }, [load])

  // 钥匙 tab: names and holders only, read through the native layer (#254); loaded on first open.
  const loadTeamKeys = useCallback(async (): Promise<void> => {
    const space = readAuthSpace()
    const accountUserId = currentUser?.id
    if (!space || !accountUserId) {
      setTeamKeys({ status: 'error', error: '登录后查看团队钥匙' })
      return
    }
    setTeamKeys({ status: 'loading' })
    try {
      const list = await listTeamKeys(teamId, accountUserId)
      if (useStore.getState().currentUser?.id !== accountUserId || readAuthSpace() !== space) return
      setTeamKeys({ status: 'ready', keys: list.credentials })
    } catch (reason: unknown) {
      setTeamKeys({ status: 'error', error: teamErrorMessage(reason) })
    }
  }, [currentUser?.id, teamId])

  useEffect(() => {
    if (tab === 'keys' && teamKeys.status === 'idle') void loadTeamKeys()
  }, [loadTeamKeys, tab, teamKeys.status])

  useEffect(() => {
    if (!moreOpen) return
    const closeOutside = (event: PointerEvent): void => {
      if (!moreRef.current?.contains(event.target as Node)) setMoreOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      setMoreOpen(false)
      moreButtonRef.current?.focus()
    }
    document.addEventListener('pointerdown', closeOutside)
    window.addEventListener('keydown', closeOnEscape)
    moreRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus()
    return () => {
      document.removeEventListener('pointerdown', closeOutside)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [moreOpen])

  const refreshGlobalData = useCallback(async (): Promise<void> => {
    const [teamsResult, notificationsResult] = await Promise.allSettled([
      apiGetTeams(), apiGetNotifications(),
    ])
    if (teamsResult.status === 'fulfilled') setTeams(teamsResult.value)
    if (notificationsResult.status === 'fulfilled') setNotifications(notificationsResult.value)
  }, [setNotifications, setTeams])

  const refreshAll = async (): Promise<void> => {
    await Promise.all([load(), refreshGlobalData()])
  }

  const cancelEditing = (): void => {
    setName(detail?.name ?? '')
    setDescription(detail?.description ?? '')
    setEditing(false)
  }

  const save = async (): Promise<void> => {
    const normalizedName = name.trim()
    if (!normalizedName) return
    setBusy(true)
    setError(null)
    try {
      await apiUpdateTeam(teamId, {
        name: normalizedName,
        description: description.trim(),
      })
      await refreshAll()
      setEditing(false)
      toast('团队信息已更新')
    } catch (reason: unknown) {
      setError(teamErrorMessage(reason))
    } finally {
      setBusy(false)
    }
  }

  const persistTeamAvatar = async (avatarUrl: string | null): Promise<void> => {
    if (!detail || detail.ownerId !== currentUser?.id) {
      throw new Error('只有团队创建者可以修改团队头像')
    }
    setBusy(true)
    setError(null)
    try {
      await apiUpdateTeam(teamId, { avatarUrl })
      await refreshAll()
      toast(avatarUrl ? '团队头像已更新' : '团队头像已移除')
    } finally {
      setBusy(false)
    }
  }

  const resolveRequest = async (requestId: string, approve: boolean): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await (approve
        ? apiApproveJoinRequest(teamId, requestId)
        : apiRejectJoinRequest(teamId, requestId))
      await refreshAll()
      toast(approve ? '申请已批准' : '申请已拒绝')
    } catch (reason: unknown) {
      setError(teamErrorMessage(reason))
    } finally {
      setBusy(false)
    }
  }

  const removeMember = async (userId: string): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await apiKickMember(teamId, userId)
      await refreshAll()
      setConfirmation(null)
      toast('成员已移除')
    } catch (reason: unknown) {
      setError(teamErrorMessage(reason))
    } finally {
      setBusy(false)
    }
  }

  const removeSharedSkill = async (skillId: string): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await apiUnshareSkill(skillId, teamId)
      await refreshAll()
      setConfirmation(null)
      toast('Skill 已移出团队')
    } catch (reason: unknown) {
      setError(teamErrorMessage(reason))
    } finally {
      setBusy(false)
    }
  }

  const exitTeam = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await (isOwner ? apiDissolveTeam(teamId) : apiLeaveTeam(teamId))
      if (isActive) setActiveTeam(null)
      await refreshGlobalData()
      closeSheet()
      toast(isOwner ? '团队已解散' : '已退出团队')
    } catch (reason: unknown) {
      setError(teamErrorMessage(reason))
    } finally {
      setBusy(false)
    }
  }

  const switchToTeam = (): void => {
    setActiveTeam(teamId)
    toast(`已切换到「${displayText(detail?.name ?? summary?.name, '团队')}」`)
  }

  const openSharedSkills = (): void => {
    setActiveTeam(teamId)
    setView('team-skills')
    closeSheet()
  }

  const manageKeys = (): void => {
    setActiveTeam(teamId)
    setKeysPageIntent({ tab: 'team' })
    setView('keys')
  }

  const copyTeamId = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(teamId)
      toast('团队 ID 已复制')
    } catch (reason: unknown) {
      toast(`复制失败：${teamErrorMessage(reason)}`, 'error')
    }
  }

  const teamName = displayText(detail?.name ?? summary?.name, '未命名团队')
  const teamDescription = displayText(detail?.description ?? summary?.description, '暂无团队简介')
  const teamColor = detail?.color ?? summary?.color ?? 'var(--color-brand)'
  const teamAvatarUrl = detail?.avatarUrl ?? summary?.avatarUrl
  const isOwner = detail ? detail.ownerId === currentUser?.id : summary?.role === 'owner'
  const keyCount = teamKeys.status === 'ready' ? teamKeys.keys.length : detail?.credentialCount ?? summary?.credentialCount
  const tabs: { key: TeamDetailTab; label: string; icon: IconName; count?: number }[] = [
    { key: 'members', label: '成员', icon: 'users-round', count: detail?.members.length },
    { key: 'skills', label: '共享 Skill', icon: 'shared-skills', count: skillsError ? undefined : skills.length },
    { key: 'keys', label: '钥匙', icon: 'key-round', count: keyCount },
    { key: 'activity', label: '动态', icon: 'activity' },
  ]
  const moreLabel = isOwner ? '更多：编辑资料、解散团队' : '更多：退出团队'

  const onTabKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number): void => {
    const next = nextRovingIndex(index, tabs.length, event.key, 'horizontal')
    if (next === null) return
    event.preventDefault()
    const target = tabs[next]
    if (!target) return
    setTab(target.key)
    tabRefs.current[next]?.focus()
  }

  return <>
    <FocusTrapDialog className="detail-sheet team-detail-sheet on pop-in" label={`${teamName} 团队详情`} onEscape={closeSheet} escapeDisabled={moreOpen}>
      <div className="team-detail-header">
        <button className="ico-btn sh-close" onClick={closeSheet} aria-label="关闭团队详情"><Icon name="x" size={17} /></button>
        <div className="team-detail-identity">
          {isOwner
            ? <AvatarUploader
                avatarUrl={teamAvatarUrl}
                fallbackText={teamName}
                label="团队头像"
                size="large"
                fallbackColor={teamColor}
                className="team-detail-avatar-uploader"
                disabled={busy || !detail}
                onPersist={persistTeamAvatar}
                onError={(message) => { setError(message); toast(`团队头像更新失败：${message}`, 'error') }}
              />
            : <TeamAvatar name={teamName} avatarUrl={teamAvatarUrl} color={teamColor} />}
          <div className="team-detail-title">
            <h2>{teamName}</h2>
            <p>{teamDescription}</p>
            <div className="team-detail-meta">
              <span className={`chip ${isOwner ? 'chip-accent' : ''}`}>{isOwner ? '我创建的团队' : '已加入团队'}</span>
              {isActive
                ? <span className="chip">当前团队</span>
                : <button type="button" className="chip chip-button" onClick={switchToTeam}>设为当前团队</button>}
              {!isOwner && detail?.owner && <span className="team-owner-inline">创建者<UserChip name={displayText(detail.owner.displayName, '创建者')} avatarUrl={detail.owner.avatarUrl} /></span>}
              <button type="button" className="chip chip-button team-id-chip" aria-label={`复制团队 ID ${teamId}`} onClick={() => void copyTeamId()}><span className="mono">ID {teamId.slice(0, 6)}…</span><Icon name="copy" size={12} /></button>
            </div>
          </div>
          <div className="team-detail-actions">
            {isOwner && <button className="btn btn-primary" type="button" disabled={!detail} onClick={() => setInviteOpen(true)}><Icon name="user-plus" size={14} />邀请成员</button>}
            <div className="team-more" ref={moreRef}>
              <button ref={moreButtonRef} type="button" className="btn btn-ghost team-more-trigger" aria-label={moreLabel} title={moreLabel} aria-haspopup="menu" aria-expanded={moreOpen} disabled={!detail} onClick={() => setMoreOpen((open) => !open)}><Icon name="more" size={16} /></button>
              {moreOpen && <div className="team-more-menu" role="menu" aria-label="团队操作">
                {isOwner
                  ? <>
                      <button type="button" role="menuitem" onClick={() => { setMoreOpen(false); setEditing(true) }}><Icon name="pencil" size={14} />{'编辑资料'}</button>
                      <button type="button" role="menuitem" className="danger" onClick={() => { setMoreOpen(false); setConfirmation({ type: 'exit' }) }}><Icon name="trash" size={14} />解散团队</button>
                    </>
                  : <button type="button" role="menuitem" className="danger" onClick={() => { setMoreOpen(false); setConfirmation({ type: 'exit' }) }}><Icon name="log-out" size={14} />退出团队</button>}
              </div>}
            </div>
          </div>
        </div>
        <div className="team-tabs" role="tablist" aria-label="团队详情">
          {tabs.map((item, index) => <button
            key={item.key}
            ref={(element) => { tabRefs.current[index] = element }}
            type="button"
            role="tab"
            id={`team-detail-tab-${item.key}`}
            aria-selected={tab === item.key}
            aria-controls={`team-detail-panel-${item.key}`}
            tabIndex={tab === item.key ? 0 : -1}
            className={`team-tab${tab === item.key ? ' on' : ''}`}
            onClick={() => setTab(item.key)}
            onKeyDown={(event) => onTabKeyDown(event, index)}
          >
            <Icon name={item.icon} size={15} />
            <span>{item.label}</span>
            {item.count !== undefined && <span className="team-tab-count">{item.count}</span>}
          </button>)}
        </div>
      </div>

      <div className="sh-body team-detail-body" id={`team-detail-panel-${tab}`} role="tabpanel" aria-labelledby={`team-detail-tab-${tab}`}>
        {error && <div className="banner banner-error"><Icon name="warn" size={14} /><div>{error}{!detail && <button className="link-button" onClick={() => void load()}>{RETRY_LABEL}</button>}</div></div>}
        {loading && !detail ? <SkeletonBlock layout="detail" label={LOADING_COPY.teamDetail} /> : detail && <>
          {isOwner && editing && <section className="sh-panel team-edit-panel">
            <div className="panel-title-row"><div><h3>团队资料</h3><p>编辑名称与简介；点击上方团队头像可直接更换图片。</p></div><span className="chip chip-accent">编辑模式</span></div>
            <div className="team-edit-grid">
              <label>团队名称<input value={name} maxLength={40} onChange={(event) => setName(event.target.value)} /></label>
              <label className="team-edit-description">团队简介<textarea rows={3} maxLength={200} value={description} onChange={(event) => setDescription(event.target.value)} /></label>
            </div>
            <div className="modal-actions"><button className="btn btn-ghost" onClick={cancelEditing} disabled={busy}>取消</button><button className="btn btn-primary" disabled={busy || !name.trim()} onClick={() => void save()}>{busy ? '保存中…' : '保存资料'}</button></div>
          </section>}

          {tab === 'members' && <>
            {isOwner && requestsError && <LoadError message={loadFailedMessage('加入申请', requestsError)} retrying={loading} onRetry={() => void load()} />}
            {isOwner && !requestsError && requests.length > 0 && <div className="team-request-list">{requests.map((request) => {
              const applicantName = displayText(request.applicant?.displayName, '未命名申请人')
              return <article key={request.id} className="team-request-row">
                <Avatar user={request.applicant} fallbackName={applicantName} className="request" />
                <div><b><UserChip name={applicantName} avatarUrl={request.applicant?.avatarUrl} /> 申请加入团队</b><span>{accountIdentityText(request.applicant?.email, request.applicantId)} · {notificationTimeLabel(Date.parse(request.createdAt))}</span></div>
                <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void resolveRequest(request.id, false)}>拒绝</button>
                <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => void resolveRequest(request.id, true)}>批准</button>
              </article>
            })}</div>}
            <div className="team-member-list">{detail.members.map((member) => {
              const memberName = displayText(member.user?.displayName, '未命名成员')
              const self = member.userId === currentUser?.id
              return <div key={member.userId} className="team-member-row">
                <Avatar user={member.user} fallbackName={memberName} />
                <div className="team-member-copy"><b>{self ? <UserChip name={`${memberName}（你）`} className="user-chip-me" /> : <UserChip name={memberName} />}</b><span>{accountIdentityText(member.user?.email, member.userId)}</span></div>
                <span className={`team-role-chip${member.role === 'owner' ? ' owner' : ''}`}>{member.role === 'owner' ? '创建者' : '成员'}</span>
                {isOwner && member.role !== 'owner' && !self && <button className="link-button team-member-remove" disabled={busy} aria-label={`移出 ${memberName}`} onClick={() => setConfirmation({ type: 'remove', userId: member.userId, displayName: memberName })}>移出</button>}
              </div>
            })}</div>
          </>}

          {tab === 'skills' && <section className="team-skills-panel">
            <div className="panel-title-row"><p>{skillsError ? '共享 Skill 数据暂不可用' : `${skills.length} 个可供成员获取的共享 Skill`}</p><button className="btn btn-ghost btn-sm" onClick={openSharedSkills}><Icon name="eye" size={13} />在团队共享中查看</button></div>
            {skillsError
              ? <LoadError message={loadFailedMessage('团队 Skills ', skillsError)} retrying={loading} onRetry={() => void load()} />
              : skills.length === 0
              ? <div className="team-detail-empty"><Icon name="skills" size={20} /><div><b>{EMPTY_COPY.teamDetailSkillsNone.title}</b><span>{EMPTY_COPY.teamDetailSkillsNone.hint}</span></div></div>
              : <div className="team-skill-grid">{skills.map((skill) => {
                const title = skillListText(skill, skillTitlePreference)
                const sharer = skill.sharedBy ?? skill.author
                return <article key={skill.id} className="team-skill-card">
                  <SkillAvatarIcon className="team-skill-icon" avatarUrl={skill.avatarUrl} size={34} />
                  <div className="team-skill-content"><div className="team-skill-title-row"><h4 className={skillTitlePreference === 'skill-name' ? 'skill-primary-name' : undefined}>{title.primary}</h4><span className="chip mono">{displayText(skill.currentVersion, '未标版本')}</span>{isOwner && <button className="team-skill-remove" disabled={busy} title="移出团队" aria-label={`将 ${title.primary} 移出团队`} onClick={() => setConfirmation({ type: 'unshare', skillId: skill.id, displayName: title.primary })}><Icon name="trash" size={12} /><span>移出</span></button>}</div><p>{title.secondary ?? displayText(skill.description, '暂无 Skill 简介')}</p><footer><span>{sharer ? <><UserChip name={displayText(sharer.displayName, '团队成员')} me={sharer.id === currentUser?.id} avatarUrl={sharer.avatarUrl} />共享</> : '团队成员共享'}</span><span><Icon name="import" size={11} />{skill.installCount ?? 0}</span></footer></div>
                </article>
              })}</div>}
          </section>}

          {tab === 'keys' && <section className="team-keys-panel">
            <div className="panel-title-row"><p>{teamKeys.status === 'ready' ? `${teamKeys.keys.length} 把团队钥匙` : keyCount !== undefined ? `${keyCount} 把团队钥匙` : '团队钥匙'}</p><button className="btn btn-ghost btn-sm" onClick={manageKeys}><Icon name="key-round" size={13} />在钥匙页管理</button></div>
            {teamKeys.status === 'error'
              ? <LoadError message={loadFailedMessage('团队钥匙', teamKeys.error)} retrying={false} onRetry={() => void loadTeamKeys()} />
              : teamKeys.status !== 'ready'
              ? <SkeletonBlock layout="rows" count={2} compact label="正在读取团队钥匙…" />
              : teamKeys.keys.length === 0
              ? <div className="team-detail-empty"><Icon name="key-round" size={20} /><div><b>还没有团队钥匙</b><span>成员可以在钥匙页把自己的钥匙放进团队，团队 Skill 运行时直接使用。</span></div></div>
              : <ul className="team-key-list">{teamKeys.keys.map((key) => <li key={key.key} className="team-key-row">
                <code className="team-key-name">{key.key}</code>
                <span className="team-key-holder">{key.holder ? <><UserChip name={displayText(key.holder.displayName, '成员')} me={key.holder.id === currentUser?.id} />放的</> : null}</span>
                <span className="team-key-usage">{key.inScopeSkills.length > 0 ? `${key.inScopeSkills.length} 个 Skill 在用` : '暂无 Skill 使用'}</span>
              </li>)}</ul>}
          </section>}

          {tab === 'activity' && <TeamActivityFeed teamId={teamId} />}
        </>}
      </div>
    </FocusTrapDialog>

    {inviteOpen && <TeamInviteCreatorDialog teamId={teamId} teamName={teamName} onClose={() => setInviteOpen(false)} />}

    {confirmation?.type === 'remove' && <ConfirmModal eyebrow="团队成员" title={`移出「${confirmation.displayName}」？`} description="该成员将失去团队共享 Skill 的访问权限，之后仍可重新申请加入。" confirmLabel="确认移出" destructive busy={busy} onCancel={() => setConfirmation(null)} onConfirm={() => void removeMember(confirmation.userId)} />}
    {confirmation?.type === 'unshare' && <ConfirmModal eyebrow="团队 Skill" title={`移出「${confirmation.displayName}」？`} description="该 Skill 将不再向团队成员提供安装和更新；关联的团队Skill 配置共享也会同步撤销。" confirmLabel="确认移出" destructive busy={busy} onCancel={() => setConfirmation(null)} onConfirm={() => void removeSharedSkill(confirmation.skillId)} />}
    {confirmation?.type === 'exit' && <ConfirmModal eyebrow="团队管理" title={isOwner ? '解散这个团队？' : '退出这个团队？'} description={isOwner ? '所有 Skill 共享将停止，团队成员会失去访问权限。此操作不可撤销。' : '退出后将无法继续访问这个团队共享的 Skills。'} confirmLabel={isOwner ? '确认解散' : '确认退出'} destructive busy={busy} onCancel={() => setConfirmation(null)} onConfirm={() => void exitTeam()} />}
  </>
}
