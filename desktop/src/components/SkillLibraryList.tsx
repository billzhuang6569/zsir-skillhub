import { memo, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { activeAgentEntries, agentDisplayName } from '../lib/agents.js'
import { nextRovingIndex } from '../lib/ui-helpers.js'
import { sourceModificationLabel } from '../lib/skill-library.js'
import { useStore, type LocalSkill, type SkillDetailTab } from '../store/index.js'
import { useShallow } from 'zustand/react/shallow'
import { selectSkillLibraryListState } from '../lib/store-selectors.js'
import AgentBrandIcon from './AgentBrandIcon.js'
import { Icon } from './Icon.js'
import { SkillAvatarIcon } from './SkillAvatarIcon.js'
import { skillListText, UNANALYSED_SKILL_NAME } from '../lib/skill-title.js'
import { skillVersionDisplay } from '../lib/versioning.js'
import { isRowIssueIcon, isTeamSharedSkill, issueForSkill, issueTooltipParts, skillIssueTagClass, teamSkillHasUpdate, type EnvKeySummary, type SkillRowIssue } from '../lib/skill-library.js'
import { Tooltip } from './Tooltip.js'
import { UserChip } from './UserChip.js'
import { openSkillDir, currentMediaSpace } from '../lib/tauri.js'
import { apiGetTeamSkillLink, sameSpace } from '../lib/api.js'
import { acquireTeamSkill } from '../lib/team-skill-acquisition.js'
import { teamSkillAppLink } from '../lib/team-skill-link.js'
import { teamSkillMenuState } from '../lib/team-skill-menu.js'
import { requestLibrarySync } from '../lib/library-sync.js'
import UnshareSkillDialog from './UnshareSkillDialog.js'
import TeamSkillUpdateButton from './TeamSkillUpdateButton.js'
import { userMessage } from '../lib/user-message.js'
import SkillListName from './SkillListName.js'
import { toast } from './Toast.js'
import { libraryTransferFraction } from '../lib/library-sync.js'
import { cloudSelectionId, emptyCloudSelection, focusCloudRow, retainCloudSelection, selectCloudRow } from '../lib/cloud-selection.js'
import { isInQuickAccess, skillOrganizerKey, tagsForSkill } from '../lib/skill-organizer.js'
import { toggleSkillQuickAccess } from './SkillTagPopover.js'
import SkillTagPopover, { SkillTagChips } from './SkillTagPopover.js'
import './store/StoreUI.css'
import './SkillLibraryList.css'

type Props = {
  skills: LocalSkill[]
  envKeysBySkill?: Record<string, EnvKeySummary>
  envPolicyErrorBySkill?: Record<string, true>
  context?: 'personal' | 'team'
  selectionResetKey?: string
  onBatch?: (skills: LocalSkill[], action: 'share' | 'delete') => void
}

/** Custom tag chips shown on row line 2 before folding into 「+N」 (#323). */
const ROW_TAG_LIMIT = 2

/** Row SkillAvatar: 52px, radius-md, hairline ring (the store `.tsh-avatar` ring). */
const AVATAR_CLASS = 'skill-library-avatar tsh-avatar tsh-avatar-md'

function SkillLibraryList({
  skills,
  envKeysBySkill = {},
  envPolicyErrorBySkill = {},
  context = 'personal',
  selectionResetKey,
  onBatch,
}: Props) {
  const { sheet, openSkillSheet, currentUser, teams, agentCapabilities, skillTitlePreference } = useStore(useShallow(selectSkillLibraryListState))
  const lastRunFailures = useStore((state) => state.lastRunFailures)
  const organizer = useStore((state) => state.organizer)
  const organizerReady = useStore((state) => Boolean(state.organizerAccount))
  const accountDeletes = useStore((state) => state.accountDeletes)
  const skillInQuickAccess = (skill: LocalSkill): boolean => isInQuickAccess(organizer, { kind: 'skill', ref: skillOrganizerKey(skill, currentUser?.id ?? null) })
  const [tagPopover, setTagPopover] = useState<{ skills: LocalSkill[]; x: number; y: number; skillId: string } | null>(null)
  const supportedAgentKeys = new Set(agentCapabilities.map((agent) => agent.key))
  const capabilities = useSpaceCapabilities()
  const teamIds = new Set(teams.map((team) => team.id))
  const optionRefs = useRef(new Map<string, HTMLButtonElement>())
  const selectedSkillId = sheet?.kind === 'skill' ? sheet.skillId : null
  const [selection, setSelection] = useState(emptyCloudSelection)
  const visibleIds = skills.map(cloudSelectionId)
  const visibleSignature = JSON.stringify(visibleIds)
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform)
  const menuRef = useRef<HTMLDivElement>(null)
  const [contextMenu, setContextMenu] = useState<{ skillId: string; x: number; y: number } | null>(null)
  const contextSkill = contextMenu ? skills.find((skill) => skill.id === contextMenu.skillId) : undefined
  const activeTeamId = useStore(state => state.activeTeamId)
  const activeTeam = teams.find(team => team.id === activeTeamId)
  const [unshareSkill, setUnshareSkill] = useState<LocalSkill | null>(null)
  const [teamBusy, setTeamBusy] = useState(false)
  const [online, setOnline] = useState(navigator.onLine)
  const teamMenu = contextSkill ? teamSkillMenuState(contextSkill, currentUser?.id ?? null, online, teamBusy) : null
  useEffect(() => {
    const update = (): void => setOnline(navigator.onLine)
    window.addEventListener('online', update); window.addEventListener('offline', update)
    return () => { window.removeEventListener('online', update); window.removeEventListener('offline', update) }
  }, [])
  useEffect(() => { setContextMenu(null); setUnshareSkill(null) }, [activeTeamId, currentUser?.id])
  const teamAction = async (skill: LocalSkill, action: 'acquire' | 'share'): Promise<void> => {
    const state = useStore.getState()
    const space = state.activeSpace
    if (!space || !currentUser || !activeTeamId || !skill.serverId || teamBusy) return
    setContextMenu(null); setTeamBusy(true)
    const current = (): boolean => sameSpace(space, useStore.getState().activeSpace)
      && currentUser.id === useStore.getState().currentUser?.id
    try {
      if (action === 'acquire') {
        const local = await acquireTeamSkill(skill, currentUser.id, activeTeamId, space)
        if (!current()) return
        useStore.getState().replaceSkill(skill.id, local, true)
        requestLibrarySync()
        toast('已加入我的 Skills')
      } else {
        let link: string
        if (state.serverInfo?.capabilities?.includes('teams.skill-links.v1')) {
          link = (await apiGetTeamSkillLink(activeTeamId, skill.serverId, space)).landingPageUrl
        } else {
          const media = await currentMediaSpace()
          if (!sameSpace(space, media.space)) return
          link = teamSkillAppLink(activeTeamId, skill.serverId, media.serverBase.replace(/\/+$/, ''))
        }
        if (!current()) return
        await navigator.clipboard.writeText(link)
        toast('分享链接已复制，只有团队成员可以打开')
      }
    } catch (error: unknown) { if (current()) toast(userMessage(error), 'error') }
    finally { setTeamBusy(false) }
  }

  useEffect(() => {
    setSelection(emptyCloudSelection); setContextMenu(null); setTagPopover(null)
  }, [currentUser?.id, selectionResetKey, context])
  useEffect(() => { setSelection(state => retainCloudSelection(state, visibleIds)) }, [visibleSignature])
  useEffect(() => {
    const clear = (event: globalThis.MouseEvent): void => {
      if (context !== 'personal' || (event.target instanceof Element && event.target.closest('.skill-library-row, [data-skill-context-menu], [role="dialog"], .detail-sheet'))) return
      setSelection(emptyCloudSelection)
    }
    const escape = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape' || contextMenu || document.querySelector('[role="dialog"][aria-modal="true"]')) return
      setSelection(emptyCloudSelection)
    }
    document.addEventListener('click', clear); document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('click', clear); document.removeEventListener('keydown', escape) }
  }, [context, contextMenu])
  useLayoutEffect(() => {
    const menu = menuRef.current
    if (!menu || !contextMenu) return
    const rect = menu.getBoundingClientRect()
    menu.style.left = `${Math.max(8, Math.min(contextMenu.x, window.innerWidth - rect.width - 8))}px`
    menu.style.top = `${Math.max(8, Math.min(contextMenu.y, window.innerHeight - rect.height - 8))}px`
    menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
  }, [contextMenu])

  useEffect(() => {
    if (!contextMenu) return
    const close = (): void => setContextMenu(null)
    const closeOnEscape = (event: globalThis.KeyboardEvent): void => { if (event.key === 'Escape') { event.stopImmediatePropagation(); close(); optionRefs.current.get(contextMenu.skillId)?.focus() } }
    window.addEventListener('blur', close)
    window.addEventListener('scroll', close, true)
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      window.removeEventListener('blur', close)
      window.removeEventListener('scroll', close, true)
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [contextMenu])

  const openSkill = (skillId: string, tab?: SkillDetailTab): void => {
    const currentTab = sheet?.kind === 'skill' ? sheet.tab : 'profile'
    openSkillSheet(skillId, tab ?? currentTab)
  }

  const showContextMenu = (skill: LocalSkill, x: number, y: number): void => {
    if (rowInert(skill)) return
    if (context === 'personal') setSelection(state => selectCloudRow(state, visibleIds, cloudSelectionId(skill), { context: true }))
    setContextMenu({ skillId: skill.id, x, y })
  }
  const openTagPopover = (): void => {
    if (!contextMenu || !contextSkill) return
    const selected = skills.filter(skill => selection.ids.includes(cloudSelectionId(skill)))
    const rect = menuRef.current?.getBoundingClientRect()
    setTagPopover({ skills: selected.length > 0 ? selected : [contextSkill], x: rect?.left ?? contextMenu.x, y: rect?.top ?? contextMenu.y, skillId: contextSkill.id })
    setContextMenu(null)
  }
  const beginBatch = (action: 'share' | 'delete'): void => {
    onBatch?.(skills.filter(skill => selection.ids.includes(cloudSelectionId(skill))), action)
    setContextMenu(null)
  }

  const rowInert = (skill: LocalSkill | undefined): boolean => Boolean(skill && (accountDeletes.pending[cloudSelectionId(skill)] || accountDeletes.leaving[cloudSelectionId(skill)]))
  const onKeyDown = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    index: number,
  ): void => {
    const skill = skills[index]
    // A row being deleted from the account takes no keyboard actions either (#360).
    if (rowInert(skill) && (event.key === ' ' || event.key === 'Enter' || event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey))) { event.preventDefault(); return }
    if (skill && context === 'personal' && event.key === ' ') {
      event.preventDefault()
      setSelection(state => selectCloudRow(state, visibleIds, cloudSelectionId(skill), { additive: true, range: event.shiftKey }))
      return
    }
    if (skill && (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey))) {
      event.preventDefault()
      const rect = event.currentTarget.getBoundingClientRect()
      showContextMenu(skill, rect.left + 24, rect.bottom)
      return
    }
    let nextIndex = nextRovingIndex(index, skills.length, event.key, 'vertical')
    if (nextIndex === null) return
    // Skip inert rows in the direction of travel; stay put if only inert rows remain.
    const step = nextIndex > index || (nextIndex === 0 && index !== 0 && event.key !== 'Home') ? 1 : -1
    for (let hops = 0; hops < skills.length && rowInert(skills[nextIndex]); hops += 1) nextIndex = (nextIndex + step + skills.length) % skills.length
    const nextSkill = skills[nextIndex]
    if (!nextSkill || rowInert(nextSkill)) return
    event.preventDefault()
    const focusOnly = context === 'personal' && (isMac ? event.metaKey : event.ctrlKey)
    if (context === 'personal') setSelection(state => focusOnly
      ? focusCloudRow(state, visibleIds, cloudSelectionId(nextSkill))
      : selectCloudRow(state, visibleIds, cloudSelectionId(nextSkill), { range: event.shiftKey }))
    if (!focusOnly) openSkill(nextSkill.id)
    optionRefs.current.get(nextSkill.id)?.focus()
  }

  return <>{context === 'personal' && selection.ids.length > 0 && <p className="sr-only" role="status">已选 {selection.ids.length} 个</p>}<div className="skill-library-list" role="listbox" aria-multiselectable={context === 'personal'} aria-label={context === 'team' ? '团队 Skill 目录' : '我的 Skill 目录'}>
    {skills.map((skill, index) => {
      const title = skillListText(skill, skillTitlePreference)
      const versionDisplay = skillVersionDisplay(skill)
      const transfer = skill.cloudDownload
      const fraction = libraryTransferFraction(transfer)
      const selected = context === 'personal' ? selection.ids.includes(cloudSelectionId(skill)) : skill.id === selectedSkillId
      const focused = context === 'personal' ? selection.focus === cloudSelectionId(skill) : skill.id === selectedSkillId
      const teamShared = context === 'personal' && isTeamSharedSkill(skill, currentUser?.id ?? null, teamIds)
      const issue = issueForSkill(
        skill,
        envKeysBySkill[skill.id],
        Boolean(envPolicyErrorBySkill[skill.id]),
        Boolean(currentUser),
        versionDisplay.problem,
        context === 'personal' ? lastRunFailures[skill.id] : null,
      )
      const issueIcon = isRowIssueIcon(issue)
      const sourceLabel = sourceModificationLabel(skill)
      // 「<UserChip> 共享」: the member who shared it, falling back to the author (#295).
      const sharerName = skill.sharedBy?.displayName?.trim() || skill.authorName?.trim() || ''
      const sharerId = skill.sharedBy?.id ?? (skill.authorName ? skill.serverOwnerId : undefined)
      const teamSharer = context === 'team' && sharerName
        ? { name: sharerName, me: Boolean(currentUser && sharerId === currentUser.id), avatarUrl: skill.sharedBy?.avatarUrl ?? skill.authorAvatarUrl ?? null }
        : null
      const agentEntries = activeAgentEntries(skill.agents)
        .filter(([agentKey]) => supportedAgentKeys.has(agentKey))
        .slice(0, 5)
      // Background 「从账号删除」 (#360): processing rows are inert, removed rows animate out.
      const deleteState = accountDeletes.leaving[cloudSelectionId(skill)] ? ' leaving' : accountDeletes.pending[cloudSelectionId(skill)] ? ' deleting' : ''
      return <button
        ref={(element) => { if (element) optionRefs.current.set(skill.id, element); else optionRefs.current.delete(skill.id) }}
        key={context === 'team' ? skill.serverId ?? skill.id : cloudSelectionId(skill)}
        type="button"
        role="option"
        aria-selected={selected}
        className={`skill-library-row${selected ? ' selected' : ''}${skill.isOrphan ? ' orphan' : ''}${deleteState}`}
        aria-busy={deleteState !== '' || undefined}
        aria-label={`查看 ${title.primary}${teamShared ? '，已共享到团队' : ''}${issueIcon && issue ? `，${issue.label}` : ''}`}
        tabIndex={focused || (!(context === 'personal' ? selection.focus : selectedSkillId) && index === 0) ? 0 : -1}
        onClick={(event) => {
          if (deleteState) return
          if (isMac && event.ctrlKey) { const rect = event.currentTarget.getBoundingClientRect(); showContextMenu(skill, event.clientX || rect.left, event.clientY || rect.bottom); return }
          if (context === 'personal') setSelection(state => selectCloudRow(state, visibleIds, cloudSelectionId(skill), { range: event.shiftKey, additive: isMac ? event.metaKey : event.ctrlKey }))
          // Tooltip actions: 「去填写」 opens 钥匙, 「查看详情」 opens 概览.
          const action = (event.target as Element).closest?.('[data-issue-action]')?.getAttribute('data-issue-action')
          // Team rows (#295 board 9): the 28px 「获取」 icon starts the install flow in the detail.
          if (context === 'team' && (event.target as Element).closest?.('[data-row-action="get"]')) openSkillSheet(skill.id, 'profile', 'install')
          else if (action === 'env') openSkillSheet(skill.id, 'environment', 'env')
          else if (action === 'overview') openSkillSheet(skill.id, 'profile')
          // A key badge opens the Skill on its 「需要的钥匙」 section.
          else if (issue?.target === 'env' && (event.target as Element).closest?.('[data-issue-target="env"]')) openSkillSheet(skill.id, 'environment', 'env')
          // 上次运行失败 without a key cause opens 概览.
          else if (issue?.target === 'overview' && (event.target as Element).closest?.('[data-issue-target="overview"]')) openSkillSheet(skill.id, 'profile')
          else openSkill(skill.id)
        }}
        onContextMenu={(event) => {
          event.preventDefault()
          showContextMenu(skill, event.clientX, event.clientY)
        }}
        onKeyDown={(event) => onKeyDown(event, index)}
      >
        <span className={`skill-library-avatar-wrap${teamShared ? ' team-shared' : ''}${transfer ? ' downloading' : ''}${transfer && fraction === null && !transfer.error ? ' indeterminate' : ''}`}
          title={teamShared ? '已共享到团队' : undefined}
          role={transfer ? 'progressbar' : undefined} aria-label={transfer ? `${title.primary} 下载${transfer.error ? '等待重试' : '进度'}` : undefined}
          aria-valuemin={transfer ? 0 : undefined} aria-valuemax={transfer ? 100 : undefined}
          aria-valuenow={transfer && fraction !== null ? Math.round(fraction * 100) : undefined}
          aria-valuetext={transfer ? transfer.error ?? (transfer.phase === 'landing' ? '正在校验并保存' : '正在下载') : undefined}>
          <SkillAvatarIcon
          className={AVATAR_CLASS}
          avatarUrl={skill.avatarUrl}
          status={skill.avatarStatus}
          size={44}
        />{transfer && <span className="skill-avatar-color-reveal" style={{ clipPath: `inset(0 ${(1 - (fraction ?? 0)) * 100}% 0 0)` }}>
          <SkillAvatarIcon className={AVATAR_CLASS} avatarUrl={skill.avatarUrl} size={44} />
        </span>}{transfer && <span className="skill-avatar-download-track"><span style={{ width: `${(fraction ?? 0) * 100}%` }} /></span>}</span>
        {/* Copy is display: contents; the name owns the first line with version, status and source-modification badges.
            The controls occupy only the subtitle and description lines. */}
        <span className="skill-library-copy">
          <span className="skill-library-name-row">
            <SkillListName name={title.primary} className={skillTitlePreference === 'skill-name' ? 'skill-primary-name' : undefined} />
            {skill.isSystem && <span className="skill-library-system">系统</span>}
            <span className="skill-library-version-text mono">{context === 'team' ? `团队版本 ${skill.latestVersion ?? skill.version}` : versionDisplay.label}</span>
            {skill.versionStatus === 'pending' && <span className="skill-library-version">待确认</span>}
            {skill.hasWorkingCopy && <span className="skill-library-version">已修改</span>}
            {sourceLabel && <span className="skill-library-version">{sourceLabel}</span>}
            {skill.teamUnshared && <span className="skill-library-update">团队已停止共享 · 本机副本保留</span>}
            {skill.teamUpdateStatus === 'account_mismatch' && <span className="skill-library-update">获取账号不匹配，不能更新</span>}
            {issue && issueIcon && <SkillIssueIcon issue={issue} />}
          </span>
          {/* Line 2: 友好名 + private tag chips (#323; the AI category moved out, it still drives the
              top filter) — team: 友好名 · 共享人 — with the Agent icons after it; line 3: the description. */}
          {context !== 'team'
            ? <span className="skill-library-text">
              <span className={`skill-library-subtitle${!title.secondary ? ' placeholder' : skillTitlePreference === 'ai-title' ? ' mono' : ''}`} title={title.secondary || undefined}>{title.secondary || UNANALYSED_SKILL_NAME}</span>
              <SkillTagChips names={tagsForSkill(organizer, skillOrganizerKey(skill, currentUser?.id ?? null))} limit={ROW_TAG_LIMIT} />
            </span>
            : <span className="skill-library-text skill-library-team-line">
              <span className={`skill-library-subtitle${!title.secondary ? ' placeholder' : ''}`} title={title.secondary || undefined}>{title.secondary || UNANALYSED_SKILL_NAME}</span>
              {teamSharer && <span className="skill-library-sharer"><span aria-hidden="true">·</span><UserChip name={teamSharer.name} me={teamSharer.me} avatarUrl={teamSharer.avatarUrl} />共享</span>}
            </span>}
          {skill.description && <span className="skill-library-desc" title={skill.description}>{skill.description}</span>}
          <span className="skill-library-side">
            <TeamSkillUpdateButton skill={skill} />
            {transfer ? <span className="skill-library-no-agent" title={transfer.error ?? undefined}>{transfer.error ? '等待重试' : null}</span> : context === 'team' && !skill.localPath
              ? <span role="button" tabIndex={-1} className="btn btn-primary skill-library-get" aria-label="获取" title="获取" data-row-action="get"><Icon name="download" size={14} /></span>
              : skill.isSystem
              ? <span className="skill-library-system-state"><Icon name="check" size={13} />自动维护</span>
              : agentEntries.length > 0
              ? <span className="skill-library-agents" aria-label="Agent 安装状态">
                {agentEntries.map(([agentKey, status]) => <span
                  key={agentKey}
                  className={`skill-library-agent ${status ?? 'off'}`}
                  title={`${agentDisplayName(agentKey)}：${status === 'on' ? '已安装' : status === 'broken' ? '安装有问题' : '未安装'}`}
                >
                  <AgentBrandIcon agent={{ key: agentKey, name: agentDisplayName(agentKey) }} size={22} />
                  <span className="skill-library-agent-state" aria-hidden="true" />
                </span>)}
              </span>
              : <span className="skill-library-no-agent">未安装</span>}
          </span>
        </span>
        <Icon name="left" size={14} />
      </button>
    })}
    {contextMenu && contextSkill && <div
      className="skill-context-menu"
      ref={menuRef}
      data-skill-context-menu
      role="menu"
      aria-label={`${contextSkill.name} 快捷操作`}
      style={{ left: contextMenu.x, top: contextMenu.y }}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === 'Tab') { event.preventDefault(); setContextMenu(null); optionRefs.current.get(contextMenu.skillId)?.focus(); return }
        const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'))
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
        const next = nextRovingIndex(index, buttons.length, event.key, 'vertical')
        if (next !== null) { event.preventDefault(); buttons[next]?.focus() }
      }}
    >
      {context === 'team' && teamMenu ? <>
        <button type="button" role="menuitem" disabled={!teamMenu.openFolder} title={!teamMenu.openFolder ? '尚未加入我的 Skills' : undefined} onClick={() => {
          setContextMenu(null)
          void openSkillDir(contextSkill.marketplaceLocalId ?? contextSkill.id).catch((error: unknown) => toast(userMessage(error), 'error'))
        }}><Icon name="folder" size={14} /><span>打开文件夹</span></button>
        <button type="button" role="menuitem" disabled={!organizerReady || !teamMenu.quickAccess} title={!teamMenu.joined ? '请先加入我的 Skills' : undefined} onClick={() => { setContextMenu(null); toggleSkillQuickAccess(contextSkill) }}><Icon name="star" size={14} /><span>{skillInQuickAccess(contextSkill) ? '移出快捷访问' : '加入快捷访问'}</span></button>
        <button type="button" role="menuitem" disabled={!teamMenu.acquire} title={!online ? '当前离线' : undefined} onClick={() => void teamAction(contextSkill, 'acquire')}><Icon name="download" size={14} /><span>{teamMenu.joined ? '已在我的 Skills' : '加入我的 Skills'}</span></button>
        <button type="button" role="menuitem" onClick={() => {
          setContextMenu(null)
          void navigator.clipboard.writeText(contextSkill.name).then(() => toast('Skill 名称已复制')).catch((error: unknown) => toast(userMessage(error), 'error'))
        }}><Icon name="doc" size={14} /><span>复制 Skill 名</span></button>
        <button type="button" role="menuitem" disabled={!online || teamBusy} onClick={() => void teamAction(contextSkill, 'share')}><Icon name="shared-skills" size={14} /><span>分享</span></button>
        {teamMenu.unshareVisible && <><hr role="separator" /><button type="button" role="menuitem" className="team-unshare" disabled={!teamMenu.unshareEnabled} title={!online ? '当前离线，请联网后取消共享' : undefined} onClick={() => { setUnshareSkill(contextSkill); setContextMenu(null) }}><Icon name="trash" size={14} /><span>取消共享</span></button></>}
      </> : <>
      {selection.ids.length <= 1 && <button type="button" role="menuitem" disabled={!contextSkill.localPath || Boolean(contextSkill.cloudDownload)} onClick={() => {
        setContextMenu(null)
        void openSkillDir(contextSkill.marketplaceLocalId ?? contextSkill.id)
          .catch((error: unknown) => toast(userMessage(error), 'error'))
      }}><Icon name="folder" size={14} /><span>打开文件夹</span></button>}
      {selection.ids.length <= 1 && <button type="button" role="menuitem" disabled={!organizerReady} onClick={() => { setContextMenu(null); toggleSkillQuickAccess(contextSkill) }}><Icon name="star" size={14} /><span>{skillInQuickAccess(contextSkill) ? '移出快捷访问' : '加入快捷访问'}</span></button>}
      <button type="button" role="menuitem" disabled={!organizerReady} onClick={openTagPopover}><Icon name="tag" size={14} /><span>{selection.ids.length >= 2 ? `为 ${selection.ids.length} 个 Skill 加入目录…` : '加入目录…'}</span></button>
      {capabilities.teams && <button type="button" role="menuitem" disabled={!currentUser || teams.length === 0 || (selection.ids.length <= 1 && (contextSkill.isSystem || Boolean(contextSkill.cloudDownload)))} onClick={() => beginBatch('share')}><Icon name="shared-skills" size={14} /><span>{selection.ids.length >= 2 ? `将 ${selection.ids.length} 个 Skill 共享到团队` : '共享到团队'}</span></button>}
      <button type="button" role="menuitem" disabled={!currentUser || (selection.ids.length <= 1 && contextSkill.isSystem)} onClick={() => beginBatch('delete')}><Icon name="trash" size={14} /><span>{selection.ids.length >= 2 ? `将 ${selection.ids.length} 个 Skill 从账号删除` : '从账号删除'}</span></button>
      </>}
    </div>}
    {unshareSkill && activeTeam && <UnshareSkillDialog skill={unshareSkill} team={activeTeam} onClose={() => setUnshareSkill(null)} />}
    {tagPopover && <SkillTagPopover
      skills={tagPopover.skills}
      anchor={{ x: tagPopover.x, y: tagPopover.y }}
      returnFocus={optionRefs.current.get(tagPopover.skillId) ?? null}
      onClose={() => setTagPopover(null)}
    />}
  </div></>
}

export default memo(SkillLibraryList)

/**
 * Row warning as a 14px icon next to the name (#289 board 1). The row is itself a
 * `<button role="option">`, so the trigger and the tooltip actions are focusable
 * spans (no nested buttons); the row's click handler reads their data attributes.
 * The label stays in `aria-label` and the row's own label for screen readers.
 */
function SkillIssueIcon({ issue }: { issue: SkillRowIssue }) {
  const tooltip = issueTooltipParts(issue)
  const keyAction = issue.target === 'env'
  const content = <>
    <span className="ui-tip-title"><Icon name={issue.icon} size={13} />{tooltip.title}</span>
    {tooltip.body && <span className="ui-tip-body">{tooltip.body}</span>}
    {(issue.title || keyAction) && <span className="ui-tip-actions">
      {keyAction && <span role="button" tabIndex={-1} className="btn btn-primary btn-sm" data-issue-action="env">去填写</span>}
      <span role="button" tabIndex={-1} className="btn btn-ghost btn-sm" data-issue-action="overview">查看详情</span>
    </span>}
  </>
  return <Tooltip content={content} align="start" className="skill-issue-tip">
    <span
      role="button"
      tabIndex={-1}
      className={skillIssueTagClass(issue)}
      aria-label={issue.label}
      data-issue-target={issue.target}
    ><Icon name={issue.icon} size={14} strokeWidth={2} /></span>
  </Tooltip>
}
import { useSpaceCapabilities } from '../lib/use-space-capabilities.js'
