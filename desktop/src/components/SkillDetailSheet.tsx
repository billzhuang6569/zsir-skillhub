import { useCatalogOffline } from '../lib/use-catalog-offline.js'
import CatalogPublish from './CatalogPublish.js'
import { catalogPublishMode } from '../lib/catalog-login.js'
import { catalogOfflineAt, catalogOfflineMessage, CATALOG_INSTALL_OFFLINE } from '../lib/catalog-cache.js'
import { useSpaceCapabilities } from '../lib/use-space-capabilities.js'
import { currentSpace, type SpaceHandle } from '../lib/tauri.js'
import { marketplaceAction } from '../lib/marketplace-state.js'
import { acquireMarketplaceSkill } from '../lib/marketplace-acquisition.js'
import { OFFICIAL_ENDPOINTS } from '../lib/official-endpoints.js'
import { userMessage } from '../lib/user-message.js'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { descriptionOverflows } from '../lib/description-overflow.js'
import { openUrl } from '@tauri-apps/plugin-opener'
import { classifyMarkdownLink, isMarkdownPath, renderSkillMarkdown } from '../lib/markdown.js'
import { resolveSkillFromSources, useStore } from '../store/index.js'
import { Icon, type IconName } from './Icon.js'
import { UserChip } from './UserChip.js'
import { SourceUrlLink } from './SourceUrlLink.js'
import { validateSourceUrl, SOURCE_URL_MAX_LENGTH } from '../lib/source-url.js'
import { SkillAvatarIcon } from './SkillAvatarIcon.js'
import { EditorialLabels } from './EditorialLabels.js'
import { MarketplaceBadges } from './SkillCard.js'
import { editorialLabelsBesideBadges, storeDetailStats } from '../lib/store-home.js'
import { envDepsNeedingAttention, skillDiagnosticsText, skillOriginLine } from '../lib/skill-library.js'
import { skillListText } from '../lib/skill-title.js'
import AgentBrandIcon from './AgentBrandIcon.js'
import type { EnvDep, LocalSkill, SkillDetailFocus, SkillDetailTab } from '../store/index.js'
import { UNCONFIRMED_SKILL_ROOT_HINT, agentAcceptsSkillWrites, agentDisplayName, orderedAgentEntries } from '../lib/agents.js'
import {
  createSkillPackage, createSkillSnapshot, deleteManagedSkill, libraryDeleteFromAccount, deleteSkillEnv, detectEnvVarSuggestions, disableSkill, enableSkill,
  getInstalledAgents, getLocalSkill, getLocalSkills, getSkillDiff, getSkillVersions, getSkillVersionState, getSkillWorkingDiff, recordSkillFormalVersion,
  getSkillTree, importSkillPackage, inspectSkillMarkdown, installSkill, openSkillDir, preflightInstallSkill, readSkillFile, readSkillMd, restoreSkillVersion,
  rollbackMarketplaceReplacement, syncEnvDependencies, uninstallSkill, updateSkillProfile,
  ensureSkillAvatarIdentity,
  type EnvSuggestion,
  type EnvDeclaration,
  readEnvDeclarations,
  writeEnvDeclarations,
  libraryAuthorAsset,
} from '../lib/tauri.js'
import { buildEnvReview, confirmPendingKey, envDeclarationsChanged, envDeclarationsFromDependencies, envDeclarationsFromReview, envReviewIsEmpty, type EnvReview, type EnvReviewRow } from '../lib/env-declaration.js'
import { accountDeleteResult, LIBRARY_ENTRIES_CHANGED_EVENT, requestLibrarySync } from '../lib/library-sync.js'
import {
  ApiError, apiCreateSkillVersion, apiDeleteComment,
  apiCreateMarketplaceInstallIntent, apiFinishMarketplaceInstallIntent,
  apiDeleteMarketplaceComment, apiGetMarketplaceComments, apiPostMarketplaceComment,
  apiAnalyzeSkill, apiDownloadMarketplacePackage, apiDownloadSkillPackage, apiGetComments,
  apiGetMarketplaceSkill, apiGetMarketplaceState, apiGetSkill, apiGetSkillSource, apiGetTeams, apiPostComment, apiGetSkillVersions, apiImportSkill,
  apiShareSkillToTeam, apiUnshareSkill, apiUpdateComment, apiUpdateSkill,
  apiSubmitMarketplaceSkill, apiUnpublishMarketplaceSkill, apiWithdrawMarketplaceSubmission,
} from '../lib/api.js'
import type {
  AgentInfo,
  ImportSkillPreflight,
  SkillDiffLine,
  SkillFilePreview,
  SkillMarkdownInspection,
  SkillVersionState,
  SkillTreeEntry,
} from '../lib/tauri.js'
import type {
  ApiComment, ApiMarketplaceComment, ApiSkillVersion, ApiUser,
  MarketplaceCommentVisibility, MarketplaceState, MarketplaceSubmissionStatus,
} from '../lib/api.js'
import { readAuthSpace } from '../store/index.js'
import { toast } from './Toast.js'
import ConfirmModal from './ConfirmModal.js'
import { aiAnalysisJobKey, runSkillAiAnalysis, type AiAnalysisEnvironment } from '../lib/ai-analysis-job.js'
import { avatarIdentityFor } from '../lib/avatar-identity.js'
import {
  canChangeSkillAvatar, customAvatarErrorMessage, restoreGeneratedSkillAvatar,
  uploadCustomSkillAvatar,
} from '../lib/skill-avatars.js'
import AvatarCropDialog from './AvatarCropDialog.js'
import { pickAvatarSource, type AvatarSource } from '../lib/tauri.js'
import type { CustomAvatarImage } from '../lib/api.js'
import { useShallow } from 'zustand/react/shallow'
import { selectSkillDetailSheetState } from '../lib/store-selectors.js'
import UnmanageSkillDialog from './UnmanageSkillDialog.js'
import DeleteSkillDialog, { type DeleteScope } from './DeleteSkillDialog.js'
import { disableAgentLabel, disabledToastMessage, sharedProjectionAgents, sharedProjectionNote } from '../lib/skill-lifecycle-ui.js'
import { blankDragRegion } from './WindowDragRegion.js'
import FocusTrapDialog from './FocusTrapDialog.js'
import { EmptyState, LoadError, Skeleton, SkeletonBlock } from './StateViews.js'
import { EMPTY_COPY, LOADING_COPY, RETRY_LABEL, loadFailedMessage } from '../lib/state-copy.js'
import { DetectedKeyRow, KeyRequirementList, KeysExplainer, useSkillKeyPolicy } from './SkillKeys.js'
import { ShareKeyLauncher } from './ShareKeyDialog.js'
import MentionComposer, { activeMentionIds } from './MentionComposer.js'
import { KEY_COPY, KEYS_SECTION_TITLE, keySectionElements, keyViewerRole, offerKeyInstallGuide } from '../lib/skill-keys.js'
import {
  canManageSkillAsset, commentScopeTeamId, containedScrollTop, detectedAgentOptions,
  currentAccountServerId, nextRovingIndex, reconcileLocalSkillRefresh, visibleAgentKeys,
} from '../lib/ui-helpers.js'
import {
  currentOwnedServerSkillId, ensureCurrentAccountServerSkill, moveLocalSkillToRecycle,
  shareSkillWithServerSync,
} from '../lib/team-share-flow.js'
import { prepareAccountTeamShare } from '../lib/prepare-account-share.js'
import { findLocalSkillByManagedId, hydrateDownloadedSkill, remoteManagedSkillId } from '../lib/skills.js'
import {
  skillVersionInputError, skillSnapshotSuggestedVersion, skillSnapshotAllocation, skillSnapshotInputError, skillVersionDisplay, mergeSkillVersionHistory,
} from '../lib/versioning.js'
import { SkillProfileCatalog, SkillProfileLabels, SkillQuickAccessButton } from './SkillTagPopover.js'
import './store/StoreUI.css'
import './SkillControls.css'
import './SkillDetailSheet.css'

const TABS: { key: SkillDetailTab; label: string; icon: IconName }[] = [
  { key: 'profile', label: '概览', icon: 'info' },
  { key: 'details', label: '详情', icon: 'doc' },
  { key: 'environment', label: '钥匙', icon: 'key-round' },
  { key: 'versions', label: '版本', icon: 'hist' },
]
type InstallStep = 'agents' | 'confirm' | 'running' | 'done'
type SkillConfirmation = 'uninstall' | 'sync' | 'delete' | null
const PROFILE_CATEGORIES = ['协作与办公', '自动化与集成', '搜索与研究', '内容与创作', '开发与工程', '数据与分析', '其他']
let teamShareJobSequence = 0
const activeSyncJobs = new Set<string>()
function messageOf(error: unknown): string { return userMessage(error) }

type EnvReviewOutcome = { ok: boolean; skill?: LocalSkill }
type EnvReviewState = { skillId: string; review: EnvReview; before: EnvDeclaration[]; checked: Set<string>; resolve: (outcome: EnvReviewOutcome) => void }

/**
 * 发布 / 新版本前的钥匙声明确认清单（#251）。`reviewEnvDeclarations` 读取 SKILL.md
 * 声明与检测建议；三列都为空时直接放行，否则弹窗让作者勾选，确认后只改写
 * `metadata.skillhub.env` 再继续发布。未勾选项不写入。
 */
function useEnvDeclarationReview(): { reviewEnvDeclarations: (skillId: string, envDeps: EnvDep[]) => Promise<EnvReviewOutcome>; envReviewElement: ReactNode } {
  const [state, setState] = useState<EnvReviewState | null>(null)
  const [busy, setBusy] = useState(false)
  const reviewEnvDeclarations = async (skillId: string, envDeps: EnvDep[]): Promise<EnvReviewOutcome> => {
    let declared: EnvDeclaration[]
    let suggestions: EnvSuggestion[]
    try {
      [declared, suggestions] = await Promise.all([readEnvDeclarations(skillId), detectEnvVarSuggestions(skillId)])
    } catch (error: unknown) {
      toast(`钥匙声明检查未完成：${messageOf(error)}`, 'error')
      return { ok: false }
    }
    const review = buildEnvReview(declared, suggestions, envDeps)
    if (envReviewIsEmpty(review)) return { ok: true }
    const checked = new Set([...review.declared, ...review.declaredUndetected, ...review.detectedUndeclared].filter((row) => row.checked).map((row) => row.key))
    return new Promise((resolve) => setState({ skillId, review, before: declared, checked, resolve }))
  }
  const finish = async (confirmed: boolean): Promise<void> => {
    if (!state || busy) return
    if (!confirmed) {
      state.resolve({ ok: false })
      setState(null)
      return
    }
    const deps = envDeclarationsFromReview(state.review, state.checked)
    let written: LocalSkill | undefined
    if (envDeclarationsChanged(state.before, deps)) {
      setBusy(true)
      try { written = await writeEnvDeclarations(state.skillId, deps) }
      catch (error: unknown) { toast(`写入 SKILL.md 声明失败：${messageOf(error)}`, 'error'); return }
      finally { setBusy(false) }
    }
    state.resolve({ ok: true, skill: written })
    setState(null)
  }
  const toggle = (key: string): void => setState((current) => {
    if (!current) return current
    const checked = new Set(current.checked)
    if (checked.has(key)) checked.delete(key)
    else checked.add(key)
    return { ...current, checked }
  })
  const column = (title: string, hint: string, rows: EnvReviewRow[]): ReactNode => <section className="env-review-column" aria-label={title}>
    <h3>{title}<span className="env-review-count">{rows.length}</span></h3>
    <p className="env-review-hint">{hint}</p>
    {rows.length === 0 ? <p className="env-review-empty">无</p> : <ul className="env-review-list">{rows.map((row) => <li key={row.key}>
      <label className="env-review-row">
        <input type="checkbox" checked={state?.checked.has(row.key) ?? false} disabled={busy} onChange={() => toggle(row.key)} />
        <span className="env-review-main">
          <b className="mono">{row.key}</b>
          <span className="env-review-meta">{row.required ? '必填' : '可选'}{row.confidence ? ` · 置信度 ${row.confidence}` : ''}{row.description ? ` · ${row.description}` : ''}</span>
          {row.obtain && <span className="env-review-meta mono">获取：{row.obtain}</span>}
          {row.evidence.length > 0 && <span className="env-review-meta">证据：{row.evidence.slice(0, 2).join('；')}</span>}
        </span>
      </label>
    </li>)}</ul>}
  </section>
  const envReviewElement = state && <FocusTrapDialog className="modal-layer above-sheet" label="确认需要的钥匙" onEscape={() => void finish(false)} escapeDisabled={busy}>
    <div className="modal-card env-review-modal">
      <div className="modal-head"><div><span className="eyebrow">发布前确认</span><h2>这个 Skill 需要哪些钥匙？</h2></div><button className="ico-btn" onClick={() => void finish(false)} disabled={busy} aria-label="关闭钥匙确认"><Icon name="x" size={16} /></button></div>
      <p className="modal-copy">勾选的项会写入 SKILL.md 的 <span className="mono">metadata.skillhub.env</span>，随包和版本一起发布；未勾选的项不会写入。只记录变量名，不包含任何值。</p>
      <div className="env-review-columns">
        {column('已声明', 'SKILL.md 中已有，且检测也找到了', state.review.declared)}
        {column('检测到但未声明', '代码或依赖里用到，建议声明', state.review.detectedUndeclared)}
        {column('已声明但未检测到', '可能由 SDK 隐式读取，确认仍需要再保留', state.review.declaredUndetected)}
      </div>
      <div className="modal-actions"><button className="btn btn-ghost" onClick={() => void finish(false)} disabled={busy}>取消发布</button><button className="btn btn-primary" onClick={() => void finish(true)} disabled={busy}>{busy ? '写入中…' : '确认并继续'}</button></div>
    </div>
  </FocusTrapDialog>
  return { reviewEnvDeclarations, envReviewElement }
}

function localManagedSkillId(skill: LocalSkill): string { return skill.marketplaceLocalId ?? skill.id }
let aiAnalysisJobSequence = 0
// 「AI 分析」 runs from module scope (#181): it keeps going after the detail
// sheet unmounts and writes only through the store and the native bridge.
const aiAnalysisEnvironment: AiAnalysisEnvironment = {
  currentUserId: () => useStore.getState().currentUser?.id ?? null,
  readSpace: readAuthSpace,
  findSkill: (serverId, accountUserId) => useStore.getState().skills.find((item) => (
    item.serverId === serverId && item.serverOwnerId === accountUserId && !item.accountSyncRequired
  )),
  beginJob: (job) => {
    useStore.getState().startAiAnalysisJob(job)
    return useStore.getState().aiAnalysisJobs[job.key]?.id === job.id
  },
  endJob: (key, jobId) => useStore.getState().finishAiAnalysisJob(key, jobId),
  readLocalSkillMd: (skill) => readSkillMd(localManagedSkillId(skill)),
  fetchSource: async (serverId, space) => (await apiGetSkillSource(serverId, space)).skillMd,
  fetchServerProfile: async (serverId, space) => {
    const remote = await apiGetSkill(serverId, space)
    return {
      displayName: remote.displayName,
      description: remote.description ?? null,
      category: remote.category ?? null,
      labels: remote.labels ?? [],
      triggerScenarios: remote.triggerScenarios ?? [],
    }
  },
  analyze: (serverId, skillMd, expectedProfile, space) => apiAnalyzeSkill(serverId, skillMd, { expectedProfile, space: space }),
  writeLocalProfile: async (skill, profile, space) => {
    await updateSkillProfile(localManagedSkillId(skill), {
      serverId: skill.serverId,
      serverOwnerId: skill.serverOwnerId,
      displayName: profile.displayName,
      description: profile.description,
      category: profile.category,
      labels: profile.labels,
      triggerScenarios: profile.fitScenarios,
      compatibleAgents: skill.compatibleAgents,
      version: skill.version,
    }, space)
  },
  replaceSkill: (currentId, updated) => useStore.getState().replaceSkill(currentId, updated),
  notify: (message, kind) => toast(message, kind),
  requestReadback: requestLibrarySync,
  isOnline: () => typeof navigator === 'undefined' || navigator.onLine !== false,
  newJobId: () => `ai-analysis-${Date.now()}-${++aiAnalysisJobSequence}`,
  now: () => Date.now(),
}
function isMarketplaceCatalogSource(skill: LocalSkill): boolean {
  return skill.visibility === 'public'
    && skill.marketplaceStatus === 'approved'
    && skill.marketplaceSkillMd !== undefined
}

/**
 * Detail header title (design-system SkillDetailPage), for store and local Skills alike:
 * the original `name` is the title with the store badges, the friendly `displayName` the
 * subtitle — swapped when the user prefers AI titles, exactly as rows and cards do.
 */
function isTeamDetailSkill(skill: LocalSkill): boolean {
  return Boolean(skill.teamSharedFrom) && !isMarketplaceCatalogSource(skill)
}

function SkillDetailTitle({ skill, onCopyName, problem: problemButton }: { skill: LocalSkill; onCopyName: () => void; problem?: ReactNode }) {
  const preference = useStore((state) => state.skillTitlePreference)
  const title = skillListText(skill, preference)
  // Team Skills show the version as a brand mono tag right after the name (#295 board 9).
  const version = isTeamDetailSkill(skill) ? skillVersionDisplay(skill).label : null
  // Quick access (#325) pins Skills of 「我的 Skills」, not store or team previews.
  const pinnable = useStore((state) => state.skills.some((item) => item.id === skill.id)) && !isMarketplaceCatalogSource(skill) && !isTeamDetailSkill(skill)
  const problem = <>{pinnable && <SkillQuickAccessButton skill={skill} />}{problemButton}</>
  return <>
    <div className="sh-title-row"><h2 className="sh-store-title"><span className={preference === 'skill-name' ? 'skill-primary-name' : undefined} title={title.primary}>{title.primary}</span><button type="button" className="rawname sh-store-copy" title={`复制 Skill 名称：${skill.name}`} aria-label={`复制 Skill 名称 ${skill.name}`} onClick={onCopyName}><Icon name="doc" size={10} /></button><MarketplaceBadges badges={skill.marketplaceBadges} />{version && <span className="sh-title-version mono">{version}</span>}</h2>{problem}</div>
    {title.secondary && <p className={`sh-store-subtitle${preference === 'ai-title' ? ' mono' : ''}`} title={title.secondary}>{title.secondary}</p>}
  </>
}

/** Four-up stats strip; a value the Server did not report is not shown. Uploader / version / 更新于 now live in the origin line. */
function StoreDetailFacts({ skill }: { skill: LocalSkill }) {
  const stats = storeDetailStats(skill)
  return <>
    {stats.length > 0 && <dl className="sh-store-stats" aria-label="Skill 数据">
      {stats.map((stat) => <div key={stat.key} className="sh-store-stat">
        <dt><span className="sh-store-stat-icon" aria-hidden="true"><Icon name={stat.icon} size={16} strokeWidth={1.75} /></span>{stat.label}</dt>
        <dd>{stat.value}</dd>
      </div>)}
    </dl>}
  </>
}

/** `来源 · 作者 <UserChip> · 更新于 <time> · 来源 <link>` under the description, for every Skill (#289 board 1, #330). */
function SkillOriginLineView({ skill }: { skill: LocalSkill }) {
  const currentUserId = useStore((state) => state.currentUser?.id ?? null)
  const teams = useStore((state) => state.teams)
  const teamName = skill.teamSharedFrom ? teams.find((team) => team.id === skill.teamSharedFrom)?.name : undefined
  const line = skillOriginLine(skill, { currentUserId, teamName, storeListing: isMarketplaceCatalogSource(skill) })
  return <p className="sh-origin">
    <span className="sh-origin-source">{line.source}</span>
    {line.author && <><span className="sh-origin-dot" aria-hidden="true">·</span><span className="sh-origin-author">{line.author.label}<UserChip name={line.author.name} me={line.author.me} /></span></>}
    {line.updated && <><span className="sh-origin-dot" aria-hidden="true">·</span><span className="sh-origin-updated">更新于 {line.updated}</span></>}
    <SourceUrlLink url={skill.sourceUrl} leadingDot onOpen={(href) => void openUrl(href).catch((reason: unknown) => toast(messageOf(reason), 'error'))} />
  </p>
}

/**
 * Red 28px icon next to the title when an Agent projection is broken or the Skill's
 * data is unavailable (#289 board 1). Opens a small non-modal dialog with the
 * explanation, 「重新修复」 (the guarded install repair, for every broken Agent) and
 * 「复制诊断信息」. Escape / outside click close it and return focus to the icon.
 */
function SkillProblemButton({ skill, onRepair }: { skill: LocalSkill; onRepair: (agents: string[]) => void }) {
  const lastRun = useStore((state) => state.lastRunFailures[skill.id] ?? null)
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLSpanElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const broken = orderedAgentEntries(skill.agents).filter(([, status]) => status === 'broken').map(([agent]) => agent)
  const count = broken.length + (skill.isOrphan ? 1 : 0)
  useEffect(() => { setOpen(false) }, [skill.id])
  useEffect(() => {
    if (!open) return
    panelRef.current?.querySelector<HTMLButtonElement>('button')?.focus()
    const closeOutside = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      setOpen(false)
      buttonRef.current?.focus()
    }
    document.addEventListener('pointerdown', closeOutside)
    document.addEventListener('keydown', closeOnEscape, true)
    return () => {
      document.removeEventListener('pointerdown', closeOutside)
      document.removeEventListener('keydown', closeOnEscape, true)
    }
  }, [open])
  if (count === 0 || skill.isSystem) return null
  const projection = broken.length > 0
  const copyDiagnostics = (): void => {
    void navigator.clipboard.writeText(skillDiagnosticsText(skill, lastRun))
      .then(() => toast('已复制诊断信息'))
      .catch((error: unknown) => toast(`复制失败：${messageOf(error)}`, 'error'))
  }
  return <span className="sh-problem" ref={rootRef}>
    <button ref={buttonRef} type="button" className="sh-problem-button" aria-label={`有 ${count} 个问题，查看详情`} aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen((value) => !value)}><Icon name="circle-alert" size={16} /></button>
    {open && <div ref={panelRef} className="sh-problem-popover" role="dialog" aria-modal="false" aria-label="问题详情">
      <b className="sh-problem-title"><Icon name="circle-alert" size={14} />{projection ? 'Agent 投影没有刷新' : 'Skill 资料暂不可用'}</b>
      <p>{projection
        ? '投影的身份、权限、硬链接或 current 链接无效。为了安全，SkillHub 保留了原来的投影，没有覆盖。'
        : 'SkillHub 暂时读不到这个 Skill 的资料。为了安全，本机文件和 Agent 投影保持原样，没有覆盖。'}</p>
      {projection && <p className="sh-problem-agents">{broken.map((agent) => agentDisplayName(agent)).join('、')}</p>}
      <div className="sh-problem-actions">
        {projection && skill.localPath && <button type="button" className="btn btn-primary btn-sm" onClick={() => { setOpen(false); onRepair(broken) }}><Icon name="wrench" size={13} />重新修复</button>}
        <button type="button" className="btn btn-ghost btn-sm" onClick={copyDiagnostics}><Icon name="copy" size={13} />复制诊断信息</button>
      </div>
    </div>}
  </span>
}

function isPublicMarketplaceSource(skill: LocalSkill): boolean {
  return isMarketplaceCatalogSource(skill)
    && !canManageSkillAsset(skill)
    && !skill.teamSharedFrom
}
function sameAgentPreflightState(left: ImportSkillPreflight, right: ImportSkillPreflight): boolean {
  const targetState = (plan: ImportSkillPreflight) => plan.sources.map((source) => ({
    agentKey: source.agentKey,
    path: source.path,
    canonicalPath: source.canonicalPath,
    fingerprint: source.fingerprint,
    matchesSelected: source.matchesSelected,
  }))
  return left.hasConflicts === right.hasConflicts
    && JSON.stringify(targetState(left)) === JSON.stringify(targetState(right))
}

type SkillDetailMode = 'overlay' | 'workspace'

export default function SkillDetailSheet({ skillId, tab, focus, mode = 'overlay' }: { skillId: string; tab: SkillDetailTab; focus?: SkillDetailFocus; mode?: SkillDetailMode }) {
  const profile = useSpaceCapabilities().profile
  const {
    skills, marketplaceSkills, setSkills, setMarketplaceSkills, replaceSkill: replaceSkillInStore,
    closeSheet, setSheetTab, currentUser, promptForAuth, teams, activeTeamId, view,
  } = useStore(useShallow(selectSkillDetailSheetState))
  const skill = resolveSkillFromSources(skillId, skills, marketplaceSkills)
  const descriptionRef = useRef<HTMLParagraphElement>(null)
  const [descriptionOverflow, setDescriptionOverflow] = useState(false)
  const [descriptionOpen, setDescriptionOpen] = useState(false)
  useLayoutEffect(() => {
    setDescriptionOpen(false)
    const element = descriptionRef.current
    if (!element) {
      setDescriptionOverflow(false)
      return
    }
    const measure = (): void => setDescriptionOverflow(descriptionOverflows(element))
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    window.addEventListener('resize', measure)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [skillId, skill?.description, mode])
  const unanalysed = profile === 'selfhost' && skill?.serverAnalysisStatus === 'unanalysed'
  const detailTabs = skill?.isSystem
    ? TABS.filter((item) => item.key === 'profile' || item.key === 'details')
    : TABS
  const [installOpen, setInstallOpen] = useState(false)
  const [marketUpdateOpen, setMarketUpdateOpen] = useState(false)
  const [marketBusy, setMarketBusy] = useState(false)
  const [installStep, setInstallStep] = useState<InstallStep>('agents')
  const [agents, setAgents] = useState<AgentInfo[]>([])
  const [agentsLoading, setAgentsLoading] = useState(true)
  const [selectedAgents, setSelectedAgents] = useState<string[]>([])
  const [installPreflight, setInstallPreflight] = useState<ImportSkillPreflight | null>(null)
  const [installPreflightLoading, setInstallPreflightLoading] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [confirmation, setConfirmation] = useState<SkillConfirmation>(null)
  const [unmanageOpen, setUnmanageOpen] = useState(false)
  const [lifecycleBusy, setLifecycleBusy] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [syncBusy, setSyncBusy] = useState(false)
  const bodyRef = useRef<HTMLDivElement>(null)
  const manageMenuRef = useRef<HTMLDetailsElement>(null)
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([])
  const agentLoadGenerationRef = useRef(0)
  const installIntentRef = useRef<Promise<string | undefined> | null>(null)
  const ensureMarketplaceInstallIntent = (): Promise<string | undefined> => {
    if (!skill || !isMarketplaceCatalogSource(skill) || !skill.serverId) return Promise.resolve(undefined)
    if (!installIntentRef.current) {
      installIntentRef.current = apiCreateMarketplaceInstallIntent(
        skill.serverId,
        `app:${crypto.randomUUID()}`,
      ).then((intent) => intent?.id).catch(() => undefined)
    }
    return installIntentRef.current
  }
  const onTabKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number): void => {
    const nextIndex = nextRovingIndex(index, detailTabs.length, event.key, 'horizontal')
    if (nextIndex === null) return
    event.preventDefault()
    const nextTab = detailTabs[nextIndex]
    if (!nextTab) return
    setSheetTab(nextTab.key)
    tabRefs.current[nextIndex]?.focus()
  }
  async function openInstall(preferredAgents?: string[]): Promise<void> {
    setActionError(null); setInstallPreflight(null); setInstallOpen(true); setInstallStep('agents')
    void ensureMarketplaceInstallIntent()
    const generation = ++agentLoadGenerationRef.current
    setAgentsLoading(true)
    try {
      const detected = await getInstalledAgents()
      if (generation !== agentLoadGenerationRef.current) return
      setAgents(detected)
      const availableAgentKeys = detectedAgentOptions(detected).filter(agentAcceptsSkillWrites).map((agent) => agent.key)
      setSelectedAgents(preferredAgents
        ? availableAgentKeys.filter((key) => preferredAgents.includes(key))
        : availableAgentKeys)
    } catch (error: unknown) {
      if (generation !== agentLoadGenerationRef.current) return
      setAgents([])
      setSelectedAgents([])
      setActionError(messageOf(error))
    } finally {
      if (generation === agentLoadGenerationRef.current) setAgentsLoading(false)
    }
  }
  useEffect(() => {
    const closeManageMenuOutside = (event: PointerEvent): void => {
      const menu = manageMenuRef.current
      if (menu?.open && !menu.contains(event.target as Node)) menu.open = false
    }
    document.addEventListener('pointerdown', closeManageMenuOutside)
    return () => document.removeEventListener('pointerdown', closeManageMenuOutside)
  }, [])
  useEffect(() => {
    if (skill?.isSystem && tab !== 'profile' && tab !== 'details') {
      setSheetTab('profile')
    }
  }, [setSheetTab, skill?.isSystem, tab])
  useEffect(() => {
    const generation = ++agentLoadGenerationRef.current
    let active = true
    setAgentsLoading(true)
    void getInstalledAgents()
      .then((detected) => { if (active && generation === agentLoadGenerationRef.current) setAgents(detected) })
      .catch(() => { if (active && generation === agentLoadGenerationRef.current) setAgents([]) })
      .finally(() => { if (active && generation === agentLoadGenerationRef.current) setAgentsLoading(false) })
    return () => {
      active = false
      if (generation === agentLoadGenerationRef.current) agentLoadGenerationRef.current += 1
    }
  }, [skillId])
  useEffect(() => {
    if (!focus) return
    if (focus === 'install' || focus.startsWith('install:')) {
      const preferredAgent = focus.startsWith('install:') ? focus.slice('install:'.length) : null
      void openInstall(preferredAgent ? [preferredAgent] : undefined)
      return
    }
    if (focus === 'delete') {
      setDeleteError(null)
      setConfirmation('delete')
      return
    }
    const targetTab: SkillDetailTab = focus === 'env' ? 'environment' : 'profile'
    if (tab !== targetTab) {
      setSheetTab(targetTab)
      return
    }
    const frame = window.requestAnimationFrame(() => {
      const body = bodyRef.current
      const section = focus.startsWith('comment:') ? 'discuss' : focus.startsWith('share:') ? 'share' : focus
      const target = body?.querySelector<HTMLElement>(`#skill-detail-${section}`)
      if (!body || !target) return
      body.scrollTo({
        top: containedScrollTop(body.scrollTop, body.getBoundingClientRect().top, target.getBoundingClientRect().top),
        behavior: 'smooth',
      })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [focus, setSheetTab, skillId, tab])
  const { reviewEnvDeclarations, envReviewElement } = useEnvDeclarationReview()
  const capabilities = useSpaceCapabilities()
  const offlineAt = useCatalogOffline()
  if (!skill) return null
  const versionDisplay = skillVersionDisplay(skill)
  const managedSkillId = localManagedSkillId(skill)
  const marketAction = marketplaceAction(skill)
  const acquireFromStore = async (update = false): Promise<void> => {
    if (catalogOfflineAt()) { toast(CATALOG_INSTALL_OFFLINE, 'error'); return }
    if (marketBusy || !skill.serverId) return
    setMarketBusy(true)
    let receipt: string | undefined
    try {
      const acquisitionSpace = await currentSpace()
      const detail = await apiGetMarketplaceSkill(skill.serverId)
      if (!update) receipt = await apiCreateMarketplaceInstallIntent(skill.serverId, `app:${crypto.randomUUID()}`, 'app', 'join').then(value => value?.id).catch(() => undefined)
      const local = await acquireMarketplaceSkill({ ...skill, version: detail.version.version, marketplacePackageSha256: detail.version.packageSha256 ?? undefined }, {
        spaceId: acquisitionSpace.spaceId,
        currentUserId: useStore.getState().currentUser?.id, localSkills: getLocalSkills, download: apiDownloadMarketplacePackage, importPackage: (data) => importSkillPackage(data, acquisitionSpace),
      }, update)
      replaceSkillInStore(local.id, local)
      setMarketUpdateOpen(false)
      if (receipt) void apiFinishMarketplaceInstallIntent(receipt, 'completed').catch(() => undefined)
      toast(update ? 'Skill 已更新' : '已加入我的 Skills')
      if (!update) offerKeyInstallGuide(local)
    } catch (error: unknown) { if (receipt) void apiFinishMarketplaceInstallIntent(receipt, 'failed').catch(() => undefined); toast(messageOf(error), 'error') }
    finally { setMarketBusy(false) }
  }

  const replaceSkill = (updated: LocalSkill): void => {
    // Atomically retarget the open sheet when a remote-only asset receives its
    // real local id, preserving the mounted install modal and completion state.
    replaceSkillInStore(skill.id, updated)
  }
  // Managed folder identity can differ from the Agent-facing Skill name for
  // downloaded/team assets. Always refresh by the immutable local id so an
  // uninstall or projection repair cannot leave the card in a stale state.
  const localSkill = async (localId = managedSkillId): Promise<LocalSkill | undefined> => {
    const refreshed = await getLocalSkill(localId)
    if (!refreshed) return undefined
    const current = useStore.getState().skills.find((item) => item.id === localId)
    return current ? reconcileLocalSkillRefresh(current, refreshed) : refreshed
  }
  const refreshLocal = async (localId = managedSkillId): Promise<void> => {
    const updated = await localSkill(localId)
    if (updated) replaceSkill(updated)
  }
  const restoreMarketplaceStateAfterRollback = async (): Promise<void> => {
    const restored = await localSkill(skill.marketplaceReplacementLocalId)
    if (restored) {
      const currentSkills = useStore.getState().skills
      setSkills(currentSkills.map((item) => item.id === restored.id ? restored : item))
    }
    const currentMarketplace = useStore.getState().marketplaceSkills
    setMarketplaceSkills(currentMarketplace.map((item) => item.id === skill.id
      ? { ...skill, installCount: Math.max(skill.installCount, item.installCount) }
      : item))
  }
  const reviewInstall = async (): Promise<void> => {
    if (selectedAgents.length === 0) return
    setActionError(null)
    setInstallPreflight(null)
    const preflightLocalId = skill.marketplaceReplacementLocalId
      ?? (skill.localPath ? managedSkillId : null)
    if (!preflightLocalId) {
      setInstallStep('confirm')
      return
    }
    setInstallPreflightLoading(true)
    try {
      setInstallPreflight(await preflightInstallSkill(preflightLocalId, selectedAgents))
      setInstallStep('confirm')
    } catch (error: unknown) {
      setActionError(messageOf(error))
    } finally {
      setInstallPreflightLoading(false)
    }
  }
  const executeInstall = async (): Promise<void> => {
    if (!skill.localPath && isMarketplaceCatalogSource(skill) && catalogOfflineAt()) {
      setActionError(CATALOG_INSTALL_OFFLINE)
      return
    }
    if (selectedAgents.length === 0) return
    setInstallStep('running'); setActionError(null)
    let replacementRecoveryId: string | undefined
    let marketplaceIntentId: string | undefined
    // Set only when this run downloaded the package (a store or team acquisition).
    let acquired: { id: string; acquisitionSource: string; envDeps: LocalSkill['envDeps'] } | null = null
    try {
      const installSpace = await currentSpace()
      marketplaceIntentId = await ensureMarketplaceInstallIntent()
      let localId = managedSkillId
      let currentAsset = skill
      if (!skill.localPath) {
        if (!skill.serverId) throw new Error('该资产缺少服务端标识，无法下载')
        const serverOwnerId = skill.serverOwnerId ?? currentUser?.id
        if (!serverOwnerId) throw new Error('该资产缺少服务端归属信息，无法安全下载')
        const marketplaceInstall = isMarketplaceCatalogSource(skill)
        const acquisitionSource = marketplaceInstall ? 'marketplace' : skill.teamSharedFrom ? 'team' : 'local'
        if (acquisitionSource === 'team' && !currentUser?.id) {
          throw new Error('安装团队 Skill 前请先登录当前账号')
        }
        const packageData = marketplaceInstall
          ? await apiDownloadMarketplacePackage(skill.serverId)
          : await apiDownloadSkillPackage(skill.serverId)
        if (marketplaceInstall) {
          if (!skill.marketplacePackageSha256) {
            throw new Error('商店审核版本缺少固定包校验值，请刷新后重试')
          }
          if (packageData.sha256.toLowerCase() !== skill.marketplacePackageSha256.toLowerCase()
            || packageData.version !== skill.version) {
            throw new Error('商店版本已更新，本次未安装任何内容，请刷新后重新确认')
          }
        }
        const downloadedSkill = { ...skill, installCount: skill.installCount + 1 }
        const imported = await importSkillPackage({
          skillId: skill.marketplaceReplacementLocalId
            ?? remoteManagedSkillId(skill.name, skill.serverId, marketplaceInstall ? installSpace.spaceId : undefined),
          name: skill.name,
          packageBase64: packageData.base64, expectedSha256: packageData.sha256,
          serverId: skill.serverId, serverOwnerId, displayName: skill.displayName, description: skill.description,
          sourceUrl: skill.sourceUrl, category: skill.category, labels: skill.labels, version: packageData.version,
          teamId: skill.teamSharedFrom, teamIds: Object.keys(skill.sharedTo), isOwn: skill.isOwn,
          acquisitionSource,
          catalogOrigin: marketplaceInstall ? OFFICIAL_ENDPOINTS.catalogOrigin.replace(/\/+$/, '') : undefined,
          acquiredByUserId: acquisitionSource === 'team' ? currentUser?.id : undefined,
          replaceExistingMarketplace: marketplaceInstall
            && Boolean(skill.marketplaceReplacementLocalId),
          installCount: downloadedSkill.installCount, createdAt: skill.createdAt, updatedAt: skill.updatedAt,
          triggerScenarios: skill.fitScenarios ?? [], compatibleAgents: skill.compatibleAgents,
          envDependencies: skill.envDeps.map(({ key, description, required, sharePolicy, sharedTeams }) => ({
            key, description, required, sharePolicy, sharedTeams: sharedTeams ?? [],
          })),
        }, installSpace)
        replacementRecoveryId = imported.marketplaceReplacementRecoveryId
        localId = imported.id
        acquired = { id: imported.id, acquisitionSource: imported.acquisitionSource ?? acquisitionSource, envDeps: imported.envDeps }
        currentAsset = hydrateDownloadedSkill(downloadedSkill, imported)
        replaceSkillInStore(skill.id, currentAsset)
      }

      const plan = await preflightInstallSkill(localId, selectedAgents)
      if (replacementRecoveryId
        && plan.sources.length > 0
        && (!installPreflight || !sameAgentPreflightState(installPreflight, plan))) {
        await rollbackMarketplaceReplacement(replacementRecoveryId)
        replacementRecoveryId = undefined
        await restoreMarketplaceStateAfterRollback()
        setInstallPreflight(plan)
        setActionError('商店审核版本与 Agent 中同名 Skill 的内容不同，请确认后备份并安装。')
        setInstallStep('confirm')
        return
      }
      if (!replacementRecoveryId && plan.sources.length > 0 && installPreflight?.planDigest !== plan.planDigest) {
        setInstallPreflight(plan)
        setInstallStep('confirm')
        return
      }
      await installSkill(localId, selectedAgents, {
        replaceConflicts: plan.hasConflicts,
        planDigest: plan.planDigest,
      })
      const refreshed = await localSkill(localId)
      if (refreshed) replaceSkillInStore(localId, reconcileLocalSkillRefresh(currentAsset, refreshed))
      setInstallStep('done')
      if (marketplaceIntentId) void apiFinishMarketplaceInstallIntent(marketplaceIntentId, 'completed').catch(() => undefined)
      toast(`「${skill.displayName}」已真实安装`)
      // Store and team installs join the account library right away.
      requestLibrarySync()
      if (acquired) offerKeyInstallGuide(acquired)
    } catch (error: unknown) {
      if (marketplaceIntentId) void apiFinishMarketplaceInstallIntent(marketplaceIntentId, 'failed').catch(() => undefined)
      let message = messageOf(error)
      if (replacementRecoveryId) {
        try {
          await rollbackMarketplaceReplacement(replacementRecoveryId)
          await restoreMarketplaceStateAfterRollback()
          message = `${message}。已自动恢复更新前版本`
        } catch (rollbackError: unknown) {
          message = `${message}。自动恢复未完成：${messageOf(rollbackError)}`
        }
        setInstallPreflight(null)
        setInstallStep('agents')
      } else {
        setInstallStep('confirm')
      }
      setActionError(message)
    }
  }
  const remove = async (): Promise<void> => {
    if (lifecycleBusy) return
    setLifecycleBusy(true)
    try { await uninstallSkill(managedSkillId); await refreshLocal(); setConfirmation(null); toast('已从所有工具移除，SkillHub 中仍保留') }
    catch (error: unknown) { toast(`移除失败：${messageOf(error)}`, 'error') }
    finally { setLifecycleBusy(false) }
  }
  const syncToServer = async (announce = true): Promise<LocalSkill | null> => {
    if (!capabilities.uploads || !skill.localPath) return null
    if (!currentUser) {
      setConfirmation(null)
      promptForAuth({ reason: '登录后可由 AI 完善资料，并同步到云端或团队' })
      return null
    }
    const accountUserId = currentUser.id
    const accountSpace = readAuthSpace()
    if (!accountSpace) {
      toast('登录状态已失效，请重新登录', 'error')
      return null
    }
    const jobKey = `${accountSpace.spaceId}:${accountSpace.generation}:${accountUserId}:${managedSkillId}`
    if (activeSyncJobs.has(jobKey)) {
      if (announce) toast('这个 Skill 正在重新同步')
      return null
    }
    activeSyncJobs.add(jobKey)
    setSyncBusy(true)
    const sessionStillMatches = (): boolean => (
      useStore.getState().currentUser?.id === accountUserId
      && readAuthSpace() === accountSpace
    )
    try {
      if (useStore.getState().librarySyncEnabled) {
        // Synced Skills become author assets from their account card, so the
        // GUI, the CLI and other devices all map to one server Skill.
        if (skill.libraryAccountId !== accountUserId || !skill.libraryEntryId) {
          requestLibrarySync()
          throw new Error('这个 Skill 正在同步到账号，请稍后再试')
        }
        const asset = await libraryAuthorAsset(managedSkillId)
        if (!sessionStillMatches()) throw new Error('登录账号已经切换，请重试')
        const published = {
          ...skill,
          serverId: asset.serverId,
          serverOwnerId: asset.serverOwnerId,
          accountSyncRequired: undefined,
          teamSharedFrom: undefined,
          sharedTo: {},
          isOwn: true,
        }
        replaceSkill(published)
        if (announce) toast(`「${skill.displayName}」已发布为我的 Skill`)
        return published
      }
      if (!capabilities.ai) throw new Error('此服务器未提供无需 AI 的旧版上传方式，请使用账号同步库')
      // 发布前确认钥匙声明（#251）：写回 SKILL.md 后才打包，包内自带声明。
      const reviewed = await reviewEnvDeclarations(managedSkillId, skill.envDeps)
      if (!reviewed.ok) return null
      if (reviewed.skill) replaceSkill(reconcileLocalSkillRefresh(skill, reviewed.skill))
      const envDeps = (reviewed.skill ?? skill).envDeps
      if (!sessionStillMatches()) throw new Error('登录账号已经切换，请重试')
      const [skillMd, packageData, deviceAvatarId] = await Promise.all([
        readSkillMd(managedSkillId), createSkillPackage(managedSkillId), ensureSkillAvatarIdentity(managedSkillId),
      ])
      if (!sessionStillMatches()) throw new Error('登录账号已经切换，请重试')
      // The avatar is registered under the account's stable identity from the
      // first server-side registration on; the device id travels as an alias.
      const avatarIdentity = avatarIdentityFor(skill, currentUser.id, deviceAvatarId)
      const localSource = validateSourceUrl(skill.sourceUrl)
      const result = await apiImportSkill({
        ...(localSource.ok && localSource.value ? { sourceUrl: localSource.value } : {}),
        name: skill.name, localSkillId: avatarIdentity?.stableId ?? deviceAvatarId, aliasLocalIds: avatarIdentity?.aliasLocalIds, skillMd, compatibleAgents: skill.compatibleAgents, currentVersion: skill.version,
        envDependencies: envDeps.map(({ key, description, required, obtain }) => ({ key, description, required, obtain })),
        aiAnalysisConsent: true, packageBase64: packageData.base64, packageSha256: packageData.sha256,
      }, accountSpace)
      if (!sessionStillMatches()) throw new Error('登录账号已经切换，未写入本机云端关联')
      const updated = await updateSkillProfile(managedSkillId, {
        serverId: result.skill.id, serverOwnerId: result.skill.authorId,
        displayName: result.skill.displayName, description: result.skill.description,
        category: result.skill.category, labels: result.skill.labels,
        triggerScenarios: result.skill.triggerScenarios, compatibleAgents: result.skill.compatibleAgents,
        version: result.skill.currentVersion,
      }, accountSpace)
      if (!sessionStillMatches()) throw new Error('登录账号已经切换，请重新同步当前账号')
      const normalized = {
        ...updated,
        accountSyncRequired: undefined,
        teamSharedFrom: undefined,
        sharedTo: {},
        isOwn: true,
      }
      replaceSkill(normalized)
      const analysisMessage = result.analysis.status === 'completed'
        ? '资料已完善'
        : result.analysis.status === 'recovered'
          ? '已恢复云端关联'
          : '现有资料已保留，可稍后重试分析'
      if (announce) toast(`「${result.skill.displayName}」已同步；${analysisMessage}`)
      return normalized
    } catch (error: unknown) {
      toast(`同步失败：${messageOf(error)}`, 'error')
      return null
    } finally {
      activeSyncJobs.delete(jobKey)
      setSyncBusy(false)
    }
  }
  const deleteAsset = async (scope: DeleteScope): Promise<void> => {
    if (lifecycleBusy) return
    setLifecycleBusy(true)
    setDeleteError(null)
    if (scope === 'account') {
      try {
        // Online only. A rejection happens before the account is contacted.
        const outcome = await libraryDeleteFromAccount(managedSkillId)
        const result = accountDeleteResult(skill.displayName, outcome)
        if (result.kind === 'kept') {
          // Read back as still in the account: keep the dialog open to retry.
          setDeleteError(result.message)
          return
        }
        setConfirmation(null)
        if (result.kind === 'done') {
          setSkills(useStore.getState().skills.filter((item) => item.id !== managedSkillId))
          closeSheet()
          toast(result.message)
        } else {
          // Account done but this copy pending, or the account result unknown:
          // the copy stays visible until a retry or the next sync pass settles it.
          toast(result.message, 'warn')
          window.dispatchEvent(new Event('skillhub-local-changed'))
        }
        window.dispatchEvent(new Event(LIBRARY_ENTRIES_CHANGED_EVENT))
        requestLibrarySync()
      } catch (error: unknown) {
        // Nothing was sent this time; an earlier attempt's result is not known here.
        setDeleteError(`这次没有发出删除请求：${messageOf(error)}`)
      } finally { setLifecycleBusy(false) }
      return
    }
    try {
      await moveLocalSkillToRecycle({
        skill,
        currentUserId: currentUser?.id,
        deleteLocal: async () => {
          if (skill.localPath) await deleteManagedSkill(managedSkillId)
        },
      })
      setSkills(useStore.getState().skills.filter((item) => item.id !== managedSkillId))
      setConfirmation(null)
      closeSheet()
      toast(`「${skill.displayName}」已移入本机回收站`)
    } catch (error: unknown) {
      toast(`移入回收站未完整完成：${messageOf(error)}`, 'error')
    } finally { setLifecycleBusy(false) }
  }

  const installAgents = detectedAgentOptions(agents)
  const adoptionAgentNames = installPreflight
    ? Array.from(new Set(installPreflight.sources.map((source) => source.agentName)))
    : []
  const detailTeamId = skill.teamSharedFrom
    ?? (activeTeamId && skill.sharedTo?.[activeTeamId] ? activeTeamId : undefined)
  const detailTeamName = detailTeamId
    ? teams.find((team) => team.id === detailTeamId)?.name
    : undefined
  const keyAttention = skill.isSystem ? 0 : envDepsNeedingAttention(skill.envDeps)
  const teamDetail = isTeamDetailSkill(skill)
  const copySkillName = (): void => {
    void navigator.clipboard.writeText(skill.name).then(() => toast('Skill 名称已复制')).catch((error: unknown) => toast(`复制失败：${messageOf(error)}`, 'error'))
  }
  const detailContent = <>
    {offlineAt && isMarketplaceCatalogSource(skill) && <div className="banner" role="status">{catalogOfflineMessage(offlineAt)}；{CATALOG_INSTALL_OFFLINE}</div>}
      {marketUpdateOpen && <ConfirmModal title={`更新「${skill.displayName}」？`} description={`从 ${skill.marketplaceLocalVersion} 更新到 ${skill.version}。当前版本完整备份到回收站，保留已有 Agent 安装与配置。`} confirmLabel="备份并更新" busy={marketBusy} onCancel={() => setMarketUpdateOpen(false)} onConfirm={() => void acquireFromStore(true)} />}
      <div className="sh-head" {...blankDragRegion()}>{mode === 'overlay' && <button className="ico-btn sh-close" onClick={closeSheet} title="关闭" aria-label="关闭 Skill 详情"><Icon name="x" size={17} /></button>}<div className="sh-id" {...blankDragRegion()}>
        {isMarketplaceCatalogSource(skill)
          ? <SkillAvatarIcon className="sh-cat-icon sh-store-avatar" avatarUrl={skill.avatarUrl} status={skill.avatarStatus} size={64} />
          : <SkillAvatarControl key={skill.id} skill={skill} />}<div className="sh-idtx" {...blankDragRegion()}><SkillDetailTitle skill={skill} onCopyName={copySkillName} problem={<SkillProblemButton skill={skill} onRepair={(brokenAgents) => void openInstall(brokenAgents)} />} />{skill.description && <><p ref={descriptionRef} className="sh-desc">{skill.description}</p>{descriptionOverflow && <button type="button" className="connection-link sh-desc-more" aria-haspopup="dialog" onClick={(event) => { event.currentTarget.focus(); setDescriptionOpen(true) }}>更多</button>}</>}{isMarketplaceCatalogSource(skill) && <EditorialLabels labels={editorialLabelsBesideBadges(skill.marketplaceEditorialLabels, skill.marketplaceBadges)} limit={0}/>}<div className="sh-meta" {...blankDragRegion()}>{unanalysed && <span className="chip">未分析</span>}{skill.category && <span className="tsh-tag">{skill.category}</span>}{skill.labels.slice(0, 3).map((label) => <span key={label} className="tsh-tag">{label}</span>)}{!teamDetail && <span className="tsh-tag tsh-tag-brand mono">{versionDisplay.label}</span>}{skill.versionStatus === 'pending' && <span className="tsh-tag">待确认</span>}{skill.hasWorkingCopy && <span className="tsh-tag">已修改</span>}{skill.formalLabel && skill.formalLabel !== skill.version && <span className="tsh-tag">上游 {skill.formalLabel}</span>}{detailTeamName && <span className="tsh-tag"><Icon name="team" size={13} strokeWidth={1.75} className="tsh-icon" />来自 {detailTeamName}</span>}</div><SkillOriginLineView skill={skill} />{isMarketplaceCatalogSource(skill) && <StoreDetailFacts skill={skill} />}{versionDisplay.problem && <p className="banner banner-error" role="status">{versionDisplay.problem}</p>}<AvatarStatusRow skill={skill} /></div>
        <div className="sh-act" {...blankDragRegion()}>{skill.localPath && !skill.isSystem && <details ref={manageMenuRef} className="skill-manage-menu"><summary className="btn btn-ghost">管理 Skill</summary><div><button className="btn btn-ghost" onClick={() => { manageMenuRef.current?.removeAttribute('open'); setConfirmation('uninstall') }}>在所有 Agent 停用</button><button className="btn btn-ghost" onClick={() => { manageMenuRef.current?.removeAttribute('open'); setUnmanageOpen(true) }}>取消 SkillHub 托管</button><button className="btn btn-danger-soft" onClick={() => { manageMenuRef.current?.removeAttribute('open'); setDeleteError(null); setConfirmation('delete') }}>删除…</button></div></details>}{skill.isSystem ? <span className="tsh-tag tsh-tag-brand"><Icon name="check" size={13} strokeWidth={1.75} className="tsh-icon" />系统自动维护</span> : isMarketplaceCatalogSource(skill) ? <button className={`btn btn-ghost btn-lg${marketAction.update ? ' marketplace-update' : ''}`} title={offlineAt ? CATALOG_INSTALL_OFFLINE : undefined} disabled={Boolean(offlineAt) || marketBusy || (marketAction.joined && !marketAction.update)} onClick={() => marketAction.update ? setMarketUpdateOpen(true) : void acquireFromStore()}>{marketBusy ? '处理中…' : marketAction.label}</button> : !skill.localPath && (skill.marketplaceReplacementLocalId
          ? <button className="btn btn-primary btn-lg" onClick={() => void openInstall()}><Icon name="import" size={15} />更新到商店审核版本</button>
          // #295 board 9: a 36px brand icon button 「获取到本机」 replaces the 「下载并安装」 text button.
          : <button type="button" className="btn btn-primary sh-get-btn" aria-label="获取到本机" title="获取到本机" onClick={() => void openInstall()}><Icon name="download" size={17} /></button>)}</div>
      </div><div className="sh-tabs" role="tablist" aria-label="Skill 详情栏目" {...blankDragRegion()}>{detailTabs.map((item, index) => <button key={item.key} ref={(element) => { tabRefs.current[index] = element }} id={`skill-detail-tab-${item.key}`} role="tab" aria-selected={tab === item.key} aria-controls={`skill-detail-panel-${item.key}`} tabIndex={tab === item.key ? 0 : -1} className={`sh-tab${tab === item.key ? ' on' : ''}`} onClick={() => setSheetTab(item.key)} onKeyDown={(event) => onTabKeyDown(event, index)}><Icon name={item.icon} size={14} /><span>{item.label}</span>{item.key === 'environment' && keyAttention > 0 && <span className="sh-tab-count" aria-label={`${keyAttention} 把钥匙需要处理`}>{keyAttention}</span>}</button>)}</div></div>
      <div className="sh-body" ref={bodyRef} id={`skill-detail-panel-${tab}`} role="tabpanel" aria-labelledby={`skill-detail-tab-${tab}`} tabIndex={0}>
        {tab === 'profile' && <ProfileTab skill={skill} installedAgents={agents} agentsLoading={agentsLoading} replaceSkill={replaceSkill} onRefresh={() => refreshLocal()} onRepairAgent={(agent) => void openInstall([agent])} onSync={(announce) => syncToServer(announce)} onRequestSync={() => currentUser ? activeSyncJobs.has(`${currentUser.id}:${managedSkillId}`) ? toast('这个 Skill 正在重新同步') : setConfirmation('sync') : promptForAuth({ reason: '登录后可由 AI 完善资料，并同步到云端或团队' })} syncBusy={syncBusy} onDelete={() => { setDeleteError(null); setConfirmation('delete') }} showDiscussion={view !== 'skills'} discussionTargetId={focus?.startsWith('comment:') ? focus.slice('comment:'.length) : undefined} />}
        {tab === 'details' && <DetailsTab skill={skill} />}
        {tab === 'environment' && <EnvironmentTab skill={skill} replaceSkill={replaceSkill} />}
        {tab === 'versions' && <VersionsTab key={`${currentUser?.id ?? 'guest'}:${managedSkillId}`} skill={skill} replaceSkill={replaceSkill} />}
      </div>
  </>
  return <>
    {mode === 'workspace'
      ? <section className="detail-sheet workspace on" aria-label={`${skill.displayName} 详情`}>{detailContent}</section>
      : <FocusTrapDialog className="detail-sheet on pop-in" label={`${skill.displayName} 详情`} onEscape={closeSheet}>{detailContent}</FocusTrapDialog>}
    {descriptionOpen && <FocusTrapDialog className="modal-layer above-sheet" label={`${skill.displayName} 完整描述`} onEscape={() => setDescriptionOpen(false)}>
      <div className="modal-card sh-description-modal">
        <div className="modal-head"><h2>{skill.displayName}</h2><button type="button" className="ico-btn" onClick={() => setDescriptionOpen(false)} aria-label="关闭完整描述"><Icon name="x" size={16} /></button></div>
        <p className="modal-copy" tabIndex={0}>{skill.description}</p>
      </div>
    </FocusTrapDialog>}
    {installOpen && <FocusTrapDialog className="modal-layer above-sheet" label={`安装 ${skill.displayName}`} onEscape={() => setInstallOpen(false)} escapeDisabled={installStep === 'running'}><div className="modal-card skill-dialog compact"><div className="modal-head"><div><span className="eyebrow">安装 Skill · {installStep === 'agents' ? '1/4' : installStep === 'confirm' ? '2/4' : installStep === 'running' ? '3/4' : '4/4'}</span><h2>{skill.displayName}</h2></div><button className="ico-btn" onClick={() => installStep !== 'running' && setInstallOpen(false)} disabled={installStep === 'running'} aria-label="关闭安装对话框"><Icon name="x" size={16} /></button></div>
      {installStep === 'agents' && <><p className="modal-copy">选择要安装到的工具。</p>{agentsLoading ? <SkeletonBlock layout="rows" count={2} compact label={LOADING_COPY.installAgents} /> : installAgents.length === 0 ? <EmptyState variant="inline" copy={EMPTY_COPY.installNoAgents} /> : <div className="agent-picker">{installAgents.map((agent) => <label key={agent.key} title={agentAcceptsSkillWrites(agent) ? undefined : UNCONFIRMED_SKILL_ROOT_HINT}><input type="checkbox" checked={selectedAgents.includes(agent.key)} disabled={!agentAcceptsSkillWrites(agent)} onChange={(event) => { setInstallPreflight(null); setSelectedAgents((current) => event.target.checked ? [...current, agent.key] : current.filter((key) => key !== agent.key)) }} /><span><b>{agent.name}</b><small>{agentAcceptsSkillWrites(agent) ? '已检测' : 'Skill 目录未确认'} · {agent.dir}</small></span></label>)}</div>}{actionError && <div className="banner banner-error"><Icon name="warn" size={14} />{actionError}</div>}<div className="modal-actions"><button className="btn btn-ghost" onClick={() => setInstallOpen(false)}>取消</button><button className="btn btn-primary" disabled={agentsLoading || installPreflightLoading || selectedAgents.length === 0} onClick={() => void reviewInstall()}>{installPreflightLoading ? '正在检查…' : '下一步'}</button></div></>}
      {installStep === 'confirm' && <><div className="selection-box"><b>安装目标</b><span>{installAgents.filter((agent) => selectedAgents.includes(agent.key)).map((agent) => agent.name).join('、')}</span><b>数据来源</b><span>{skill.localPath ? 'SkillHub 本机文件' : isMarketplaceCatalogSource(skill) ? '商店版本' : '云端版本'}</span></div>{skill.marketplaceReplacementLocalId && <div className="banner banner-info"><Icon name="hist" size={14} /><div><b>更新到商店审核版本</b><span>当前托管目录会先完整备份到设置中的回收站。下载、校验或新版本准备失败时，现有 Skill 和 Agent 投影不会变化。</span></div></div>}{adoptionAgentNames.length > 0 && <div className={`banner import-conflict-note ${installPreflight?.hasConflicts ? 'banner-warn' : 'banner-info'}`}><Icon name={installPreflight?.hasConflicts ? 'warn' : 'info'} size={14} /><div><b>{adoptionAgentNames.join('、')} 中已有同名 Skill</b><span>{installPreflight?.hasConflicts ? '内容与当前 SkillHub 版本不同。继续后会先备份原目录，再以当前版本安装；可在设置的回收站恢复。' : '内容与当前 SkillHub 版本相同。安装时会无损备份原目录并接入 SkillHub；可在设置的回收站恢复。'}</span></div></div>}{actionError && <div className="banner banner-error"><Icon name="warn" size={14} />{actionError}</div>}<div className="modal-actions"><button className="btn btn-ghost" onClick={() => { setInstallPreflight(null); setInstallStep('agents') }}>上一步</button><button className="btn btn-primary" onClick={() => void executeInstall()}>{skill.marketplaceReplacementLocalId || installPreflight?.hasConflicts ? '备份并安装' : '确认安装'}</button></div></>}
      {installStep === 'running' && <div className="progress-state"><div className="spin-icon" /><h3>{skill.localPath ? '正在安装…' : '正在下载、校验并安装…'}</h3></div>}
      {installStep === 'done' && <div className="progress-state"><div className="success-mark"><Icon name="check" size={24} /></div><h3>安装完成</h3><p>已安装到所选工具。</p><button className="btn btn-primary" onClick={() => setInstallOpen(false)}>完成</button></div>}
    </div></FocusTrapDialog>}
    {unmanageOpen && <UnmanageSkillDialog skill={skill} agents={agents} onClose={() => setUnmanageOpen(false)} onDone={(keptInSkillHub) => {
      setUnmanageOpen(false)
      if (keptInSkillHub) {
        toast('已把一份独立文件交给所选工具；SkillHub 中的原件继续同步')
        return
      }
      setSkills(useStore.getState().skills.filter((item) => item.id !== managedSkillId))
      closeSheet()
      toast('已取消 SkillHub 托管，所选 Agent 自行管理这台电脑上的它')
    }} />}
    {confirmation === 'uninstall' && <ConfirmModal eyebrow="管理安装" title={`在所有 Agent 停用「${skill.displayName}」？`} description="只移除各 Agent 中的安装。SkillHub 中的文件、配置和版本仍保留，账号中的条目不变，可以随时重新启用。" confirmLabel="在所有 Agent 停用" busy={lifecycleBusy} destructive onCancel={() => setConfirmation(null)} onConfirm={() => void remove()} />}
    {confirmation === 'sync' && <ConfirmModal eyebrow="重新同步" title="重新连接这个 Skill？" description="SkillHub 会分析并同步 Skill 内容。请先确认其中没有私人信息或密钥。" confirmLabel="开始重新同步" onCancel={() => setConfirmation(null)} onConfirm={() => { setConfirmation(null); void syncToServer() }} />}
    {envReviewElement}
    {confirmation === 'delete' && <DeleteSkillDialog skill={skill} busy={lifecycleBusy} error={deleteError} onCancel={() => setConfirmation(null)} onConfirm={(scope) => void deleteAsset(scope)} />}
  </>
}

function ProfileTab({ skill, installedAgents, agentsLoading, replaceSkill, onRefresh, onRepairAgent, onSync, onRequestSync, syncBusy, onDelete, showDiscussion, discussionTargetId }: { skill: LocalSkill; installedAgents: AgentInfo[]; agentsLoading: boolean; replaceSkill: (skill: LocalSkill) => void; onRefresh: () => Promise<void>; onRepairAgent: (agent: string) => void; onSync: (announce?: boolean) => Promise<LocalSkill | null>; onRequestSync: () => void; syncBusy: boolean; onDelete: () => void; showDiscussion: boolean; discussionTargetId?: string }) {
  const currentUser = useStore((state) => state.currentUser)
  const managedSkillId = localManagedSkillId(skill)
  const [busyAgent, setBusyAgent] = useState<string | null>(null)
  // A single-Agent disable runs directly from the installed button (no
  // confirm). `busy` covers the state read-back too, so a second click cannot
  // submit against a stale "installed" state; the toast carries the undo.
  const toggleAgent = async (agent: string, enabled: boolean): Promise<void> => {
    if (busyAgent || skill.isSystem) return
    setBusyAgent(agent)
    try {
      await (enabled ? disableSkill(managedSkillId, agent) : enableSkill(managedSkillId, agent))
      await onRefresh()
      const sharedWith = sharedProjectionAgents(agent, installedAgents)
      toast(enabled ? disabledToastMessage(agentDisplayName(agent), sharedWith) : `已安装到 ${agentDisplayName(agent)}`, 'default', enabled ? async () => { await enableSkill(managedSkillId, agent); await onRefresh() } : undefined)
    }
    catch (error: unknown) { toast(messageOf(error), 'error') }
    finally { setBusyAgent(null) }
  }
  const visibleAgents = new Set(visibleAgentKeys(installedAgents, skill.agents))
  const agentEntries = orderedAgentEntries(skill.agents).filter(([agent]) => visibleAgents.has(agent))
  const sharedNote = skill.isSystem ? null : sharedProjectionNote(agentEntries.filter(([, status]) => status === 'on').map(([agent]) => agent), installedAgents)
  const canManage = canManageSkillAsset(skill)
  const capabilities = useSpaceCapabilities()
  const offlineAt = useCatalogOffline()
  const canRelink = capabilities.uploads && Boolean(skill.localPath && skill.accountSyncRequired)
  return <div className="overview-content profile-content">
    {currentUser && skill.accountSyncRequired && <section className="account-link-banner" aria-label="Skill 需要重新连接账号"><Icon name="warn" size={16} /><div><b>这个 Skill 需要重新连接你的账号</b><p>本机仍可使用，重新连接后可继续共享。</p></div>{canRelink && <button className="btn btn-warn btn-sm" disabled={syncBusy} onClick={onRequestSync}>{syncBusy ? '正在同步…' : '重新同步'}</button>}</section>}
    {skill.isSystem && <section className="account-link-banner" aria-label="系统 Skill 说明"><Icon name="info" size={16} /><div><b>这是 SkillHub 的内置管理 Skill</b><p>让 AI 工具帮你管理 SkillHub，随应用自动维护。</p></div></section>}
    <ProfilePanel
      skill={skill}
      replaceSkill={replaceSkill}
      canManage={canManage}
      onSync={onRequestSync}
      onDelete={onDelete}
      actions={<div className="profile-quick-actions">
        <div className="profile-agent-actions" aria-label="Agent 安装状态">
          {agentsLoading ? <span className="profile-action-loading"><span className="spin-icon" />正在检测工具</span>
            : agentEntries.length === 0 ? <span className="profile-action-empty">未检测到 AI 工具</span>
              : agentEntries.map(([agent, status]) => {
                  const info = installedAgents.find((item) => item.key === agent) ?? { key: agent, name: agentDisplayName(agent), dir: '', detected: true }
                  const state = status === 'on' ? 'installed' : status === 'broken' ? 'broken' : 'available'
                  const label = skill.isSystem
                    ? `${info.name} 由 SkillHub 自动维护`
                    : state === 'installed' ? disableAgentLabel(info.name, sharedProjectionAgents(agent, installedAgents))
                      : state === 'broken' ? `${info.name} 安装有问题，点击修复`
                        : `安装到 ${info.name}`
                  return <button
                    type="button"
                    key={agent}
                    className={`profile-agent-button ${state}`}
                    aria-label={label}
                    title={label}
                    disabled={!skill.localPath || busyAgent !== null || skill.isSystem}
                    onClick={() => state === 'broken' ? onRepairAgent(agent) : void toggleAgent(agent, state === 'installed')}
                  >
                    <AgentBrandIcon agent={info} size={28} />
                    <span className="profile-agent-state"><Icon name={skill.isSystem || state === 'installed' ? 'check' : state === 'broken' ? 'warn' : 'plus'} size={8} /></span>
                    {busyAgent === agent && <span className="profile-agent-busy spin-icon" aria-hidden="true" />}
                  </button>
                })}
        </div>
        {sharedNote && <p className="profile-agent-note" role="note">{sharedNote}</p>}
        {skill.localPath && <button type="button" className="profile-folder-button" title="打开文件夹" aria-label="打开 Skill 文件夹" onClick={() => void openSkillDir(managedSkillId).catch((error: unknown) => toast(messageOf(error), 'error'))}><Icon name="folder" size={16} /></button>}
      </div>}
    />
    {!skill.isSystem && <SharingSection skill={skill} replaceSkill={replaceSkill} canManage={canManage} onSync={onSync} />}
    {capabilities.account && !skill.isSystem && showDiscussion && <DiscussTab skill={skill} targetCommentId={discussionTargetId} />}
  </div>
}

function ProfilePanel({ skill, replaceSkill, canManage, onSync, onDelete, actions }: { skill: LocalSkill; replaceSkill: (skill: LocalSkill) => void; canManage: boolean; onSync: () => void; onDelete: () => void; actions?: ReactNode }) {
  const unanalysed = useSpaceCapabilities().profile === 'selfhost' && skill.serverAnalysisStatus === 'unanalysed'
  const capabilities = useSpaceCapabilities()
  const offlineAt = useCatalogOffline()
  const versionDisplay = skillVersionDisplay(skill)
  const currentUser = useStore((state) => state.currentUser)
  const ownedServerId = currentUser ? currentOwnedServerSkillId(skill, currentUser.id) : undefined
  const managedSkillId = localManagedSkillId(skill)
  // Private tags (#323) belong to Skills in 「我的 Skills」, not store or team previews.
  const canTag = useStore((state) => state.skills.some((item) => item.id === skill.id)) && !isMarketplaceCatalogSource(skill) && !isTeamDetailSkill(skill)
  const [editing, setEditing] = useState(false)
  const [displayName, setDisplayName] = useState(skill.displayName)
  const [description, setDescription] = useState(skill.description ?? '')
  const [category, setCategory] = useState(skill.category ?? '其他')
  const [labels, setLabels] = useState(skill.labels.join('、'))
  const [sourceUrl, setSourceUrl] = useState(skill.sourceUrl ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const analysisRunning = useStore((state) => Boolean(currentUser && ownedServerId && state.aiAnalysisJobs[aiAnalysisJobKey(currentUser.id, ownedServerId)]))
  useEffect(() => {
    // Background local analysis may update the Skill while this draft is open.
    if (editing) return
    setDisplayName(skill.displayName)
    setDescription(skill.description ?? '')
    setCategory(skill.category ?? '其他')
    setLabels(skill.labels.join('、'))
    setSourceUrl(skill.sourceUrl ?? '')
  }, [editing, skill.category, skill.description, skill.displayName, skill.labels, skill.sourceUrl])
  const save = async (): Promise<void> => {
    const normalizedName = displayName.trim()
    const normalizedLabels = labels.split(/[、,，]/).map((label) => label.trim()).filter(Boolean).slice(0, 8)
    if (!normalizedName) return
    // Same rules as the Server; an invalid value keeps the dialog and draft open.
    const checkedSource = validateSourceUrl(sourceUrl)
    if (!checkedSource.ok) {
      setError(checkedSource.error)
      return
    }
    setSaving(true)
    setError(null)
    const next = {
      ...skill,
      displayName: normalizedName,
      description: description.trim(),
      category,
      labels: normalizedLabels,
      sourceUrl: checkedSource.value,
    }
    // Only an edited source is written: an untouched field must not clear a
    // source this device has not received yet (omitted = keep, #329).
    const sourceChange = checkedSource.value === (skill.sourceUrl ?? null) ? {} : { sourceUrl: checkedSource.value }
    // A clear names the source the user saw, so only that value is kept from coming back.
    const clearedSource = checkedSource.value === null && skill.sourceUrl ? { clearedSourceUrl: skill.sourceUrl } : {}
    try {
      const saveSpace = await currentSpace()
      if (ownedServerId) {
        await apiUpdateSkill(ownedServerId, {
          displayName: next.displayName,
          description: next.description,
          category: next.category,
          labels: next.labels,
          // Explicit null clears; omission keeps the Server value (#329).
          ...sourceChange,
        })
      }
      if (skill.localPath) {
        const updated = await updateSkillProfile(managedSkillId, {
          serverId: skill.serverId,
          serverOwnerId: skill.serverOwnerId,
          displayName: next.displayName,
          description: next.description,
          ...sourceChange,
          ...clearedSource,
          category: next.category,
          labels: next.labels,
          triggerScenarios: skill.fitScenarios ?? [],
          compatibleAgents: skill.compatibleAgents,
          version: skill.version,
        }, saveSpace)
        replaceSkill({ ...next, ...updated })
      } else {
        replaceSkill(next)
      }
      setEditing(false)
      toast('Skill 概览 已更新')
    } catch (reason: unknown) {
      setError(messageOf(reason))
    } finally {
      setSaving(false)
    }
  }
  const analyze = (): void => {
    if (!ownedServerId) return onSync()
    // The click is the explicit action: no confirmation, no sheet-wide busy
    // state. The job keeps running after this panel unmounts.
    void runSkillAiAnalysis(aiAnalysisEnvironment, { skill, serverId: ownedServerId })
  }
  return <>
    <div className="sh-panel profile-panel"><div className="panel-title-row"><h4>Skill 概览 {unanalysed && <span className="chip">未分析</span>}</h4>{canManage && <div className="env-panel-actions">{capabilities.ai && currentUser && skill.serverId && !skill.accountSyncRequired && <button className="btn btn-ghost btn-sm" disabled={saving || analysisRunning} aria-busy={analysisRunning} onClick={analyze}><Icon name="spark" size={12} />{analysisRunning ? '分析中' : 'AI 分析'}</button>}{capabilities.ai && currentUser && (!skill.serverId || skill.accountSyncRequired) && <button className="btn btn-ghost btn-sm" disabled={saving} onClick={onSync}><Icon name="spark" size={12} />生成标签</button>}<button className="btn btn-ghost btn-sm" disabled={saving} onClick={() => setEditing(true)}><Icon name="gear" size={12} />编辑</button></div>}</div>{capabilities.ai && canManage && currentUser && skill.serverId && !skill.accountSyncRequired && <p className="profile-analysis-note" role="note">{analysisRunning ? '正在后台分析，可以继续浏览或操作其他 Skill；完成后会提示结果。' : '点击「AI 分析」会把脱敏后的 SKILL.md 发送给服务端 AI；只有返回完整有效的资料才会覆盖当前内容，失败时保留现有内容。'}</p>}<dl className="kv profile-kv"><dt>可以帮你</dt><dd>{skill.description || '未分析'}</dd><dt>什么时候会用</dt><dd>{skill.fitScenarios?.length ? skill.fitScenarios.join('、') : skill.trigger || '未分析'}</dd><dt>来源</dt><dd>{skill.sources.join(' + ')}</dd><dt>版本</dt><dd className="mono">{versionDisplay.label}{skill.versionStatus === 'pending' ? ' · 待确认' : ''}{skill.hasWorkingCopy ? ' · 已修改' : ''}{skill.formalLabel && skill.formalLabel !== skill.version ? ` · 上游 ${skill.formalLabel}` : ''}</dd><dt>标签</dt><dd><SkillProfileLabels skill={skill} /></dd>{canTag && <><dt>目录</dt><dd><SkillProfileCatalog skill={skill} /></dd></>}</dl>{actions}</div>
    {editing && <FocusTrapDialog className="modal-layer above-sheet" label="编辑 Skill 概览" onEscape={() => setEditing(false)} escapeDisabled={saving}><div className="modal-card skill-dialog compact"><div className="modal-head"><div><span className="eyebrow">Skill 概览</span><h2>编辑资料</h2></div><button className="ico-btn" onClick={() => !saving && setEditing(false)} disabled={saving} aria-label="关闭 Profile 编辑"><Icon name="x" size={16} /></button></div><div className="form-stack"><label>显示名称<input autoFocus maxLength={80} value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></label><label>简介<textarea rows={3} maxLength={500} value={description} onChange={(event) => setDescription(event.target.value)} /></label><label>分类<select value={category} onChange={(event) => setCategory(event.target.value)}>{PROFILE_CATEGORIES.map((item) => <option key={item}>{item}</option>)}</select></label><label>标签（用逗号或顿号分隔，最多 8 个）<input value={labels} onChange={(event) => setLabels(event.target.value)} /></label><label>来源（可选）<input type="url" inputMode="url" spellCheck={false} maxLength={SOURCE_URL_MAX_LENGTH} placeholder="https://github.com/owner/repo" value={sourceUrl} onChange={(event) => setSourceUrl(event.target.value)} /><span className="profile-source-hint">Skill 的原始网址，仅支持 http/https；清空即删除来源</span></label></div>{error && <div className="banner banner-error"><Icon name="warn" size={14} />{error}</div>}<div className="modal-actions"><button className="btn btn-ghost" onClick={() => setEditing(false)} disabled={saving}>取消</button><button className="btn btn-primary" onClick={() => void save()} disabled={saving || !displayName.trim()}>{saving ? '保存中…' : '保存资料'}</button></div></div></FocusTrapDialog>}
  </>
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function FrontmatterTable({ fields }: { fields: SkillMarkdownInspection['fields'] }) {
  if (fields.length === 0) return null
  return <dl className="skill-frontmatter" aria-label="SKILL.md 元数据">
    {fields.map((field) => <div key={field.key} className="skill-frontmatter-row">
      <dt className="mono">{field.key}</dt>
      <dd>{field.value.kind === 'list'
        ? <span className="skill-frontmatter-list">{field.value.value.map((item) => <i key={item}>{item}</i>)}</span>
        : field.value.kind === 'block'
          ? <pre>{field.value.value}</pre>
          : field.value.value}</dd>
    </div>)}
  </dl>
}

function MarkdownDocument({ html, onLink }: { html: string; onLink: (href: string) => void }) {
  return <div
    className="markdown-body"
    onClick={(event) => {
      const anchor = (event.target as HTMLElement).closest('a')
      if (!anchor) return
      event.preventDefault()
      onLink(anchor.getAttribute('href') ?? '')
    }}
    dangerouslySetInnerHTML={{ __html: html }}
  />
}

function DetailsTab({ skill }: { skill: LocalSkill }) {
  const currentUser = useStore((state) => state.currentUser)
  const managedSkillId = localManagedSkillId(skill)
  const readableServerId = currentUser
    ? currentAccountServerId(skill, currentUser.id)
    : undefined
  const [source, setSource] = useState('')
  const [tree, setTree] = useState<SkillTreeEntry[]>([])
  const [sourceLoading, setSourceLoading] = useState(true)
  const [treeLoading, setTreeLoading] = useState(Boolean(skill.localPath))
  const [sourceError, setSourceError] = useState<string | null>(null)
  const [treeError, setTreeError] = useState<string | null>(null)
  const [inspection, setInspection] = useState<SkillMarkdownInspection | null>(null)
  const [documentView, setDocumentView] = useState<'rendered' | 'source'>('rendered')
  const [selectedPath, setSelectedPath] = useState('SKILL.md')
  const [filePreview, setFilePreview] = useState<SkillFilePreview | null>(null)
  const [fileLoading, setFileLoading] = useState(false)
  const [fileError, setFileError] = useState<string | null>(null)
  // 重试 on any document load error re-reads SKILL.md, the tree and the selected file.
  const [documentReload, setDocumentReload] = useState(0)
  const reloadDocument = (): void => setDocumentReload((value) => value + 1)
  useEffect(() => {
    let active = true
    setSourceLoading(true)
    setSourceError(null)
    const load = async (): Promise<string> => {
      if (isPublicMarketplaceSource(skill) && skill.marketplaceSkillMd !== undefined) {
        return skill.marketplaceSkillMd
      }
      if (skill.localPath) {
        try { return await readSkillMd(managedSkillId) }
        catch (reason: unknown) {
          if (skill.marketplaceSkillMd !== undefined) return skill.marketplaceSkillMd
          if (!readableServerId) throw reason
        }
      }
      if (skill.marketplaceSkillMd !== undefined) return skill.marketplaceSkillMd
      if (!readableServerId) throw new Error('当前资产没有可读取的本机 SKILL.md')
      return (await apiGetSkillSource(readableServerId)).skillMd
    }
    void load()
      .then((content) => { if (active) setSource(content) })
      .catch((reason: unknown) => { if (active) setSourceError(messageOf(reason)) })
      .finally(() => { if (active) setSourceLoading(false) })
    return () => { active = false }
  }, [managedSkillId, readableServerId, skill.localPath, skill.marketplaceSkillMd, documentReload])
  useEffect(() => {
    let active = true
    setTree([])
    setTreeError(null)
    setTreeLoading(Boolean(skill.localPath))
    if (!skill.localPath) return () => { active = false }
    void getSkillTree(managedSkillId)
      .then((entries: SkillTreeEntry[]) => { if (active) setTree(entries) })
      .catch((reason: unknown) => { if (active) setTreeError(messageOf(reason)) })
      .finally(() => { if (active) setTreeLoading(false) })
    return () => { active = false }
  }, [managedSkillId, skill.localPath, documentReload])
  useEffect(() => {
    setSelectedPath('SKILL.md')
  }, [managedSkillId])
  useEffect(() => {
    let active = true
    setInspection(null)
    if (!source) return () => { active = false }
    void inspectSkillMarkdown(source)
      .then((result) => { if (active) setInspection(result) })
      .catch(() => { if (active) setInspection(null) })
    return () => { active = false }
  }, [source])
  useEffect(() => {
    let active = true
    setFilePreview(null)
    setFileError(null)
    if (selectedPath === 'SKILL.md' || !skill.localPath) {
      setFileLoading(false)
      return () => { active = false }
    }
    setFileLoading(true)
    void readSkillFile(managedSkillId, selectedPath)
      .then((preview) => { if (active) setFilePreview(preview) })
      .catch((reason: unknown) => { if (active) setFileError(messageOf(reason)) })
      .finally(() => { if (active) setFileLoading(false) })
    return () => { active = false }
  }, [managedSkillId, selectedPath, skill.localPath, documentReload])
  const skillFiles = useMemo(() => tree.filter((entry) => entry.kind === 'file').map((entry) => entry.path), [tree])
  const skillMdHtml = useMemo(() => inspection ? renderSkillMarkdown(inspection.body) : '', [inspection])
  const previewHtml = useMemo(() => (
    filePreview?.kind === 'text' && isMarkdownPath(filePreview.path) ? renderSkillMarkdown(filePreview.content) : ''
  ), [filePreview])
  const openLink = (href: string): void => {
    const target = classifyMarkdownLink(href, skillFiles, selectedPath)
    if (target.kind === 'external') void openUrl(target.url).catch((reason: unknown) => toast(messageOf(reason), 'error'))
    else if (target.kind === 'skill-file') setSelectedPath(target.path)
  }
  const viewingSkillMd = selectedPath === 'SKILL.md'
  const markdownSelected = viewingSkillMd || isMarkdownPath(selectedPath)
  const viewToggle = markdownSelected && <div className="document-view-toggle" role="group" aria-label="显示方式">
    <button type="button" className={documentView === 'rendered' ? 'active' : ''} aria-pressed={documentView === 'rendered'} onClick={() => setDocumentView('rendered')}>排版</button>
    <button type="button" className={documentView === 'source' ? 'active' : ''} aria-pressed={documentView === 'source'} onClick={() => setDocumentView('source')}>原文</button>
  </div>
  const skillMdContent = sourceLoading
    ? <SkeletonBlock layout="text" label={LOADING_COPY.sheetSource} />
    : sourceError
      ? <LoadError variant="inline" message={loadFailedMessage('SKILL.md ', sourceError)} retrying={sourceLoading} onRetry={reloadDocument} />
      : documentView === 'source' || !inspection
        ? <pre className="skill-document-source">{source}</pre>
        : <div className="skill-document-rendered">
          {inspection.lint.length > 0 && <div className="skill-lint" role="note">
            <b><Icon name="warn" size={12} />规范提示</b>
            <ul>{inspection.lint.map((issue) => <li key={issue.code}>{issue.message}</li>)}</ul>
          </div>}
          <FrontmatterTable fields={inspection.fields} />
          <MarkdownDocument html={skillMdHtml} onLink={openLink} />
        </div>
  const fileContent = fileLoading
    ? <SkeletonBlock layout="text" label={LOADING_COPY.sheetFile} />
    : fileError
      ? <LoadError variant="inline" message={loadFailedMessage('文件', fileError)} retrying={fileLoading} onRetry={reloadDocument} />
      : !filePreview
        ? null
        : filePreview.kind === 'tooLarge'
          ? <div className="compact-empty">文件大小 {formatFileSize(filePreview.size)}，超过 1 MB 预览上限，请打开文件夹查看。</div>
          : filePreview.kind === 'binary'
            ? <div className="compact-empty">二进制文件（{formatFileSize(filePreview.size)}），不能以文本预览，请打开文件夹查看。</div>
            : isMarkdownPath(filePreview.path) && documentView === 'rendered'
              ? <div className="skill-document-rendered"><MarkdownDocument html={previewHtml} onLink={openLink} /></div>
              : <pre className="skill-document-source">{filePreview.content}</pre>
  const copyText = viewingSkillMd ? source : filePreview?.kind === 'text' ? filePreview.content : ''
  return <div className="details-workspace">
    <aside className="skill-tree-panel" aria-label="Skill 文件结构"><div className="details-panel-head"><div><h3>文件结构</h3><p>{skill.localPath ? '点击文件即可预览' : '服务端资产未下载'}</p></div>{skill.localPath && !skill.isSystem && <button className="ico-btn" title="打开文件夹" aria-label="打开 Skill 文件夹" onClick={() => void openSkillDir(managedSkillId).catch((reason: unknown) => toast(messageOf(reason), 'error'))}><Icon name="folder" size={14} /></button>}</div>{treeLoading ? <SkeletonBlock layout="text" count={5} compact label={LOADING_COPY.sheetTree} /> : treeError ? <LoadError variant="inline" message={loadFailedMessage('文件结构', treeError)} retrying={treeLoading} onRetry={reloadDocument} /> : tree.length === 0 ? <EmptyState variant="inline" copy={skill.localPath ? EMPTY_COPY.sheetTreeEmpty : EMPTY_COPY.sheetTreeRemote} /> : <ul className="skill-tree-list">{tree.map((entry) => <li key={entry.path} className={entry.path === selectedPath ? 'active' : ''} style={{ paddingLeft: `${10 + entry.depth * 14}px` }} title={entry.path}>{entry.kind === 'file'
      ? <button type="button" className="skill-tree-file" aria-current={entry.path === selectedPath ? 'true' : undefined} onClick={() => setSelectedPath(entry.path)}><Icon name="doc" size={12} /><span>{entry.name}</span></button>
      : <><Icon name="folder" size={12} /><span>{entry.name}</span></>}</li>)}</ul>}</aside>
    <section className="skill-document-panel" aria-label={`${selectedPath} 内容`}><div className="details-panel-head"><div><h3 className={viewingSkillMd ? '' : 'mono'}>{selectedPath}</h3><p>{viewingSkillMd ? (skill.localPath ? '本机托管文件，只读展示' : '服务端脱敏版本，只读展示') : '附带文件，只读预览'}</p></div><div className="details-head-actions">{viewToggle}{!viewingSkillMd && <button className="btn btn-ghost btn-sm" onClick={() => setSelectedPath('SKILL.md')}><Icon name="doc" size={12} />回到 SKILL.md</button>}{skill.localPath && !skill.isSystem && viewingSkillMd && <button className="btn btn-ghost btn-sm" onClick={() => void openSkillDir(managedSkillId).catch((reason: unknown) => toast(messageOf(reason), 'error'))}><Icon name="folder" size={12} />打开文件夹</button>}{copyText && <button className="btn btn-ghost btn-sm" onClick={() => void navigator.clipboard.writeText(copyText).then(() => toast(`${viewingSkillMd ? 'SKILL.md' : '文件内容'}已复制`)).catch((reason: unknown) => toast(messageOf(reason), 'error'))}><Icon name="doc" size={12} />复制</button>}</div></div>{viewingSkillMd ? skillMdContent : fileContent}</section>
  </div>
}

function VersionsTab({ skill, replaceSkill }: { skill: LocalSkill; replaceSkill: (skill: LocalSkill) => void }) {
  const capabilities = useSpaceCapabilities()
  const offlineAt = useCatalogOffline()
  const versionDisplay = skillVersionDisplay(skill)
  const currentUser = useStore((state) => state.currentUser)
  const managedSkillId = localManagedSkillId(skill)
  const canManage = canManageSkillAsset(skill)
  const publicMarketplaceSource = isPublicMarketplaceSource(skill)
  const remoteServerId = currentUser && !publicMarketplaceSource
    ? currentAccountServerId(skill, currentUser.id)
    : undefined
  const [snapshotOpen, setSnapshotOpen] = useState(false)
  const { reviewEnvDeclarations, envReviewElement } = useEnvDeclarationReview()
  const [version, setVersion] = useState('')
  const [changelog, setChangelog] = useState('保存当前状态')
  const [restoreTarget, setRestoreTarget] = useState<{ hash: string; receiptId?: string } | null>(null)
  const [remoteVersions, setRemoteVersions] = useState<ApiSkillVersion[]>([])
  const [remoteLoading, setRemoteLoading] = useState(Boolean(remoteServerId))
  const [remoteError, setRemoteError] = useState<string | null>(null)
  const [remoteReload, setRemoteReload] = useState(0)
  const [snapshotDiff, setSnapshotDiff] = useState<SkillDiffLine[] | null>(null)
  const [versionState, setVersionState] = useState<SkillVersionState | null>(null)
  const [suggestedVersion, setSuggestedVersion] = useState<string | null>(null)
  const [remoteRepair, setRemoteRepair] = useState<ApiSkillVersion | null>(null)
  const publishRequest = useRef<{ serverId: string; body: Parameters<typeof apiCreateSkillVersion>[1]; accountId: string; space: SpaceHandle } | null>(null)
  const [diffView, setDiffView] = useState<{ title: string; lines: SkillDiffLine[] } | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!remoteServerId) {
      setRemoteVersions([])
      setRemoteLoading(false)
      setRemoteError(null)
      return
    }
    let active = true
    setRemoteLoading(true)
    setRemoteError(null)
    void apiGetSkillVersions(remoteServerId)
      .then((versions) => { if (active) setRemoteVersions(versions) })
      .catch((error: unknown) => {
        if (!active) return
        setRemoteVersions([])
        setRemoteError(messageOf(error))
      })
      .finally(() => { if (active) setRemoteLoading(false) })
    return () => { active = false }
  }, [remoteReload, remoteServerId])

  const versionRows = mergeSkillVersionHistory(skill.versions, remoteVersions, skill.formalVersionId)
  const saveSnapshot = async (): Promise<void> => {
    if (!canManage) return toast('团队共享 Skill 仅作者可以创建版本', 'error')
    if (!skill.localPath || !changelog.trim()) return
    const accountId = currentUser?.id ?? null
    const space = readAuthSpace()
    const sessionMatches = (): boolean => (useStore.getState().currentUser?.id ?? null) === accountId && readAuthSpace() === space
    const assertSession = (): void => { if (!sessionMatches()) throw new Error('账号已切换，请重新打开版本窗口') }
    const refreshLocal = async (): Promise<void> => {
      const local = await getLocalSkill(managedSkillId)
      if (local && sessionMatches()) {
        local.versions = await getSkillVersions(managedSkillId)
        if (sessionMatches()) replaceSkill(reconcileLocalSkillRefresh(skill, local))
      }
    }
    setBusy(true)
    let remoteCreated: ApiSkillVersion | null = null
    try {
      assertSession()
      if (remoteRepair) {
        await recordSkillFormalVersion(managedSkillId, remoteRepair.id)
      } else {
        const serverId = accountId ? currentOwnedServerSkillId(skill, accountId) : undefined
        if (!publishRequest.current) {
          const state = await getSkillVersionState(managedSkillId)
          assertSession()
          setVersionState(state)
          const allocation = skillSnapshotAllocation(version, suggestedVersion)
          const publishingFormal = Boolean(serverId && !state.pendingAllocation)
          if (state.pending && !state.pendingAllocation && !skill.hasWorkingCopy) throw new Error('当前版本选择或绑定正在等待同步，暂不能调整编号')
          const error = publishingFormal
            ? skillVersionInputError(version, state.highWater, remoteVersions.flatMap((item) => [item.version, ...(item.aliases ?? [])]))
            : skillSnapshotInputError(version, state.highWater, allocation, state.pendingLabel)
          if (error) throw new Error(error)
          if (serverId && publishingFormal) {
            if (!accountId || !space) throw new Error('请重新登录后再试')
            const [packageData, skillMd] = await Promise.all([createSkillPackage(managedSkillId), readSkillMd(managedSkillId)])
            assertSession()
            publishRequest.current = { serverId, accountId, space, body: {
              version, changelog: changelog.trim(), skillMd,
              envDependencies: skill.envDeps.map(({ key, description, required, obtain }) => ({ key, description, required, obtain })),
              packageBase64: packageData.base64, packageSha256: packageData.sha256,
            } }
          }
        }
        const request = publishRequest.current
        if (request) {
          if (request.accountId !== accountId || request.space !== space) throw new Error('账号已切换，请重新打开版本窗口')
          // Retry the exact request: public metadata cannot prove the server's full digest.
          remoteCreated = await apiCreateSkillVersion(request.serverId, request.body)
          assertSession()
          await recordSkillFormalVersion(managedSkillId, remoteCreated.id)
        } else {
          const allocation = skillSnapshotAllocation(version, suggestedVersion)
          await createSkillSnapshot(managedSkillId, changelog.trim(), allocation === 'manual' ? version : undefined, allocation)
        }
      }
      assertSession()
      await refreshLocal()
      publishRequest.current = null
      setSnapshotOpen(false)
      setRemoteReload((value) => value + 1)
      requestLibrarySync()
      toast(remoteCreated || remoteRepair ? '正式版本已记录，账号状态等待同步确认' : accountId ? '版本已保存在本机，等待账号同步确认' : '版本已保存在本机')
    } catch (error: unknown) {
      if (!sessionMatches()) return
      if (error instanceof ApiError && error.status !== null && error.status >= 400 && error.status < 500) publishRequest.current = null
      toast(remoteCreated ? `云端版本已创建，本机记录尚未完成：${messageOf(error)}` : `保存未完成：${messageOf(error)}`, 'error')
      setRemoteReload((value) => value + 1)
      try { await refreshLocal() } catch { /* Preserve the original actionable error. */ }
    } finally { setBusy(false) }
  }
  const restore = async (target: { hash: string; receiptId?: string }): Promise<void> => {
    const accountId = currentUser?.id ?? null
    const space = readAuthSpace()
    const sessionMatches = (): boolean => (useStore.getState().currentUser?.id ?? null) === accountId && readAuthSpace() === space
    if (!sessionMatches()) return
    setBusy(true)
    try {
      await restoreSkillVersion(managedSkillId, target.hash, target.receiptId)
      if (!sessionMatches()) return
      const local = await getLocalSkill(managedSkillId)
      if (!sessionMatches()) return
      if (local) replaceSkill(reconcileLocalSkillRefresh(skill, local))
      setRestoreTarget(null)
      requestLibrarySync()
      toast('已恢复所选内容，版本编号上界保持不变')
    }
    catch (error: unknown) { if (sessionMatches()) toast(messageOf(error), 'error') }
    finally { setBusy(false) }
  }
  const openSnapshot = async (): Promise<void> => {
    if (!skill.hasWorkingCopy && skill.versionStatus !== 'unversioned' && skill.versionStatus !== 'pending') return
    // A version published to the server first confirms its keys (#251); the
    // written frontmatter then shows up in the diff below.
    if (currentUser && currentOwnedServerSkillId(skill, currentUser.id)) {
      const reviewed = await reviewEnvDeclarations(managedSkillId, skill.envDeps)
      if (!reviewed.ok) return
      if (reviewed.skill) replaceSkill(reconcileLocalSkillRefresh(skill, reviewed.skill))
    }
    setRemoteRepair(null)
    publishRequest.current = null
    setVersionState(null)
    setSuggestedVersion(null)
    setVersion('')
    setChangelog('保存检测到的本地修改')
    setSnapshotDiff(null)
    setSnapshotOpen(true)
    setDiffLoading(true)
    try {
      const [state, diff] = await Promise.all([getSkillVersionState(managedSkillId), getSkillWorkingDiff(managedSkillId)])
      setVersionState(state)
      const suggestion = skillSnapshotSuggestedVersion(state)
      setSuggestedVersion(suggestion)
      setVersion(suggestion)
      setSnapshotDiff(diff)
    } catch (error: unknown) { toast(`读取版本状态失败：${messageOf(error)}`, 'error') }
    finally { setDiffLoading(false) }
  }
  const openRemoteRepair = (remote: ApiSkillVersion): void => {
    setRemoteRepair(remote)
    publishRequest.current = null
    setVersion(remote.version)
    setChangelog(remote.changelog?.trim() || '补全本机版本记录')
    setSnapshotDiff(null)
    setSnapshotOpen(true)
    setDiffLoading(true)
    void getSkillWorkingDiff(managedSkillId)
      .then(setSnapshotDiff)
      .catch((error: unknown) => toast(`读取内容区别失败：${messageOf(error)}`, 'error'))
      .finally(() => setDiffLoading(false))
  }
  const openHistoryDiff = async (fromHash: string, toHash: string, title: string): Promise<void> => {
    setDiffLoading(true)
    try { setDiffView({ title, lines: await getSkillDiff(managedSkillId, fromHash, toHash) }) }
    catch (error: unknown) { toast(`读取差异失败：${messageOf(error)}`, 'error') }
    finally { setDiffLoading(false) }
  }
  const repairingRemoteVersion = remoteRepair !== null
  const versionError = repairingRemoteVersion || publishRequest.current ? null
    : versionState ? versionState.pending && !versionState.pendingAllocation && !skill.hasWorkingCopy
      ? '当前版本选择或绑定正在等待同步，暂不能调整编号'
      : currentUser && currentOwnedServerSkillId(skill, currentUser.id) && !versionState.pendingAllocation
        ? skillVersionInputError(version, versionState.highWater)
        : skillSnapshotInputError(version, versionState.highWater, skillSnapshotAllocation(version, suggestedVersion), versionState.pendingLabel)
      : '正在读取完整版本记录'
  return <><div><div className="panel-title-row"><div><h3>版本历史</h3><p className="panel-subtitle">{canManage ? '当你的 Skill 发生变化时，SkillHub 可以保留旧版本' : '团队共享版本，仅作者可创建新版本'}</p></div></div>
    {(skill.hasWorkingCopy || skill.versionStatus === 'unversioned' || skill.versionStatus === 'pending') && <div className="working-copy-banner"><span className="working-copy-icon"><Icon name="hist" size={16} /></span><div><b>{skill.hasWorkingCopy ? '当前 Skill 内容有改动' : versionDisplay.problem ? '版本记录需要处理' : skill.versionStatus === 'pending' ? '当前版本操作待确认' : '版本记录待保存'}</b><span>{skill.hasWorkingCopy ? `${skill.workingCopyChanges ?? 0} 个文件有变化` : versionDisplay.problem ?? (skill.versionStatus === 'pending' ? '账号同步尚未确认，请查看当前版本状态' : '保存当前内容后可继续管理版本')}</span></div>{canManage && <button className="btn btn-primary btn-sm" onClick={() => void openSnapshot()}>{skill.versionStatus === 'pending' ? '查看待确认状态' : '查看区别并创建版本'}</button>}</div>}
    {remoteLoading && versionRows.length === 0
      ? <SkeletonBlock layout="rows" count={3} compact label={LOADING_COPY.sheetVersions} />
      : <>{remoteError && <LoadError message={loadFailedMessage('服务端版本', remoteError)} retrying={remoteLoading} onRetry={() => setRemoteReload((value) => value + 1)} />}{versionRows.length === 0
        ? <EmptyState copy={canManage ? EMPTY_COPY.sheetVersionsNone : EMPTY_COPY.sheetVersionsNoneReadOnly} icon="hist" compact />
        : <div className="version-list">{versionRows.map((item) => {
          const localIndex = item.localIndex
          const older = localIndex === undefined ? undefined : skill.versions[localIndex + 1]
          const isCurrent = item.isCurrent
          const remote = item.remoteVersion
          return <article key={item.key} className={`version-row${isCurrent ? ' current' : ''}`}>
            <div className="version-main"><div><span className="version-name mono">{item.versionStatus === 'unversioned' || !item.version ? '操作记录' : item.version}</span>{item.versionStatus === 'pending' && <span className="chip">待确认</span>}{item.formalLabel && item.formalLabel !== item.version && <span className="chip">上游 {item.formalLabel}</span>}{isCurrent && <span className="chip chip-ok">当前</span>}<span className="version-date">{item.date}</span></div>{item.changelog && <p>{item.changelog}</p>}</div>
            {item.gitHash && <button className="version-hash mono" title="复制 Commit Hash" aria-label={`复制 Commit Hash ${item.gitHash}`} onClick={() => void navigator.clipboard.writeText(item.gitHash as string).then(() => toast('Commit Hash 已复制')).catch((reason: unknown) => toast(`Commit Hash 复制失败：${messageOf(reason)}`, 'error'))}>{item.gitHash.slice(0, 8)}</button>}
            {canManage && skill.localPath && remote && localIndex === undefined && <button className="btn btn-warn btn-sm" disabled={busy || diffLoading} title="云端已有这个版本，但本机缺少对应记录。补全记录不会修改 Skill 文件。" onClick={() => openRemoteRepair(remote)}>补全本机记录</button>}
            {localIndex !== undefined && item.gitHash && older?.gitHash && <button className="btn btn-ghost btn-sm" disabled={diffLoading} onClick={() => void openHistoryDiff(older.gitHash as string, item.gitHash as string, `${older.version} → ${item.version}`)}>查看区别</button>}
            {localIndex !== undefined && !isCurrent && item.gitHash && <button className="btn btn-ghost btn-sm" onClick={() => setRestoreTarget({ hash: item.gitHash as string, receiptId: item.receiptId })}>恢复</button>}
          </article>
        })}</div>}</>}</div>
    {envReviewElement}
    {snapshotOpen && <FocusTrapDialog className="modal-layer above-sheet" label="创建 Skill 版本" onEscape={() => setSnapshotOpen(false)} escapeDisabled={busy}><div className="modal-card skill-dialog diff-modal"><div className="modal-head"><div><span className="eyebrow">版本历史</span><h2>{repairingRemoteVersion ? '补全本机版本记录' : versionState?.pendingAllocation ? '调整待确认编号' : '确认本次修改'}</h2></div><button className="ico-btn" onClick={() => setSnapshotOpen(false)} disabled={busy} aria-label="关闭版本对话框"><Icon name="x" size={16} /></button></div>{repairingRemoteVersion && <p className="modal-copy">云端已有这个版本。本操作只补齐本机的版本记录，不会覆盖 Skill 文件。</p>}{versionError && <p className="banner banner-error" role="alert">{versionError}</p>}{publishRequest.current && <p className="modal-copy">上次请求尚未确认。重试将发送完全相同的内容；关闭后可刷新历史并补全已创建的正式版本记录。</p>}<DiffPreview lines={snapshotDiff ?? []} loading={diffLoading} /><div className="form-stack"><label>版本号<input autoFocus value={version} readOnly={repairingRemoteVersion || publishRequest.current !== null} onChange={(event) => setVersion(event.target.value)} placeholder="例如 0.1.1" /></label><label>变更说明<textarea rows={3} value={changelog} readOnly={repairingRemoteVersion || publishRequest.current !== null} onChange={(event) => setChangelog(event.target.value)} placeholder="说明本次变更" /></label></div><div className="modal-actions"><button className="btn btn-ghost" onClick={() => setSnapshotOpen(false)} disabled={busy}>取消</button><button className="btn btn-primary" onClick={() => void saveSnapshot()} disabled={busy || diffLoading || Boolean(versionError) || (!repairingRemoteVersion && !publishRequest.current && skill.versionStatus !== 'unversioned' && !versionState?.pendingAllocation && !snapshotDiff?.length) || !changelog.trim()}>{busy ? '保存中…' : repairingRemoteVersion ? '确认补全' : publishRequest.current ? '重试原请求' : versionState?.pendingAllocation ? '保存编号并重新同步' : '创建版本'}</button></div></div></FocusTrapDialog>}
    {diffView && <FocusTrapDialog className="modal-layer above-sheet" label="版本差异" onEscape={() => setDiffView(null)}><div className="modal-card skill-dialog diff-modal"><div className="modal-head"><div><span className="eyebrow">版本差异</span><h2>{diffView.title}</h2></div><button className="ico-btn" onClick={() => setDiffView(null)} aria-label="关闭版本差异"><Icon name="x" size={16} /></button></div><DiffPreview lines={diffView.lines} loading={false} /><div className="modal-actions"><button className="btn btn-primary" onClick={() => setDiffView(null)}>完成</button></div></div></FocusTrapDialog>}
    {restoreTarget && <ConfirmModal eyebrow="版本恢复" title="恢复为这个版本？" description="当前文件会恢复为所选版本内容，现有历史和版本编号上界保持不变。" confirmLabel="确认恢复" onCancel={() => setRestoreTarget(null)} onConfirm={() => void restore(restoreTarget)} busy={busy} />}
  </>
}

function DiffPreview({ lines, loading }: { lines: SkillDiffLine[]; loading: boolean }) {
  if (loading) return <SkeletonBlock layout="text" compact label={LOADING_COPY.sheetDiff} />
  if (lines.length === 0) return <EmptyState variant="inline" copy={EMPTY_COPY.sheetDiffNone} />
  const additions = lines.filter((line) => line.kind === 'add').length
  const deletions = lines.filter((line) => line.kind === 'del').length
  return <div className="diff-preview"><div className="diff-summary"><span className="diff-add">+{additions}</span><span className="diff-del">-{deletions}</span><span>{lines.length} 行变更上下文</span></div><pre>{lines.map((line, index) => <span key={`${index}-${line.content.slice(0, 16)}`} className={`diff-${line.kind}`}>{line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '}{line.content}</span>)}</pre></div>
}

function EnvironmentTab({ skill, replaceSkill }: { skill: LocalSkill; replaceSkill: (skill: LocalSkill) => void }) {
  const canManage = canManageSkillAsset(skill)
  const currentUser = useStore((state) => state.currentUser)
  const setView = useStore((state) => state.setView)
  const managedSkillId = localManagedSkillId(skill)
  const policy = useSkillKeyPolicy(skill)
  const role = keyViewerRole({ canManage, signedIn: Boolean(currentUser), teamSkill: skill.acquisitionSource === 'team' || Boolean(skill.teamSharedFrom) })
  const section = keySectionElements(role, skill.accountSyncRequired)
  const [adding, setAdding] = useState(false)
  const [newKey, setNewKey] = useState('')
  const [deletingKey, setDeletingKey] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [detecting, setDetecting] = useState(false)
  const [detectResult, setDetectResult] = useState<string | null>(null)
  const [detectedSuggestions, setDetectedSuggestions] = useState<EnvSuggestion[]>([])
  const [saveError, setSaveError] = useState<string | null>(null)
  const setKeysPageIntent = useStore((state) => state.setKeysPageIntent)
  // 「共享给团队」 (#294): the share dialog for this Skill's personal key, or the 钥匙 page's 团队 tab.
  const capabilities = useSpaceCapabilities()
  const offlineAt = useCatalogOffline()
  const [sharingKeys, setSharingKeys] = useState(false)
  // 「写回 SKILL.md」 (#284) compares the sidecar's confirmed keys with the file.
  const [fileDeclarations, setFileDeclarations] = useState<EnvDeclaration[] | null>(null)
  const [writingBack, setWritingBack] = useState(false)
  const canReadDeclarations = section.authorTools && Boolean(skill.localPath)
  useEffect(() => {
    if (!canReadDeclarations) return
    let current = true
    setFileDeclarations(null)
    readEnvDeclarations(managedSkillId)
      .then((declarations) => { if (current) setFileDeclarations(declarations) })
      .catch(() => { if (current) setFileDeclarations(null) })
    return () => { current = false }
  }, [canReadDeclarations, managedSkillId])
  const targetDeclarations = envDeclarationsFromDependencies(skill.envDeps)
  const declarationsChanged = fileDeclarations !== null && envDeclarationsChanged(fileDeclarations, targetDeclarations)
  if (!skill.localPath) return <div className="key-empty" id="skill-detail-env">
    <span>安装到本机后即可填写需要的钥匙</span>
    {skill.envDeps.length > 0 && <span>（{skill.envDeps.map((dependency) => dependency.key).join('、')}）</span>}
  </div>
  const persistDependencies = async (keys: string[], suggestions: EnvSuggestion[] = []): Promise<LocalSkill> => {
    const existing = new Map(skill.envDeps.map((dependency) => [dependency.key, dependency]))
    const suggested = new Map(suggestions.map((suggestion) => [suggestion.key, suggestion]))
    const envDeps = keys.map((key): LocalSkill['envDeps'][number] => {
      const current = existing.get(key)
      if (current) return current
      const suggestion = suggested.get(key)
      return suggestion ? {
        key,
        description: '由 SkillHub 静态分析检测',
        required: suggestion.confidence === 'declared' || suggestion.confidence === 'high',
        configured: false,
        sharePolicy: 'none',
        sharedTeams: [],
        origin: 'detected',
        confidence: suggestion.confidence,
      } : {
        key,
        description: '由用户手动添加',
        required: true,
        configured: false,
        sharePolicy: 'none',
        sharedTeams: [],
        origin: 'manual',
      }
    })
    let updated = { ...skill, envDeps }
    const ownedServerId = currentUser ? currentOwnedServerSkillId(skill, currentUser.id) : undefined
    if (canManage && ownedServerId) {
      await apiUpdateSkill(ownedServerId, {
        envDependencies: envDeps.map(({ key, description, required }) => ({ key, description, required })),
      })
    }
    if (skill.localPath) updated = await syncEnvDependencies(managedSkillId, keys, suggestions)
    replaceSkill({ ...updated, envDeps: updated.envDeps.length > 0 ? updated.envDeps : envDeps })
    return updated
  }
  const detect = async (): Promise<void> => {
    if (!skill.localPath || detecting) return
    setDetecting(true)
    setDetectResult(null)
    setDetectedSuggestions([])
    try {
      const suggestions = await detectEnvVarSuggestions(managedSkillId)
      setDetectedSuggestions(suggestions)
      // low 只是文档里的线索，不加入依赖清单（#250）。
      const detected = suggestions.filter((suggestion) => suggestion.confidence !== 'low').map((suggestion) => suggestion.key)
      const known = new Set(skill.envDeps.map((dependency) => dependency.key))
      const added = detected.filter((key) => !known.has(key))
      await persistDependencies([...known, ...added], suggestions)
      setDetectResult(added.length > 0 ? `新增 ${added.join('、')}` : '没有发现新的钥匙')
    }
    catch (error: unknown) { setDetectResult(null); toast(messageOf(error), 'error') }
    finally { setDetecting(false) }
  }
  const confirmPending = async (key: string): Promise<void> => {
    const dependency = skill.envDeps.find((item) => item.key === key) ?? { key }
    try {
      let written: EnvDeclaration[] = []
      const updated = await confirmPendingKey(dependency, () => readEnvDeclarations(managedSkillId), (declarations) => {
        written = declarations
        return writeEnvDeclarations(managedSkillId, declarations)
      })
      replaceSkill(updated)
      setFileDeclarations(written)
      toast(`${key} 已确认为这个 Skill 需要的钥匙`)
    } catch (error: unknown) { toast(messageOf(error), 'error') }
  }
  const writeBack = async (): Promise<void> => {
    if (!declarationsChanged || writingBack) return
    setWritingBack(true)
    try {
      const updated = await writeEnvDeclarations(managedSkillId, targetDeclarations)
      replaceSkill(updated)
      setFileDeclarations(targetDeclarations)
      toast(KEY_COPY.writeBackDone)
    } catch (error: unknown) { toast(messageOf(error), 'error') }
    finally { setWritingBack(false) }
  }
  const addDependency = async (): Promise<void> => {
    const normalized = newKey.trim().toUpperCase()
    if (!/^[A-Z][A-Z0-9_]{0,99}$/.test(normalized)) {
      return setSaveError('变量名必须以大写字母开头，只能包含大写字母、数字和下划线')
    }
    if (skill.envDeps.some((dependency) => dependency.key === normalized)) {
      return setSaveError('这把钥匙已经在清单里')
    }
    setSaving(true)
    setSaveError(null)
    try {
      await persistDependencies([...skill.envDeps.map((dependency) => dependency.key), normalized])
      setAdding(false)
      setNewKey('')
      toast(`${normalized} 已加入需要的钥匙`)
    } catch (error: unknown) { setSaveError(messageOf(error)) }
    finally { setSaving(false) }
  }
  const removeDependency = async (): Promise<void> => {
    if (!deletingKey) return
    setSaving(true)
    try {
      await persistDependencies(skill.envDeps.filter((dependency) => dependency.key !== deletingKey).map((dependency) => dependency.key))
      if (skill.localPath) {
        await deleteSkillEnv(managedSkillId, deletingKey, currentUser?.id ?? null)
      }
      toast(`已删除 ${deletingKey} 的声明`)
      setDeletingKey(null)
    } catch (error: unknown) { toast(messageOf(error), 'error') }
    finally { setSaving(false) }
  }
  return <>
    <KeysExplainer />
    <section className="key-section-head" id="skill-detail-env">
      <div><h3>{KEYS_SECTION_TITLE}</h3><p>{KEY_COPY.sectionSubtitle}</p></div>
      {section.shareHint && currentUser && <button type="button" className="btn btn-ghost btn-sm key-section-share" onClick={() => setSharingKeys(true)}><Icon name="key-round" size={13} />{KEY_COPY.shareToTeam}</button>}
    </section>
    {sharingKeys && <ShareKeyLauncher declaredKeys={skill.envDeps.map((dependency) => dependency.key)} onClose={() => setSharingKeys(false)} onFallback={() => { setSharingKeys(false); setKeysPageIntent({ tab: 'team' }); setView('keys') }} />}
    {policy.error && <div className="banner banner-error key-policy-error" role="alert"><Icon name="warn" size={14} />{loadFailedMessage('钥匙状态', policy.error)}<button type="button" className="link-button" onClick={policy.reload}>{RETRY_LABEL}</button></div>}
    {skill.envDeps.length === 0
      ? <div className="key-empty"><span>这个 Skill 不需要钥匙</span></div>
      : <KeyRequirementList skill={skill} role={role} policy={policy} replaceSkill={replaceSkill} onConfirmPending={confirmPending} />}
    {section.authorTools && <details className="key-author-tools">
      <summary><Icon name="wrench" size={14} /><span className="key-author-title">{KEY_COPY.declarationsTitle}<small>{KEY_COPY.declarationsSubtitle}</small></span><Icon name="chev" size={13} className="key-author-chev" /></summary>
      <div className="key-author-body">
        <div className="key-author-actions">
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setAdding(true); setSaveError(null) }}><Icon name="plus" size={13} />手动添加</button>
          <button type="button" className="btn btn-ghost btn-sm" disabled={detecting} onClick={() => void detect()}><Icon name="spark" size={13} />{detecting ? '检测中…' : '重新检测'}</button>
          <button type="button" className="btn btn-ghost btn-sm" disabled={!declarationsChanged || writingBack} title={declarationsChanged ? undefined : 'SKILL.md 已是最新声明'} onClick={() => void writeBack()}><Icon name="doc" size={13} />{writingBack ? '写回中…' : KEY_COPY.writeBack}</button>
        </div>
        {detectResult && <p className="key-author-note" role="status">{detectResult}</p>}
        {detectedSuggestions.length > 0 && <ul className="key-detect-list" aria-label="检测结果">
          {detectedSuggestions.map((suggestion) => <DetectedKeyRow key={suggestion.key} suggestion={suggestion} declared={skill.envDeps.some((dependency) => dependency.key === suggestion.key)} />)}
        </ul>}
        {skill.envDeps.length > 0 && <ul className="key-author-declared" aria-label="已声明的钥匙">
          {skill.envDeps.map((dependency) => <li key={dependency.key}>
            <code>{dependency.key}</code>
            <button type="button" className="btn btn-ghost btn-sm" aria-label={`删除 ${dependency.key} 的声明`} onClick={() => setDeletingKey(dependency.key)}><Icon name="trash" size={13} />删除声明</button>
          </li>)}
        </ul>}
      </div>
    </details>}
    {adding && <FocusTrapDialog className="modal-layer above-sheet" label="手动添加钥匙" onEscape={() => setAdding(false)} escapeDisabled={saving}><div className="modal-card compact"><div className="modal-head"><div><span className="eyebrow">{KEY_COPY.declarationsTitle}</span><h2>手动添加钥匙</h2></div><button className="ico-btn" onClick={() => !saving && setAdding(false)} disabled={saving} aria-label="关闭手动添加钥匙"><Icon name="x" size={16} /></button></div><p className="modal-copy">这里只登记钥匙名称，不会把值写入 Profile 或上传到 Skill 包。</p><label className="secret-input-label"><span>钥匙名称</span><input autoFocus value={newKey} onChange={(event) => setNewKey(event.target.value.toUpperCase())} onKeyDown={(event) => { if (event.key === 'Enter') void addDependency() }} placeholder="例如 OPENAI_API_KEY" /></label>{saveError && <div className="banner banner-error"><Icon name="warn" size={14} />{saveError}</div>}<div className="modal-actions"><button className="btn btn-ghost" onClick={() => setAdding(false)} disabled={saving}>取消</button><button className="btn btn-primary" onClick={() => void addDependency()} disabled={saving || !newKey.trim()}>{saving ? '添加中…' : '添加'}</button></div></div></FocusTrapDialog>}
    {deletingKey && <ConfirmModal eyebrow={KEY_COPY.declarationsTitle} title={`删除 ${deletingKey} 的声明？`} description="声明和这个 Skill 单独保存的值都会移除；你钥匙库里的同名钥匙不受影响。" confirmLabel="删除声明" destructive busy={saving} onCancel={() => setDeletingKey(null)} onConfirm={() => void removeDependency()} />}
  </>
}

function marketplaceStatusLabel(status: MarketplaceSubmissionStatus): string {
  if (status === 'submitted') return '已提交'
  if (status === 'under_review') return '审核中'
  if (status === 'approved') return '已通过'
  if (status === 'rejected') return '已驳回'
  return '已撤回'
}

function MarketplaceShareBlock({ skill, canManage, onSync }: { skill: LocalSkill; canManage: boolean; onSync: (announce?: boolean) => Promise<LocalSkill | null> }) {
  const currentUser = useStore((state) => state.currentUser)
  const promptForAuth = useStore((state) => state.promptForAuth)
  const [marketplace, setMarketplace] = useState<MarketplaceState | null>(null)
  const [remoteVersions, setRemoteVersions] = useState<ApiSkillVersion[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reload, setReload] = useState(0)
  const [submitOpen, setSubmitOpen] = useState(false)
  const [selectedVersionId, setSelectedVersionId] = useState('')
  const [submitterNote, setSubmitterNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [confirmAction, setConfirmAction] = useState<'withdraw' | 'unpublish' | null>(null)
  const [actionServerId, setActionServerId] = useState<string | null>(null)
  const accountId = currentUser?.id
  const ownedServerId = accountId ? currentOwnedServerSkillId(skill, accountId) : undefined

  useEffect(() => {
    let active = true
    setMarketplace(null)
    setRemoteVersions([])
    setError(null)
    setActionError(null)
    if (!canManage || !ownedServerId || !accountId) {
      setLoading(false)
      return () => { active = false }
    }
    setActionServerId(ownedServerId)
    setLoading(true)
    void Promise.all([apiGetMarketplaceState(ownedServerId), apiGetSkillVersions(ownedServerId)])
      .then(([state, versions]) => {
        if (!active) return
        setMarketplace(state)
        setRemoteVersions(versions)
      })
      .catch((reason: unknown) => {
        if (active) setError(messageOf(reason))
      })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [accountId, canManage, ownedServerId, reload])

  const latestSubmission = marketplace?.latestSubmission ?? null
  const publicListing = isPublicMarketplaceSource(skill)
    ? {
        submissionId: '',
        versionId: skill.marketplaceVersionId ?? '',
        version: skill.version,
        downloadCount: skill.installCount,
        publishedAt: skill.marketplacePublishedAt ?? '',
      }
    : null
  const listing = marketplace?.listing ?? publicListing
  const submissionPending = latestSubmission?.status === 'submitted' || latestSubmission?.status === 'under_review'
  const openSubmit = async (): Promise<void> => {
    if (!currentUser) {
      promptForAuth({ reason: '登录后即可把这个 Skill 提交到 Marketplace', intent: { kind: 'share-skill', skillId: skill.id } })
      return
    }
    setBusy(true)
    setActionError(null)
    try {
      const prepared = await ensureCurrentAccountServerSkill({
        skill,
        currentUserId: currentUser.id,
        sync: () => onSync(false),
      })
      const [state, versions] = await Promise.all([
        apiGetMarketplaceState(prepared.serverId),
        apiGetSkillVersions(prepared.serverId),
      ])
      setMarketplace(state)
      setRemoteVersions(versions)
      setActionServerId(prepared.serverId)
      setSelectedVersionId(versions.find((version) => version.id === prepared.skill.formalVersionId)?.id
        ?? versions[0]?.id
        ?? '')
      setSubmitterNote(state.latestSubmission?.submitterNote ?? '')
      setSubmitOpen(true)
    } catch (reason: unknown) {
      setActionError(messageOf(reason))
    } finally {
      setBusy(false)
    }
  }
  const submit = async (): Promise<void> => {
    if (!actionServerId || !selectedVersionId || !submitterNote.trim()) return
    setBusy(true)
    setActionError(null)
    try {
      const state = await apiSubmitMarketplaceSkill(actionServerId, {
        versionId: selectedVersionId,
        note: submitterNote.trim(),
      })
      setMarketplace((current) => ({ listing: current?.listing ?? null, latestSubmission: state }))
      setSubmitOpen(false)
      toast(listing ? '新版已提交审核，当前上架版本保持公开' : '已提交 Marketplace 审核')
    } catch (reason: unknown) {
      setActionError(messageOf(reason))
    } finally {
      setBusy(false)
    }
  }
  const withdraw = async (): Promise<void> => {
    if (!latestSubmission) return
    setBusy(true)
    setActionError(null)
    try {
      const state = await apiWithdrawMarketplaceSubmission(latestSubmission.id)
      setMarketplace((current) => ({ listing: current?.listing ?? null, latestSubmission: state }))
      setConfirmAction(null)
      toast(listing ? '新版审核已撤回，当前上架版本不受影响' : 'Marketplace 提交已撤回')
    } catch (reason: unknown) {
      setActionError(messageOf(reason))
      setConfirmAction(null)
    } finally {
      setBusy(false)
    }
  }
  const unpublish = async (): Promise<void> => {
    if (!ownedServerId) return
    setBusy(true)
    setActionError(null)
    try {
      await apiUnpublishMarketplaceSkill(ownedServerId)
      setMarketplace((current) => ({ listing: null, latestSubmission: current?.latestSubmission ?? null }))
      setConfirmAction(null)
      toast('已从 Marketplace 下架')
    } catch (reason: unknown) {
      setActionError(messageOf(reason))
      setConfirmAction(null)
    } finally {
      setBusy(false)
    }
  }

  if (!canManage) {
    if (!listing) return null
    return <div className="marketplace-share-card marketplace-public-card"><span className="marketplace-share-icon"><Icon name="market" size={17} /></span><div className="marketplace-share-copy"><b>Marketplace 公开来源</b><div className="marketplace-public-meta"><span><Icon name="user" size={12} />{skill.authorName ?? 'Marketplace 作者'}</span><span className="mono"><Icon name="hist" size={12} />{listing.version}</span></div></div></div>
  }

  if (!currentUser) return <div className="marketplace-share-card"><span className="marketplace-share-icon"><Icon name="market" size={17} /></span><div className="marketplace-share-copy"><b>共享到 Marketplace</b><span>公开分享需要账号；本机安装、版本和使用仍然无需登录。</span></div><button className="btn btn-ghost btn-sm" onClick={() => void openSubmit()}>登录并分享</button></div>
  if (!ownedServerId) return <div className={`marketplace-share-card${actionError ? ' marketplace-state-error' : ''}`}><span className={`marketplace-share-icon${actionError ? ' danger' : ''}`}><Icon name={actionError ? 'warn' : 'market'} size={17} /></span><div className="marketplace-share-copy"><b>共享到 Marketplace</b><span>{actionError ?? '将自动同步到当前账号，再选择正式版本提交审核。'}</span></div><button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void openSubmit()}>{busy ? '正在准备…' : actionError ? '重试' : '共享'}</button></div>
  if (loading) return <div className="marketplace-share-card marketplace-loading" role="status" aria-live="polite"><Skeleton width={34} height={34} radius={10} /><div className="marketplace-share-copy"><b>共享到 Marketplace</b><span>正在读取上架与审核状态…</span></div></div>
  if (error) return <div className="marketplace-share-card marketplace-state-error" role="alert"><span className="marketplace-share-icon danger"><Icon name="warn" size={16} /></span><div className="marketplace-share-copy"><b>{loadFailedMessage('Marketplace 状态')}</b><span>{error}</span></div><button className="btn btn-ghost btn-sm" onClick={() => setReload((value) => value + 1)}>{RETRY_LABEL}</button></div>

  const canOpenSubmission = remoteVersions.length > 0
  const primaryTitle = listing
    ? '已在 Marketplace 上架'
    : latestSubmission?.status === 'rejected'
      ? 'Marketplace 审核未通过'
      : latestSubmission?.status === 'approved'
        ? '已从 Marketplace 下架'
        : submissionPending
          ? '正在等待 Marketplace 审核'
          : '共享到 Marketplace'
  const primaryDescription = listing
    ? `上架版本 ${listing.version} · ${listing.downloadCount.toLocaleString()} 次下载`
    : latestSubmission?.status === 'rejected'
      ? `版本 ${latestSubmission.version.version} 可以修改后重新提交`
      : latestSubmission?.status === 'approved'
        ? `版本 ${latestSubmission.version.version} 的审核记录已保留，可重新提交版本上架`
        : submissionPending
          ? `提交版本 ${latestSubmission?.version.version ?? ''}，审核完成前不会公开`
          : '选择正式版本提交，审核通过后进入公开 Skill 商店。'
  return <>
    <div className="marketplace-share-card">
      <span className="marketplace-share-icon"><Icon name="market" size={17} /></span>
      <div className="marketplace-share-copy"><div className="marketplace-share-title"><b>{primaryTitle}</b>{listing && <span className="marketplace-status-chip approved">已上架</span>}{latestSubmission && !listing && <span className={`marketplace-status-chip ${latestSubmission.status}`}>{marketplaceStatusLabel(latestSubmission.status)}</span>}</div><span>{primaryDescription}</span>{latestSubmission?.status === 'rejected' && latestSubmission.reviewNote && <p className="marketplace-review-reason"><Icon name="info" size={12} />{latestSubmission.reviewNote}</p>}</div>
      <div className="marketplace-share-actions">{listing && <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setConfirmAction('unpublish')}>下架</button>}{!submissionPending && <button className="btn btn-primary btn-sm" disabled={!canOpenSubmission || busy} title={canOpenSubmission ? undefined : '尚未读取到可提交的服务端版本'} onClick={() => void openSubmit()}>{latestSubmission?.status === 'rejected' || latestSubmission?.status === 'approved' && !listing ? '重新提交' : listing ? '提交新版' : '提交审核'}</button>}{submissionPending && <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setConfirmAction('withdraw')}>撤回审核</button>}</div>
    </div>
    {listing && latestSubmission && latestSubmission.status !== 'approved' && latestSubmission.status !== 'withdrawn' && <div className={`marketplace-submission-note ${latestSubmission.status}`}><span className={`marketplace-status-chip ${latestSubmission.status}`}>{marketplaceStatusLabel(latestSubmission.status)}</span><span>新版 {latestSubmission.version.version}{submissionPending ? ' 正在审核，当前上架版本继续公开。' : ' 未通过审核，当前上架版本继续公开。'}</span>{latestSubmission.status === 'rejected' && latestSubmission.reviewNote && <b>{latestSubmission.reviewNote}</b>}</div>}
    {actionError && <div className="banner banner-error marketplace-action-error" role="alert"><Icon name="warn" size={14} />{actionError}</div>}
    {submitOpen && <FocusTrapDialog className="modal-layer above-sheet" label="提交 Skill 到 Marketplace" onEscape={() => setSubmitOpen(false)} escapeDisabled={busy}><div className="modal-card skill-dialog compact"><div className="modal-head"><div><span className="eyebrow">Marketplace 审核</span><h2>{listing ? '提交新版' : '提交到 Marketplace'}</h2></div><button className="ico-btn" disabled={busy} onClick={() => setSubmitOpen(false)} aria-label="关闭 Marketplace 提交对话框"><Icon name="x" size={16} /></button></div><p className="modal-copy">提交后由管理员审核，审核通过前不会公开。已有上架版本会继续可用。</p><div className="form-stack marketplace-submit-form"><label>正式版本<select autoFocus value={selectedVersionId} onChange={(event) => setSelectedVersionId(event.target.value)}>{remoteVersions.map((version) => <option key={version.id} value={version.id}>{version.version} · {new Date(version.createdAt).toLocaleDateString('zh-CN')}</option>)}</select></label><label>审核说明<textarea rows={4} maxLength={500} value={submitterNote} onChange={(event) => setSubmitterNote(event.target.value)} placeholder="说明这个 Skill 解决什么问题、适用场景与建议验收方式" /></label></div><div className="marketplace-disclosure"><Icon name="shield" size={15} /><div><b>将公开</b><span>Profile、脱敏后的 SKILL.md、所选版本安装包和需要的钥匙名称。</span><strong>不会公开任何钥匙的值或凭据。</strong></div></div>{actionError && <div className="banner banner-error" role="alert"><Icon name="warn" size={14} />{actionError}</div>}<div className="modal-actions"><button className="btn btn-ghost" disabled={busy} onClick={() => setSubmitOpen(false)}>取消</button><button className="btn btn-primary" disabled={busy || !selectedVersionId || !submitterNote.trim()} onClick={() => void submit()}>{busy ? '提交中…' : '提交审核'}</button></div></div></FocusTrapDialog>}
    {confirmAction === 'withdraw' && <ConfirmModal eyebrow="Marketplace 审核" title="撤回这次提交？" description={listing ? '只会撤回正在审核的新版，当前上架版本仍会继续公开。' : '撤回后该版本不会进入 Marketplace，稍后仍可重新提交。'} confirmLabel="确认撤回" busy={busy} onCancel={() => setConfirmAction(null)} onConfirm={() => void withdraw()} />}
    {confirmAction === 'unpublish' && <ConfirmModal eyebrow="Marketplace" title="从 Marketplace 下架？" description="下架后不会再出现在 Skill 商店；已经下载到用户本机的副本和版本历史不受影响。" confirmLabel="确认下架" destructive busy={busy} onCancel={() => setConfirmAction(null)} onConfirm={() => void unpublish()} />}
  </>
}

function SharingSection({ skill, replaceSkill, canManage, onSync }: { skill: LocalSkill; replaceSkill: (skill: LocalSkill) => void; canManage: boolean; onSync: (announce?: boolean) => Promise<LocalSkill | null> }) {
  const { teams, currentUser } = useStore()
  const sourceTeam = teams.find((team) => team.id === skill.teamSharedFrom)
  const capabilities = useSpaceCapabilities()
  const publishMode = catalogPublishMode(capabilities.profile)
  const offlineAt = useCatalogOffline()
  const showTeamChannel = capabilities.teams && (canManage || Boolean(skill.teamSharedFrom))
  if (!capabilities.account) return null
  return <section className="sh-panel overview-section sharing-hub-panel" id="skill-detail-share"><div className="panel-title-row"><div><h3>共享</h3><p className="panel-subtitle">公开到 Marketplace，或只分享给指定团队</p></div></div><div className="share-channel"><div className="share-channel-heading"><Icon name="market" size={14} /><div><b>Marketplace</b><span>管理员审核后的公开 Skill 市场</span></div></div>{publishMode === 'official' && capabilities.marketplace ? <MarketplaceShareBlock skill={skill} canManage={canManage} onSync={onSync} /> : publishMode === 'selfhost' ? <CatalogPublish categories={PROFILE_CATEGORIES} key={`${skill.id}:${currentUser?.id}:${useStore.getState().activeSpace?.spaceId}`} skill={skill} /> : <p>发布需要连接一探官方或自部署服务器。</p>}</div>{showTeamChannel && <div className="share-channel team-share-channel"><div className="share-channel-heading"><Icon name="shared-skills" size={14} /><div><b>团队共享</b><span>仅所选团队成员可查看和安装</span></div></div>{canManage ? currentUser ? <TeamShareTab skill={skill} replaceSkill={replaceSkill} onSync={onSync} /> : <div className="compact-empty">登录后可以选择团队；本机安装、版本和使用不受影响。</div> : <div className="marketplace-share-card team-share-row"><span className="tava2" style={{ background: sourceTeam?.color ?? 'var(--color-brand)' }}>{(sourceTeam?.name ?? '团')[0]}</span><div className="marketplace-share-copy"><b>{sourceTeam?.name ?? '当前团队'}</b><span>共享版本 {skill.version}</span></div><span className="chip chip-ok">已共享</span></div>}</div>}</section>
}

function TeamShareTab({ skill, replaceSkill, onSync }: { skill: LocalSkill; replaceSkill: (skill: LocalSkill) => void; onSync: (announce?: boolean) => Promise<LocalSkill | null> }) {
  const teams = useStore((state) => state.teams)
  const setTeams = useStore((state) => state.setTeams)
  const currentUser = useStore((state) => state.currentUser)
  const shareJob = useStore((state) => state.teamShareJobs[skill.id])
  const setTeamShareJob = useStore((state) => state.setTeamShareJob)
  const clearTeamShareJob = useStore((state) => state.clearTeamShareJob)
  const setView = useStore((state) => state.setView)
  const setKeysPageIntent = useStore((state) => state.setKeysPageIntent)
  // 「共享钥匙给团队」 opens the same dialog as the 钥匙 tab (#294).
  const capabilities = useSpaceCapabilities()
  const offlineAt = useCatalogOffline()
  const [sharingKeys, setSharingKeys] = useState(false)

  // Sharing shares the Skill only. Keys go through 「共享钥匙给团队」 below;
  // the old 「勾选提供配置」 window is gone.
  const toggle = async (teamId: string, shared: boolean): Promise<void> => {
    if (!currentUser || useStore.getState().teamShareJobs[skill.id]) return
    const accountUserId = currentUser.id
    const accountSpace = readAuthSpace()
    if (!accountSpace) {
      toast('登录状态已失效，请重新登录', 'error')
      return
    }
    const sessionStillMatches = (): boolean => (
      useStore.getState().currentUser?.id === accountUserId
      && readAuthSpace() === accountSpace
    )
    const job = {
      id: `${accountUserId}:${++teamShareJobSequence}`,
      teamId,
      action: shared ? 'unshare' as const : 'share' as const,
    }
    setTeamShareJob(skill.id, job)
    try {
      let shareable = skill
      if (shared) {
        const serverId = currentOwnedServerSkillId(skill, accountUserId)
        // A legacy/foreign binding cannot represent a share owned by the
        // current account. Clear the stale local marker without issuing an
        // author-only request that is guaranteed to return Forbidden.
        if (serverId) {
          if (!sessionStillMatches()) return
          await apiUnshareSkill(serverId, teamId)
        }
      } else {
        const prepared = useStore.getState().librarySyncEnabled && skill.libraryAccountId === accountUserId && skill.libraryEntryId
          ? await prepareAccountTeamShare(skill, accountUserId, sessionStillMatches)
          : skill
        shareable = await shareSkillWithServerSync({
          skill: prepared,
          currentUserId: accountUserId,
          teamId,
          sync: () => onSync(false),
          share: async (serverId, targetTeamId) => {
            if (!sessionStillMatches()) throw new Error('账号已切换，请重新打开 Skill')
            await apiShareSkillToTeam(serverId, targetTeamId)
          },
        })
      }
      if (!sessionStillMatches()) return
      const sharedTo = { ...(shareable.sharedTo ?? {}) }
      if (shared) delete sharedTo[teamId]; else sharedTo[teamId] = { version: shareable.version, envShared: false }
      replaceSkill({ ...shareable, sharedTo })
      try {
        const nextTeams = await apiGetTeams()
        if (!sessionStillMatches()) return
        setTeams(nextTeams)
        toast(shared ? '已停止共享' : '已共享 Skill')
      } catch {
        if (sessionStillMatches()) {
          toast(shared ? '已停止共享，团队统计稍后刷新' : '共享完成，团队统计稍后刷新', 'warn')
        }
      }
    } catch (error: unknown) {
      if (messageOf(error) !== '当前 Skill 尚未完成账号同步') toast(messageOf(error), 'error')
    } finally {
      clearTeamShareJob(skill.id, job.id)
    }
  }

  return <>
    {teams.length === 0 ? <EmptyState variant="inline" copy={EMPTY_COPY.sheetShareNoTeams} /> : <div className="share-list">{teams.map((team) => {
      const shared = Boolean((skill.sharedTo ?? {})[team.id])
      const busy = shareJob?.teamId === team.id
      const needsSync = !currentUser || !currentOwnedServerSkillId(skill, currentUser.id)
      return <div key={team.id} className="marketplace-share-card team-share-row"><span className="tava2" style={{ background: team.color }}>{team.name[0]}</span><div className="marketplace-share-copy"><b>{team.name}</b><span>{shared ? `已共享 ${skill.version}` : '尚未共享'}</span></div><button className={`btn btn-sm ${shared ? 'btn-soft' : 'btn-ghost'}`} disabled={Boolean(shareJob)} onClick={() => void toggle(team.id, shared)}>{busy ? shareJob.action === 'unshare' ? '正在停止…' : needsSync ? '正在准备…' : '正在共享…' : shared ? '停止共享' : '共享'}</button></div>
    })}</div>}
    {capabilities.teamKeys && teams.length > 0 && skill.envDeps.length > 0 && <button type="button" className="btn btn-ghost btn-sm team-share-keys" onClick={() => setSharingKeys(true)}><Icon name="key-round" size={13} />{KEY_COPY.shareKeysToTeam}</button>}
    {sharingKeys && <ShareKeyLauncher declaredKeys={skill.envDeps.map((dependency) => dependency.key)} onClose={() => setSharingKeys(false)} onFallback={() => { setSharingKeys(false); setKeysPageIntent({ tab: 'team' }); setView('keys') }} />}
  </>
}

function MarketplaceDiscussTab({ skill }: { skill: LocalSkill }) {
  const { currentUser, promptForAuth, teams, activeTeamId } = useStore()
  const [visibility, setVisibility] = useState<MarketplaceCommentVisibility>('public')
  const [teamId, setTeamId] = useState(activeTeamId ?? teams[0]?.id ?? '')
  const [comments, setComments] = useState<ApiMarketplaceComment[]>([])
  const [content, setContent] = useState('')
  const [replyingId, setReplyingId] = useState<string | null>(null)
  const [replyContent, setReplyContent] = useState('')
  const [deleting, setDeleting] = useState<ApiMarketplaceComment | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const serverId = skill.serverId

  useEffect(() => {
    if (teamId && teams.some((team) => team.id === teamId)) return
    setTeamId(activeTeamId ?? teams[0]?.id ?? '')
  }, [activeTeamId, teamId, teams])

  const refresh = async (): Promise<void> => {
    if (!serverId || (visibility === 'team' && !teamId)) return
    const response = await apiGetMarketplaceComments(serverId, visibility, teamId || undefined)
    setComments(response.items)
  }

  useEffect(() => {
    let active = true
    setComments([])
    setError(null)
    if (!serverId || (visibility === 'team' && (!currentUser || !teamId))) {
      setLoading(false)
      return () => { active = false }
    }
    setLoading(true)
    void apiGetMarketplaceComments(serverId, visibility, teamId || undefined)
      .then((response) => { if (active) setComments(response.items) })
      .catch((reason: unknown) => { if (active) setError(messageOf(reason)) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [currentUser, serverId, teamId, visibility])

  const post = async (parentId?: string): Promise<void> => {
    if (!currentUser) {
      promptForAuth({ reason: '登录后即可参与 Skill 商店讨论' })
      return
    }
    const nextContent = (parentId ? replyContent : content).trim()
    if (!serverId || !nextContent || (visibility === 'team' && !teamId)) return
    setBusy(true)
    setError(null)
    try {
      await apiPostMarketplaceComment(serverId, {
        visibility,
        teamId: visibility === 'team' ? teamId : undefined,
        parentId,
        content: nextContent,
      })
      if (parentId) { setReplyingId(null); setReplyContent('') } else setContent('')
      await refresh()
      toast(parentId ? '回复已发表' : '讨论已发表')
    } catch (reason: unknown) {
      setError(messageOf(reason))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (): Promise<void> => {
    if (!deleting) return
    setBusy(true)
    setError(null)
    try {
      await apiDeleteMarketplaceComment(deleting.id)
      setDeleting(null)
      await refresh()
      toast('讨论已删除')
    } catch (reason: unknown) {
      setError(messageOf(reason))
    } finally {
      setBusy(false)
    }
  }

  const renderComment = (comment: ApiMarketplaceComment, isReply = false): ReactNode => {
    const mine = comment.userId === currentUser?.id
    return <article key={comment.id} className={isReply ? 'comment-reply' : ''}><div className="comment-head"><b>{comment.user.displayName}</b><time>{new Date(comment.createdAt).toLocaleString()}</time><div className="comment-actions">{!isReply && currentUser && <button onClick={() => { setReplyingId(comment.id); setReplyContent('') }}>回复</button>}{mine && <button className="danger" onClick={() => setDeleting(comment)}>删除</button>}</div></div><p>{comment.content}</p>{!isReply && comment.replies?.length > 0 && <div className="comment-replies">{comment.replies.map((reply) => renderComment(reply, true))}</div>}{!isReply && replyingId === comment.id && <div className="composer comment-reply-composer"><textarea autoFocus maxLength={2000} rows={2} value={replyContent} onChange={(event) => setReplyContent(event.target.value)} placeholder={`回复 ${comment.user.displayName}…`} /><button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setReplyingId(null)}>取消</button><button className="btn btn-primary btn-sm" disabled={busy || !replyContent.trim()} onClick={() => void post(comment.id)}>回复</button></div>}</article>
  }

  return <><section className="sh-panel overview-section marketplace-discussion" id="skill-detail-discuss"><div className="panel-title-row"><div><h3>讨论</h3><p className="panel-subtitle">选择这条讨论对谁可见</p></div><div className="discussion-scope"><button className={visibility === 'public' ? 'active' : ''} onClick={() => setVisibility('public')}>公开</button><button className={visibility === 'team' ? 'active' : ''} onClick={() => setVisibility('team')}>仅团队</button></div></div>{visibility === 'team' && <div className="discussion-team-row">{teams.length > 0 ? <label><span>团队</span><select value={teamId} onChange={(event) => setTeamId(event.target.value)}>{teams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}</select></label> : <p>加入团队后，可以在这里发起仅团队可见的讨论。</p>}</div>}{loading ? <SkeletonBlock layout="rows" count={2} compact label={LOADING_COPY.sheetDiscussion} /> : comments.length === 0 ? <EmptyState variant="inline" copy={EMPTY_COPY.sheetDiscussionNone} /> : <div className="comment-list compact">{comments.map((comment) => renderComment(comment))}</div>}{error && <div className="banner banner-error"><Icon name="warn" size={14} />{error}</div>}{currentUser ? <div className="composer compact"><textarea value={content} onChange={(event) => setContent(event.target.value)} maxLength={2000} placeholder={visibility === 'public' ? '发表公开讨论…' : '只与所选团队讨论…'} rows={2} /><button className="btn btn-primary btn-sm" disabled={busy || !content.trim() || (visibility === 'team' && !teamId)} onClick={() => void post()}><Icon name="send" size={13} />发表</button></div> : <div className="compact-empty auth-inline-empty">浏览讨论无需登录。<button className="btn btn-ghost btn-sm" onClick={() => promptForAuth({ reason: '登录后即可参与 Skill 商店讨论' })}>登录参与讨论</button></div>}</section>{deleting && <ConfirmModal eyebrow="商店讨论" title="删除这条讨论？" description={deleting.replies?.length ? '这条讨论及其回复都会被删除。' : '这条讨论会被删除。'} confirmLabel="确认删除" destructive busy={busy} onCancel={() => setDeleting(null)} onConfirm={() => void remove()} />}</>
}

function DiscussTab({ skill, targetCommentId }: { skill: LocalSkill; targetCommentId?: string }) {
  if (isPublicMarketplaceSource(skill)) return <MarketplaceDiscussTab skill={skill} />
  return <LegacyDiscussTab skill={skill} targetCommentId={targetCommentId} />
}

function renderMentionedContent(content: string, mentions: readonly ApiUser[]): ReactNode {
  const names = [...new Set(mentions.map((mention) => mention.displayName).filter(Boolean))]
    .sort((left, right) => right.length - left.length)
  if (names.length === 0) return content
  const escaped = names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const expression = new RegExp(`(@(?:${escaped.join('|')}))`, 'g')
  return content.split(expression).map((part, index) => (
    part.startsWith('@') && names.includes(part.slice(1))
      ? <span key={`${part}-${index}`} className="comment-mention">{part}</span>
      : part
  ))
}

function LegacyDiscussTab({ skill, targetCommentId }: { skill: LocalSkill; targetCommentId?: string }) {
  const activeTeamId = useStore((state) => state.activeTeamId)
  const currentUser = useStore((state) => state.currentUser)
  const promptForAuth = useStore((state) => state.promptForAuth)
  const serverId = currentUser
    ? currentAccountServerId(skill, currentUser.id)
    : undefined
  const teamId = commentScopeTeamId(skill, activeTeamId)
  const [comments, setComments] = useState<ApiComment[]>([])
  const [content, setContent] = useState('')
  const [mentions, setMentions] = useState<ApiUser[]>([])
  const [replyingId, setReplyingId] = useState<string | null>(null)
  const [replyContent, setReplyContent] = useState('')
  const [replyMentions, setReplyMentions] = useState<ApiUser[]>([])
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editContent, setEditContent] = useState('')
  const [editMentions, setEditMentions] = useState<ApiUser[]>([])
  const [deleting, setDeleting] = useState<ApiComment | null>(null)
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const refresh = async (): Promise<void> => {
    if (!serverId) return
    setComments(await apiGetComments(serverId, teamId))
  }
  useEffect(() => {
    let active = true
    setComments([])
    setError(null)
    setReplyingId(null)
    setEditingId(null)
    setMentions([])
    setReplyMentions([])
    setEditMentions([])
    setLoading(Boolean(serverId))
    if (!serverId) return () => { active = false }
    void apiGetComments(serverId, teamId)
      .then((result) => { if (active) setComments(result) })
      .catch((reason: unknown) => { if (active) setError(messageOf(reason)) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [serverId, teamId])
  useEffect(() => {
    if (!targetCommentId || loading) return
    const frame = window.requestAnimationFrame(() => {
      const target = document.getElementById(`comment-${targetCommentId}`)
      if (!target) return
      target.scrollIntoView({ behavior: 'smooth', block: 'center' })
      target.setAttribute('tabindex', '-1')
      target.focus({ preventScroll: true })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [comments, loading, targetCommentId])
  const post = async (parentId?: string): Promise<void> => {
    const nextContent = parentId ? replyContent.trim() : content.trim()
    if (!serverId || !nextContent) return
    const nextMentions = parentId ? replyMentions : mentions
    setBusy(true)
    setError(null)
    try {
      await apiPostComment(serverId, nextContent, teamId, parentId, activeMentionIds(nextContent, nextMentions))
      if (parentId) {
        setReplyingId(null)
        setReplyContent('')
        setReplyMentions([])
      } else {
        setContent('')
        setMentions([])
      }
      await refresh()
      toast(parentId ? '回复已发表' : '评论已发表')
    }
    catch (reason: unknown) { setError(messageOf(reason)) }
    finally { setBusy(false) }
  }
  const update = async (): Promise<void> => {
    if (!editingId || !editContent.trim()) return
    setBusy(true)
    setError(null)
    try {
      await apiUpdateComment(editingId, editContent.trim(), activeMentionIds(editContent, editMentions))
      setEditingId(null)
      setEditContent('')
      setEditMentions([])
      await refresh()
      toast('评论已更新')
    } catch (reason: unknown) { setError(messageOf(reason)) }
    finally { setBusy(false) }
  }
  const remove = async (): Promise<void> => {
    if (!deleting) return
    setBusy(true)
    setError(null)
    try {
      await apiDeleteComment(deleting.id)
      setDeleting(null)
      await refresh()
      toast('评论已删除')
    } catch (reason: unknown) { setError(messageOf(reason)) }
    finally { setBusy(false) }
  }
  const renderComment = (comment: ApiComment, isReply = false): ReactNode => {
    const mine = comment.userId === currentUser?.id || comment.user.id === currentUser?.id
    const isEditing = editingId === comment.id
    const targeted = targetCommentId === comment.id
    return <article id={`comment-${comment.id}`} key={comment.id} className={`${isReply ? 'comment-reply ' : ''}${targeted ? 'comment-target' : ''}`.trim()}><div className="comment-head"><b>{comment.user.displayName}</b><time>{new Date(comment.createdAt).toLocaleString()}</time><div className="comment-actions">{!isReply && <button onClick={() => { setReplyingId(comment.id); setReplyContent(''); setReplyMentions([]) }}>回复</button>}{mine && <><button onClick={() => { setEditingId(comment.id); setEditContent(comment.content); setEditMentions(comment.mentions ?? []) }}>编辑</button><button className="danger" onClick={() => setDeleting(comment)}>删除</button></>}</div></div>{isEditing ? <div className="comment-edit"><MentionComposer skillId={serverId ?? ''} teamId={teamId} value={editContent} onChange={setEditContent} mentions={editMentions} onMentionsChange={setEditMentions} placeholder="修改评论…" /><div><button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setEditingId(null)}>取消</button><button className="btn btn-primary btn-sm" disabled={busy || !editContent.trim()} onClick={() => void update()}>保存</button></div></div> : <p>{renderMentionedContent(comment.content, comment.mentions ?? [])}</p>}{!isReply && comment.replies?.length > 0 && <div className="comment-replies">{comment.replies.map((reply) => renderComment(reply, true))}</div>}{!isReply && replyingId === comment.id && <div className="composer comment-reply-composer"><MentionComposer skillId={serverId ?? ''} teamId={teamId} value={replyContent} onChange={setReplyContent} mentions={replyMentions} onMentionsChange={setReplyMentions} autoFocus placeholder={`回复 ${comment.user.displayName}…`} /><button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setReplyingId(null)}>取消</button><button className="btn btn-primary btn-sm" disabled={busy || !replyContent.trim()} onClick={() => void post(comment.id)}>回复</button></div>}</article>
  }
  if (!serverId) return <section className="sh-panel overview-section" id="skill-detail-discuss"><div className="panel-title-row"><div><h3>讨论</h3><p className="panel-subtitle">与团队围绕这个 Skill 协作</p></div></div><div className="compact-empty auth-inline-empty">{currentUser ? '同步到 SkillHub 后即可使用真实讨论。' : '讨论属于云端协作功能，本机使用 Skill 无需登录。'}{!currentUser && <button className="btn btn-ghost btn-sm" onClick={() => promptForAuth({ reason: '登录后即可参与 Skill 讨论' })}>登录参与讨论</button>}</div></section>
  return <><section className="sh-panel overview-section" id="skill-detail-discuss"><div className="panel-title-row"><div><h3>讨论</h3><p className="panel-subtitle">{teamId ? '当前团队的独立讨论，输入 @ 可提醒成员' : '仅 Skill 作者可见的个人讨论'}</p></div></div>{loading ? <SkeletonBlock layout="rows" count={2} compact label={LOADING_COPY.sheetDiscussion} /> : comments.length === 0 ? <EmptyState variant="inline" copy={EMPTY_COPY.sheetDiscussionNone} /> : <div className="comment-list compact">{comments.map((comment) => renderComment(comment))}</div>}{error && <div className="banner banner-error"><Icon name="warn" size={14} />{error}</div>}<div className="composer compact"><MentionComposer skillId={serverId} teamId={teamId} value={content} onChange={setContent} mentions={mentions} onMentionsChange={setMentions} placeholder={teamId ? '写点什么… 输入 @ 提醒成员' : '写点什么…'} /><button className="btn btn-primary btn-sm" disabled={busy || !content.trim()} onClick={() => void post()}><Icon name="send" size={13} />发表</button></div></section>{deleting && <ConfirmModal eyebrow="讨论" title="删除这条评论？" description={deleting.replies?.length ? '这条评论及其回复都会被删除，此操作不可撤销。' : '这条评论会被永久删除，此操作不可撤销。'} confirmLabel="确认删除" destructive busy={busy} onCancel={() => setDeleting(null)} onConfirm={() => void remove()} />}</>
}


/**
 * Detail header avatar. The owner of a Skill that may generate an avatar can click it
 * to upload their own image (#214): native picker → square crop → upload. Others see
 * a plain image with no button semantics. Responses that arrive after an account
 * switch or after the sheet closed are dropped (the control is keyed per Skill).
 */
function SkillAvatarControl({ skill }: { skill: LocalSkill }) {
  const capabilities = useSpaceCapabilities()
  const offlineAt = useCatalogOffline()
  const currentUser = useStore((state) => state.currentUser)
  const [source, setSource] = useState<AvatarSource | null>(null)
  const [busy, setBusy] = useState(false)
  const open = useRef(true)
  useEffect(() => { open.current = true; return () => { open.current = false } }, [])
  const icon = <SkillAvatarIcon className="sh-cat-icon" avatarUrl={skill.avatarUrl} status={skill.avatarStatus} size={64} />
  if (!capabilities.avatarUpload || !currentUser || !canChangeSkillAvatar(skill, currentUser.id)) return icon
  const userId = currentUser.id
  const pick = async (): Promise<void> => {
    if (busy || source) return
    try {
      const picked = await pickAvatarSource()
      if (picked && open.current && useStore.getState().currentUser?.id === userId) setSource(picked)
    } catch (error: unknown) { if (open.current) toast(messageOf(error), 'error') }
  }
  const upload = async (image: CustomAvatarImage): Promise<void> => {
    const space = readAuthSpace()
    if (!space || busy) return
    setBusy(true)
    try {
      const outcome = await uploadCustomSkillAvatar(skill, image, userId, space, () => open.current)
      if (outcome.status === 'applied') { setSource(null); toast('头像已更新') }
    } catch (error: unknown) {
      if (open.current && useStore.getState().currentUser?.id === userId) toast(customAvatarErrorMessage(error, 'upload'), 'error')
    } finally { if (open.current) setBusy(false) }
  }
  return <>
    <button type="button" className="sh-avatar-button" aria-label="更换头像" title="更换头像" aria-busy={busy} disabled={busy} onClick={() => void pick()}>
      {icon}
      <span className="sh-avatar-badge" aria-hidden="true"><Icon name="camera" size={11} /></span>
      {busy && <span className="sh-avatar-progress" aria-hidden="true" />}
    </button>
    {source && <AvatarCropDialog source={source} busy={busy} onCancel={() => { if (!busy) setSource(null) }} onConfirm={(image) => void upload(image)} />}
  </>
}

function AvatarStatusRow({ skill }: { skill: LocalSkill }) {
  const currentUser = useStore((state) => state.currentUser)
  const [busy, setBusy] = useState(false)
  const [restoreOpen, setRestoreOpen] = useState(false)
  const open = useRef(true)
  useEffect(() => { open.current = true; return () => { open.current = false } }, [])
  const capabilities = useSpaceCapabilities()
  const offlineAt = useCatalogOffline()
  if (capabilities.avatars && skill.avatarSource === 'custom' && skill.avatarStatus === 'ready' && currentUser && canChangeSkillAvatar(skill, currentUser.id)) {
    const userId = currentUser.id
    const restore = async (): Promise<void> => {
      const space = readAuthSpace()
      if (!space || busy) return
      setBusy(true)
      try {
        const outcome = await restoreGeneratedSkillAvatar(skill, userId, space, () => open.current)
        if (outcome.status === 'applied') {
          setRestoreOpen(false)
          toast('已恢复默认头像')
        }
      } catch (error: unknown) {
        if (open.current && useStore.getState().currentUser?.id === userId) { setRestoreOpen(false); toast(customAvatarErrorMessage(error, 'restore'), 'error') }
      } finally { if (open.current) setBusy(false) }
    }
    return <p className="sh-avatar-status" role="status" data-avatar-status="custom">
      <span>自定义头像</span>
      <button type="button" className="link-button" disabled={busy} onClick={() => setRestoreOpen(true)}>恢复默认头像</button>
      {restoreOpen && <ConfirmModal eyebrow="Skill 头像" title="恢复默认头像？" description="将不再使用你上传的头像。" confirmLabel="恢复默认头像" busy={busy} onCancel={() => { if (!busy) setRestoreOpen(false) }} onConfirm={() => void restore()} />}
    </p>
  }
  return null
}
