import { userMessage } from '../lib/user-message.js'
import { useMediaUrl } from '../lib/media.js'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { createRefreshCoalescer } from '../lib/refresh-coalescer.js'
import { LIBRARY_ENTRIES_CHANGED_EVENT } from '../lib/library-sync.js'
import SkillLibraryList from '../components/SkillLibraryList.js'
import { Icon } from '../components/Icon.js'
import { SegmentedControl } from '../components/SegmentedControl.js'
import { EmptyState, LoadError, SkeletonBlock } from '../components/StateViews.js'
import { CLEAR_FILTERS_LABEL, EMPTY_COPY, LOADING_COPY, RETRY_LABEL, loadFailedMessage } from '../lib/state-copy.js'
import { BlankDragSpacer } from '../components/WindowDragRegion.js'
import { PageHeading } from '../components/PageHeading.js'
import { useStore, type Team, type PendingCommentNavigation } from '../store/index.js'
import { ApiError, apiGetMySkills, apiGetTeams, apiGetTeamSkills, sameSpace } from '../lib/api.js'
import { readAuthSpace } from '../store/index.js'
import {
  orderTeamSharedSkills, summarizeRequiredEnvRows, teamSkillHasUpdate, type EnvKeySummary,
  type TeamSkillAvailability, type TeamSkillSort,
} from '../lib/skill-library.js'
import { mergeSkillSources, mergeApiSkill, reconcileTeamAccess, type TeamSkillSource } from '../lib/skills.js'
import { getLocalSkills, getSkillEnvSourcePolicy } from '../lib/tauri.js'
import { reconcileLocalSkillRefresh } from '../lib/ui-helpers.js'
import './TeamSharedPage.css'
import { TEAM_SKILL_UNAVAILABLE } from '../lib/team-skill-link.js'
import { toast } from '../components/Toast.js'

function messageOf(error: unknown): string {
  return userMessage(error)
}

function TeamMark({ team, large = false }: { team: Team; large?: boolean }) {
  const imageUrl = useMediaUrl(team.avatarUrl)
  const [avatarFailed, setAvatarFailed] = useState(false)
  useEffect(() => setAvatarFailed(false), [imageUrl])
  return <span
    className={`team-shared-team-mark${large ? ' large' : ''}`}
    style={{ background: team.color }}
    aria-hidden="true"
  >
    <span>{team.name.trim().slice(0, 1) || 'T'}</span>
    {imageUrl && !avatarFailed
      && <img src={imageUrl} alt="" onError={() => setAvatarFailed(true)} />}
  </span>
}

export default function TeamSharedPage() {
  const capabilities = useSpaceCapabilities()
  const {
    currentUser, teams, activeTeamId, teamSkills: cachedTeamSkills, setTeamSkills,
    setTeams, setActiveTeam, setView, openTeamSheet,
    sheet, openSkillSheet, closeSheet, pendingCommentNavigation, setPendingCommentNavigation,
  } = useStore(useShallow(state => ({
    currentUser: state.currentUser, teams: state.teams, activeTeamId: state.activeTeamId,
    teamSkills: state.teamSkills, setTeamSkills: state.setTeamSkills, setTeams: state.setTeams, setActiveTeam: state.setActiveTeam,
    setView: state.setView, openTeamSheet: state.openTeamSheet, sheet: state.sheet, openSkillSheet: state.openSkillSheet,
    closeSheet: state.closeSheet, pendingCommentNavigation: state.pendingCommentNavigation, setPendingCommentNavigation: state.setPendingCommentNavigation,
  })))
  const activeSpace = useStore(state => state.activeSpace)
  const [loading, setLoading] = useState(() => !activeTeamId || !cachedTeamSkills[activeTeamId])
  const [loadedTeamId, setLoadedTeamId] = useState<string | null>(null)
  const [loadedNavigation, setLoadedNavigation] = useState<PendingCommentNavigation | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const loadError = useStore(state => state.activeTeamId ? state.teamListErrors[state.activeTeamId] : null)
  const [membershipError, setMembershipError] = useState<string | null>(null)
  const [unavailableTeamIds, setUnavailableTeamIds] = useState<Set<string>>(() => new Set())
  const [searchQuery, setSearchQuery] = useState('')
  const [availabilityFilter, setAvailabilityFilter] = useState<TeamSkillAvailability>('all')
  const [sortMode, setSortMode] = useState<TeamSkillSort>('latest')
  const [envKeysBySkill, setEnvKeysBySkill] = useState<Record<string, EnvKeySummary>>({})
  const [envPolicyErrorBySkill, setEnvPolicyErrorBySkill] = useState<Record<string, true>>({})
  const loadGenerationRef = useRef(0)
  const envPolicyGenerationRef = useRef(0)
  const teamMenuRef = useRef<HTMLDivElement>(null)
  const [teamMenuOpen, setTeamMenuOpen] = useState(false)
  const sortMenuRef = useRef<HTMLDivElement>(null)
  const [sortMenuOpen, setSortMenuOpen] = useState(false)

  const runTeamLoad = useCallback(async (silent = false): Promise<void> => {
    if (!currentUser) {
      setLoading(false)
      return
    }
    const expectedUserId = currentUser.id
    const expectedSpace = readAuthSpace()
    const navigation = useStore.getState().pendingCommentNavigation
    const generation = ++loadGenerationRef.current
    if (silent) setRefreshing(true)
    else if (!useStore.getState().teamSkills[useStore.getState().activeTeamId ?? '']) setLoading(true)

    try {
      const [localResult, ownedResult, teamsResult] = await Promise.allSettled([
        getLocalSkills(),
        apiGetMySkills(expectedSpace ?? undefined),
        apiGetTeams(expectedSpace ?? undefined),
      ])
      const membershipTeams = teamsResult.status === 'fulfilled'
        ? teamsResult.value
        : useStore.getState().teams
      const teamResults = await Promise.allSettled(
        membershipTeams.map((team) => apiGetTeamSkills(team.id, expectedSpace ?? undefined)),
      )

      if (
        generation !== loadGenerationRef.current
        || !sameSpace(expectedSpace, readAuthSpace())
        || useStore.getState().currentUser?.id !== expectedUserId
      ) return

      if (teamsResult.status === 'fulfilled') setTeams(membershipTeams)
      let selectedTeamId = useStore.getState().activeTeamId
      if (teamsResult.status === 'fulfilled' && (!selectedTeamId || !membershipTeams.some((team) => team.id === selectedTeamId))) {
        if (useStore.getState().pendingCommentNavigation) {
          useStore.getState().setPendingCommentNavigation(null)
          toast(TEAM_SKILL_UNAVAILABLE, 'error')
        }
        selectedTeamId = membershipTeams[0]?.id ?? null
        if (selectedTeamId) setActiveTeam(selectedTeamId)
      }

      const localSkills = localResult.status === 'fulfilled'
        ? localResult.value
        : useStore.getState().skills.filter((skill) => Boolean(skill.localPath))
      const ownedSkills = ownedResult.status === 'fulfilled' ? ownedResult.value : null
      const teamSources: TeamSkillSource[] = membershipTeams.map((team, index) => ({
        teamId: team.id,
        skills: teamResults[index]?.status === 'fulfilled' ? teamResults[index].value : null,
      }))
      const merged = mergeSkillSources(localSkills, ownedSkills, {
        accountUserId: currentUser.id,
        selfhost: capabilities.profile === 'selfhost',
        activeTeamId: selectedTeamId,
        membershipsValidated: teamsResult.status === 'fulfilled',
        teamSources,
      })
      // Local installation state is read from the common inventory. Each
      // team's protected response owns only its own display/permission slice.
      const authoritativeTeamIds: string[] = []
      membershipTeams.forEach((team, index) => {
        const result = teamResults[index]
        if (result?.status === 'fulfilled') {
          authoritativeTeamIds.push(team.id)
          setTeamSkills(team.id, result.value.map(remote => mergeApiSkill(remote,
            merged.find(skill => skill.serverId === remote.id && skill.localPath), team.id, expectedUserId, capabilities.profile === 'selfhost')),
            localResult.status === 'rejected' || ownedResult.status === 'rejected' || teamsResult.status === 'rejected' ? '未能刷新部分数据，请重试' : null)
        } else {
          const revoked = result?.status === 'rejected' && result.reason instanceof ApiError
            && [403, 404].includes(result.reason.status ?? 0)
          if (revoked) authoritativeTeamIds.push(team.id)
          const known = useStore.getState().teamSkills[team.id]
          if (!revoked && !known) {
            setTeamSkills(team.id, undefined, '未能刷新团队共享，请重试')
            return
          }
          const retained = localResult.status === 'fulfilled' ? (known ?? []).map(skill => {
            const local = localSkills.find(item => item.serverId === skill.serverId && item.localPath)
            return local ? reconcileLocalSkillRefresh(skill, local)
              : skill.localPath ? { ...skill, localPath: '', installed: false, agents: {} } : skill
          }) : known ?? []
          setTeamSkills(team.id, revoked ? [] : retained,
            '未能刷新团队共享，请重试')
        }
      })
      if (ownedResult.status === 'fulfilled' && teamsResult.status === 'fulfilled' && teamResults.every(result => result.status === 'fulfilled')) {
        const state = useStore.getState()
        // Commit permissions once, after all grants are known. Team display
        // rows never replace the personal inventory.
        state.setSkills(state.skills.map(known => {
          const authoritative = merged.find(skill => skill.id === known.id && skill.localPath)
          return authoritative ? { ...known, isOwn: authoritative.isOwn, serverId: authoritative.serverId,
            serverAccessValidatedForUserId: authoritative.serverAccessValidatedForUserId, teamSharedFrom: authoritative.teamSharedFrom,
            sharedTo: authoritative.sharedTo, teamUnshared: authoritative.teamUnshared, teamUpdateStatus: authoritative.teamUpdateStatus,
            accountSyncRequired: authoritative.accountSyncRequired } : known
        }))
      } else {
        const state = useStore.getState()
        state.setSkills(reconcileTeamAccess(state.skills, state.teamSkills, authoritativeTeamIds, expectedUserId))
      }

      const unavailable = new Set<string>()
      const errors: string[] = []
      if (localResult.status === 'rejected') errors.push(`本机 Skill：${messageOf(localResult.reason)}`)
      if (ownedResult.status === 'rejected') errors.push(`个人资产：${messageOf(ownedResult.reason)}`)
      if (teamsResult.status === 'rejected') errors.push(`团队列表：${messageOf(teamsResult.reason)}`)
      teamResults.forEach((result, index) => {
        if (result.status !== 'rejected') return
        const team = membershipTeams[index]
        if (team) unavailable.add(team.id)
        errors.push(`${team?.name ?? '团队'}：${messageOf(result.reason)}`)
      })
      setUnavailableTeamIds(unavailable)
      setLoadedTeamId(selectedTeamId)
      setLoadedNavigation(navigation)
      setMembershipError(errors.length > 0 ? '未能刷新部分数据，请重试' : null)
    } catch (error: unknown) {
      if (
        generation === loadGenerationRef.current
        && sameSpace(expectedSpace, readAuthSpace())
        && useStore.getState().currentUser?.id === expectedUserId
      ) setMembershipError(loadFailedMessage('团队共享', messageOf(error)))
    } finally {
      if (
        generation === loadGenerationRef.current
        && sameSpace(expectedSpace, readAuthSpace())
        && useStore.getState().currentUser?.id === expectedUserId
      ) {
        setLoading(false)
        setRefreshing(false)
      }
    }
  }, [currentUser?.id, activeSpace?.spaceId, activeSpace?.generation, capabilities.profile, setActiveTeam, setTeamSkills, setTeams])
  const coalescer = useMemo(() => createRefreshCoalescer(runTeamLoad, 5_000,
    JSON.stringify(['team-skills', activeSpace?.spaceId, activeSpace?.generation, currentUser?.id])), [runTeamLoad])
  const loadTeamLibrary = useCallback((silent = false): Promise<void> => coalescer.request(silent), [coalescer])

  useEffect(() => {
    const state = useStore.getState()
    if (!state.activeTeamId || !state.teamSkills[state.activeTeamId]) coalescer.invalidate()
    void loadTeamLibrary(true)
    return () => { loadGenerationRef.current += 1; coalescer.cancel() }
  }, [loadTeamLibrary, coalescer])
  useEffect(() => {
    if (pendingCommentNavigation || (activeTeamId && !useStore.getState().teamSkills[activeTeamId])) {
      coalescer.invalidate()
    }
    void loadTeamLibrary(true)
  }, [activeTeamId, pendingCommentNavigation, loadTeamLibrary, coalescer])

  useEffect(() => {
    const refreshOnReturn = (): void => { void loadTeamLibrary(true) }
    window.addEventListener('focus', refreshOnReturn)
    const timer = window.setInterval(() => { if (document.visibilityState !== 'hidden') refreshOnReturn() }, 30_000)
    return () => { window.removeEventListener('focus', refreshOnReturn); window.clearInterval(timer) }
  }, [loadTeamLibrary])

  useEffect(() => {
    const refreshFromNavigation = (event: Event): void => {
      const detail: unknown = event instanceof CustomEvent ? event.detail : null
      if (detail && typeof detail === 'object' && 'unsharedTeamId' in detail && 'unsharedSkillId' in detail
        && typeof detail.unsharedTeamId === 'string' && typeof detail.unsharedSkillId === 'string') {
        const { unsharedTeamId, unsharedSkillId } = detail
        const state = useStore.getState()
        state.setTeamSkills(unsharedTeamId, (state.teamSkills[unsharedTeamId] ?? []).filter(skill => skill.serverId !== unsharedSkillId), state.teamListErrors[unsharedTeamId] ?? null)
        state.setSkills(reconcileTeamAccess(state.skills, useStore.getState().teamSkills, [unsharedTeamId], state.currentUser?.id))
      }
      if (!(detail && typeof detail === 'object' && 'reason' in detail && detail.reason === 'navigation')) {
        loadGenerationRef.current += 1
        coalescer.invalidate()
      }
      void loadTeamLibrary(true)
    }
    window.addEventListener('skillhub:refresh-team-shares', refreshFromNavigation)
    window.addEventListener('skillhub-local-changed', refreshFromNavigation)
    window.addEventListener(LIBRARY_ENTRIES_CHANGED_EVENT, refreshFromNavigation)
    return () => {
      window.removeEventListener('skillhub:refresh-team-shares', refreshFromNavigation)
      window.removeEventListener('skillhub-local-changed', refreshFromNavigation)
      window.removeEventListener(LIBRARY_ENTRIES_CHANGED_EVENT, refreshFromNavigation)
    }
  }, [loadTeamLibrary, coalescer])

  useEffect(() => {
    if (!teamMenuOpen) return
    const closeOutside = (event: PointerEvent): void => {
      if (!teamMenuRef.current?.contains(event.target as Node)) setTeamMenuOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setTeamMenuOpen(false)
    }
    document.addEventListener('pointerdown', closeOutside)
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOutside)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [teamMenuOpen])

  useEffect(() => {
    if (!sortMenuOpen) return
    const closeOutside = (event: PointerEvent): void => {
      if (!sortMenuRef.current?.contains(event.target as Node)) setSortMenuOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setSortMenuOpen(false)
    }
    document.addEventListener('pointerdown', closeOutside)
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOutside)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [sortMenuOpen])

  const activeTeam = teams.find((team) => team.id === activeTeamId) ?? null
  const teamSkills = useMemo(() => {
    if (!activeTeamId) return []
    return cachedTeamSkills[activeTeamId] ?? []
  }, [activeTeamId, cachedTeamSkills])

  useEffect(() => {
    if (!pendingCommentNavigation || loadedNavigation !== pendingCommentNavigation || loading || loadedTeamId !== activeTeamId || pendingCommentNavigation.teamId !== activeTeamId) return
    if ((pendingCommentNavigation.accountUserId && pendingCommentNavigation.accountUserId !== currentUser?.id)
      || (pendingCommentNavigation.space && !sameSpace(pendingCommentNavigation.space, activeSpace))) {
      setPendingCommentNavigation(null)
      return
    }
    if (activeTeamId && unavailableTeamIds.has(activeTeamId)) return
    const target = teamSkills.find((skill) => (
      skill.serverId === pendingCommentNavigation.serverSkillId
      || skill.id === pendingCommentNavigation.serverSkillId
    ))
    if (target) {
      if (pendingCommentNavigation.teamVersionId && pendingCommentNavigation.teamVersionId !== target.teamVersionId) toast('团队共享版本已更新，已打开当前版本')
      setSearchQuery('')
      setAvailabilityFilter('all')
      openSkillSheet(target.id, 'profile', pendingCommentNavigation.commentId ? `comment:${pendingCommentNavigation.commentId}` : undefined)
    } else {
      toast(TEAM_SKILL_UNAVAILABLE, 'error')
    }
    setPendingCommentNavigation(null)
  }, [activeTeamId, loadedTeamId, loadedNavigation, loading, openSkillSheet, pendingCommentNavigation, setPendingCommentNavigation, teamSkills, unavailableTeamIds, currentUser?.id, activeSpace])

  useEffect(() => {
    const generation = ++envPolicyGenerationRef.current
    const space = readAuthSpace()
    const expectedUserId = currentUser?.id
    const candidates = teamSkills.filter((skill) => (
      Boolean(skill.localPath)
      && skill.envDeps.some((dependency) => dependency.required)
    ))
    if (!space || !expectedUserId || candidates.length === 0) {
      setEnvKeysBySkill({})
      setEnvPolicyErrorBySkill({})
      return
    }
    void Promise.allSettled(candidates.map(async (skill) => ({
      skillId: skill.id,
      keys: summarizeRequiredEnvRows(
        await getSkillEnvSourcePolicy(skill.id, expectedUserId, capabilities.teamKeys),
      ),
    }))).then((results) => {
      if (
        generation !== envPolicyGenerationRef.current
        || !sameSpace(space, readAuthSpace())
        || useStore.getState().currentUser?.id !== expectedUserId
      ) return
      const counts: Record<string, EnvKeySummary> = {}
      const failures: Record<string, true> = {}
      results.forEach((result, index) => {
        if (result.status === 'fulfilled') counts[result.value.skillId] = result.value.keys
        else {
          const candidate = candidates[index]
          if (candidate) failures[candidate.id] = true
        }
      })
      setEnvKeysBySkill(counts)
      setEnvPolicyErrorBySkill(failures)
    })
  }, [currentUser?.id, activeSpace?.spaceId, activeSpace?.generation, teamSkills, capabilities.teamKeys])

  const filteredSkills = useMemo(() => {
    const query = searchQuery.trim().toLocaleLowerCase('zh-CN')
    const matches = teamSkills.filter((skill) => (
      (!query
        || skill.displayName.toLocaleLowerCase('zh-CN').includes(query)
        || skill.name.toLocaleLowerCase('zh-CN').includes(query)
        || skill.labels.some((label) => label.toLocaleLowerCase('zh-CN').includes(query)))
    ))
    return orderTeamSharedSkills(matches, availabilityFilter, sortMode)
  }, [availabilityFilter, searchQuery, sortMode, teamSkills])

  useEffect(() => {
    if (pendingCommentNavigation) return
    if (loading || refreshing) return
    if (filteredSkills.length === 0) {
      if (sheet?.kind === 'skill') closeSheet()
      return
    }
    if (sheet?.kind === 'team') return
    if (sheet?.kind !== 'skill' || !filteredSkills.some((skill) => skill.id === sheet.skillId)) {
      const firstSkill = filteredSkills[0]
      if (firstSkill) openSkillSheet(firstSkill.id)
    }
  }, [closeSheet, filteredSkills, openSkillSheet, sheet, pendingCommentNavigation, loading, refreshing])

  const installedCount = teamSkills.filter((skill) => Boolean(skill.localPath)).length
  const availableCount = Math.max(0, teamSkills.length - installedCount)
  const updateCount = teamSkills.filter(teamSkillHasUpdate).length
  const selectedTeamUnavailable = Boolean(activeTeamId && unavailableTeamIds.has(activeTeamId))

  const chooseTeam = (teamId: string): void => {
    setTeamMenuOpen(false)
    if (teamId === activeTeamId) return
    setAvailabilityFilter('all')
    setActiveTeam(teamId)
  }

  if (!currentUser) return <div className="page-body team-shared-page-body">
    <EmptyState copy={EMPTY_COPY.teamSignedOut} icon="team" className="team-shared-empty" />
  </div>

  return <>
    <PageHeading
      title="团队共享"
      subtitle="从团队目录选择 Skill，在右侧查看和安装"
      className="team-shared-title-row"
      actions={<>
        <BlankDragSpacer />
        {activeTeam && <div className="team-shared-selector" ref={teamMenuRef}>
          <button type="button" className="team-shared-selector-trigger" aria-haspopup="menu" aria-expanded={teamMenuOpen} onClick={() => { setTeamMenuOpen((open) => !open); void loadTeamLibrary(true) }}>
            <TeamMark team={activeTeam} />
            <span>{activeTeam.name}</span>
            {(loading || refreshing) ? <span className="spin-icon" /> : <Icon name="chev" size={13} />}
          </button>
          {teamMenuOpen && <div className="team-shared-selector-menu" role="menu" aria-label="切换团队">
            {teams.map((team) => <button key={team.id} type="button" role="menuitemradio" aria-checked={team.id === activeTeamId} onClick={() => chooseTeam(team.id)}>
              <TeamMark team={team} />
              <span><b>{team.name}</b><small>{team.role === 'owner' ? '我的团队' : '已加入团队'}</small></span>
              {team.id === activeTeamId && <Icon name="check" size={13} />}
            </button>)}
          </div>}
        </div>}
      </>}
    />

    <div className="page-body team-shared-page-body">
      {(loadError || membershipError) && <LoadError message={loadError || membershipError || '未能刷新'} retrying={loading} onRetry={() => void loadTeamLibrary()} />}

      {loading && teams.length === 0 ? <SkeletonBlock layout="rows" label={LOADING_COPY.teamShared} /> : teams.length === 0 ? membershipError ? null : <EmptyState copy={EMPTY_COPY.teamNone} icon="team" className="team-shared-empty">
        <button className="btn btn-primary" onClick={() => setView('teams')}><Icon name="plus" size={14} />前往 My Team</button>
      </EmptyState> : <>
        {activeTeam && <section className="team-shared-context" aria-label="当前团队">
          <button className="team-shared-context-identity" type="button" onClick={() => openTeamSheet(activeTeam.id)} aria-label={`查看 ${activeTeam.name} 团队详情`}>
            <TeamMark team={activeTeam} large />
            <span className="team-shared-context-copy">
              <span>当前团队</span>
              <b>{activeTeam.name}</b>
              <small>{activeTeam.description || '团队成员共享的 Skill 会集中显示在这里。'}</small>
            </span>
          </button>
          <div className="team-shared-context-stats" aria-label="团队 Skill 状态">
            <span><b>{teamSkills.length}</b>共享</span>
            <span><b>{installedCount}</b>已在本机</span>
            <span className="team-shared-stat-available"><b>{availableCount}</b>可获取</span>
            <span><b>{activeTeam.credentialCount ?? '—'}</b>团队钥匙</span>
          </div>
        </section>}

        <div className="toolbar team-shared-toolbar">
          <label className="search-bar"><Icon name="search" size={14} /><input aria-label="搜索团队共享 Skill" placeholder="搜索团队里的 Skill" value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} /></label>
          <div className="team-shared-catalog-controls">
            <SegmentedControl
              className="team-shared-availability"
              mode="radiogroup"
              size="sm"
              aria-label="安装状态"
              value={availabilityFilter}
              onChange={setAvailabilityFilter}
              options={[
                { value: 'all', label: '全部' },
                { value: 'uninstalled', label: '可获取', count: availableCount },
                { value: 'updates', label: '有更新', count: updateCount },
              ]}
            />
            <div className="team-shared-sort" ref={sortMenuRef}>
              <button type="button" className="team-shared-sort-trigger" aria-haspopup="menu" aria-expanded={sortMenuOpen} aria-label={`排序方式：${sortMode === 'latest' ? '按最新' : '按下载'}`} onClick={() => setSortMenuOpen((open) => !open)}>
                {sortMode === 'latest' ? '按最新' : '按下载'}<Icon name="chev" size={12} />
              </button>
              {sortMenuOpen && <div className="team-shared-sort-menu" role="menu" aria-label="排序方式">
                {([['latest', '按最新'], ['downloads', '按下载']] as const).map(([value, label]) => <button key={value} type="button" role="menuitemradio" aria-checked={sortMode === value} onClick={() => { setSortMode(value); setSortMenuOpen(false) }}>
                  <span>{label}</span>{sortMode === value && <Icon name="check" size={13} />}
                </button>)}
              </div>}
            </div>
          </div>
        </div>

        <section
          id="team-shared-panel"
          className="team-shared-results"
        >
          {loading && teamSkills.length === 0 ? <SkeletonBlock layout="rows" label={LOADING_COPY.teamSharedSkills} /> : (selectedTeamUnavailable || loadError) && teamSkills.length === 0 ? <EmptyState copy={EMPTY_COPY.teamSharedUnavailable} icon="warn" compact className="team-shared-empty">
            <button className="btn btn-ghost" disabled={loading} onClick={() => void loadTeamLibrary()}>{RETRY_LABEL}</button>
          </EmptyState> : teamSkills.length === 0 ? <EmptyState copy={EMPTY_COPY.teamSharedNone} icon="skills" compact className="team-shared-empty">
            {activeTeam && <button className="btn btn-ghost" onClick={() => openTeamSheet(activeTeam.id)}>查看团队详情</button>}
          </EmptyState> : filteredSkills.length === 0 ? <EmptyState copy={EMPTY_COPY.skillsNoMatch} icon="search" compact className="team-shared-empty">
            <button className="btn btn-ghost" onClick={() => { setSearchQuery(''); setAvailabilityFilter('all') }}>{CLEAR_FILTERS_LABEL}</button>
          </EmptyState> : <SkillLibraryList
            context="team"
            skills={filteredSkills}
            envKeysBySkill={envKeysBySkill}
            envPolicyErrorBySkill={envPolicyErrorBySkill}
          />}
        </section>
      </>}
    </div>
  </>
}
import { useSpaceCapabilities } from '../lib/use-space-capabilities.js'
