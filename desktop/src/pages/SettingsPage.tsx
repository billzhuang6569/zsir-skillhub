import ServiceSettings from '../components/ServiceSettings.js'
import OrganizerSyncStatus from '../components/OrganizerSyncStatus.js'
import MigrationSettings from '../components/MigrationActivity.js'
import CatalogLogin from '../components/CatalogLogin.js'
import InstanceAiSettings from '../components/InstanceAiSettings.js'
import AvatarSettings from '../components/AvatarSettings.js'
import DocHelp from '../components/DocHelp.js'
import InstanceSettingsPage from './InstanceSettingsPage.js'
import { useSpaceCapabilities } from '../lib/use-space-capabilities.js'
import { userMessage } from '../lib/user-message.js'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { getVersion } from '@tauri-apps/api/app'
import { openUrl } from '@tauri-apps/plugin-opener'
import { Icon } from '../components/Icon.js'
import { PageHeading } from '../components/PageHeading.js'
import {
  checkShellIntegration,
  disableLegacyShellIntegration,
  getRuntimeCliStatus,
  getRuntimeCliStorage,
  cleanupRuntimeCli,
  listTrashItems,
  openTrashItem,
  rollbackMarketplaceReplacement,
  restoreTrashItem,
  libraryListEntries, libraryRestoreEntry,
  deleteEnvBackups,
  getKeyVaultSettings,
  listEnvBackups,
  revealEnvBackups,
  setKeyAutoAllow,
} from '../lib/tauri.js'
import { refreshAgentCapabilities } from '../lib/agent-detection.js'
import { UNCONFIRMED_SKILL_ROOT_HINT, agentAcceptsSkillWrites, agentStateLabel, agentStateTitle } from '../lib/agents.js'
import type { AgentInfo, EnvBackupSummary, RuntimeCliStatus, RuntimeCliStorage, TrashItem } from '../lib/tauri.js'
import { apiGetSkillTrash, apiRestoreSkill } from '../lib/api.js'
import type { ApiDeletedSkill } from '../lib/api.js'
import { LIBRARY_ENTRIES_CHANGED_EVENT, type LibraryEntryList, type LibraryEntrySummary } from '../lib/library-sync.js'
import { toast } from '../components/Toast.js'
import ConfirmModal from '../components/ConfirmModal.js'
import AgentBrandIcon from '../components/AgentBrandIcon.js'
import { useStore } from '../store/index.js'
import { THEME_PREFERENCES, THEME_PREFERENCE_LABELS, type ThemePreference } from '../lib/theme.js'
import { SegmentedControl, type SegmentedOption } from '../components/SegmentedControl.js'
import { Switch } from '../components/Switch.js'
import { Tooltip } from '../components/Tooltip.js'
import { SETTINGS_KEY_COPY, envBackupConfirmTitle, envBackupTitle, formatBytes, revealFolderLabel } from '../lib/env-backups.js'
import type { SkillTitlePreference } from '../lib/skill-title.js'
import { useTheme } from '../lib/use-theme.js'
import FeedbackAdminPanel from '../components/FeedbackAdminPanel.js'
import { checkForAppUpdate, supportsAppUpdates } from '../lib/app-updater.js'
import { LEGAL_LINKS, openLegalLink } from '../lib/legal-links.js'
import './SettingsPage.css'

function messageOf(error: unknown): string { return userMessage(error) }

const TITLE_OPTIONS: readonly SegmentedOption<SkillTitlePreference>[] = [
  { value: 'skill-name', label: 'Skill 名', icon: 'code' },
  { value: 'ai-title', label: '友好名', icon: 'type' },
]

const THEME_ICONS = { system: 'monitor', light: 'sun', dark: 'moon' } as const

const THEME_OPTIONS: readonly SegmentedOption<ThemePreference>[] = THEME_PREFERENCES.map((value) => ({ value, label: THEME_PREFERENCE_LABELS[value], icon: THEME_ICONS[value] }))

/** #334: 卡片开关的说明收进开关的悬停提示，不再在面板底部铺一整句。 */
const CARD_TOGGLE_HINT = '关闭后只收起 Skill 卡片上的快捷按钮；已安装到该工具的 Skill 仍显示它，详情页也始终可以安装。'

/** #334: 来源、目录与诊断不再拼进卡片正文，只在「详情」悬停 / 聚焦时分行显示。 */
function agentDetailText(agent: AgentInfo): string {
  const lines = [agentStateLabel(agent), `Skill 目录：${agent.dir}`]
  if (agent.detected) {
    lines.push(agent.skillsStatus === 'unconfirmed' ? UNCONFIRMED_SKILL_ROOT_HINT : agent.skillsStatus === 'ready' ? '目录已存在' : '首次安装 Skill 时创建')
  }
  const issues = agentStateTitle(agent)
  if (issues) lines.push('', issues)
  return lines.join('\n')
}

function AgentDetailTip({ agent }: { agent: AgentInfo }) {
  const hasIssues = (agent.detectionIssues ?? []).length > 0
  return <Tooltip content={agentDetailText(agent)} align="start" className="agent-tool-tip">
    <span className={`agent-tool-info${hasIssues ? ' warn' : ''}`} tabIndex={0} role="img" aria-label={`${agent.name} 检测详情`}>
      <Icon name={hasIssues ? 'circle-alert' : 'info'} size={14} />
    </span>
  </Tooltip>
}

type AgentToolsPanelProps = {
  agents: AgentInfo[]
  status: 'idle' | 'checking' | 'success' | 'error'
  hiddenCardAgents: string[]
  onToggleCard: (agentKey: string, visible: boolean) => void
  onDetect: () => void
  /** 原样保留的 CLI / Shell 集成提示（agent-runtime-notices）。 */
  children?: ReactNode
}

/**
 * #334: 已检测的工具在上方列表，每行只有图标、名称和「显示在 Skill 卡片」开关；
 * 检测未完成（#335）单独以中性警示样式列出，不并入「未检测」；未检测的合并为一行，可展开看路径。
 */
function AgentToolsPanel({ agents, status, hiddenCardAgents, onToggleCard, onDetect, children }: AgentToolsPanelProps) {
  const [showMissing, setShowMissing] = useState(false)
  const checking = status === 'idle' || status === 'checking'
  const detected = agents.filter((agent) => agent.detected)
  // #335: 目录未确认的工具仍列在已检测里，但不算作可用，也不给卡片开关（卡片快捷按钮本就不显示它）。
  const unconfirmed = detected.filter((agent) => !agentAcceptsSkillWrites(agent))
  const incomplete = agents.filter((agent) => !agent.detected && agent.detectionState === 'incomplete')
  const missing = agents.filter((agent) => !agent.detected && agent.detectionState !== 'incomplete')
  const firstRun = agents.length === 0
  const headline = checking
    ? '正在检测本机工具…'
    : status === 'error' && firstRun
      ? '无法完成检测'
      : detected.length > 0
        ? `已检测到 ${detected.length} 个工具${unconfirmed.length > 0 ? `，${unconfirmed.length} 个目录未确认` : ''}`
        : incomplete.length > 0 ? '部分工具检测未完成' : '未检测到可用工具'

  return <div className="settings-group agent-tools-group" aria-busy={checking}>
    <div className="agent-tools-head">
      <span role="status">{headline}</span>
      <button className="btn btn-ghost btn-sm" disabled={checking} onClick={onDetect}><Icon name="refresh" size={13} />重新检测</button>
    </div>
    {status === 'error' && <div className="agent-tools-error"><div className="banner banner-error full">无法检测本机 Agent，当前选项保持不变；可以重试。</div></div>}
    {firstRun && checking && <div className="agent-tool-skeleton" aria-hidden="true"><span /><span /></div>}
    {agents.some((agent) => agent.key === 'workbuddy-ai') && detected.some((agent) => agent.key === 'workbuddy' || agent.key === 'workbuddy-ai') && <p className="agent-tools-empty">WorkBuddy 与 WorkBuddy AI 使用不同的 Skill 目录。旧安装现属 WorkBuddy AI；若日常使用 WorkBuddy，请在 Skill 详情选择「WorkBuddy」安装，确认后可停用 WorkBuddy AI。</p>}
    {detected.length > 0 && <ul className="agent-tool-list" aria-label="已检测到的工具">
      {detected.map((agent) => {
        const visible = !hiddenCardAgents.includes(agent.key)
        if (!agentAcceptsSkillWrites(agent)) return <li key={agent.key} className="agent-tool-row unconfirmed">
          <AgentBrandIcon agent={agent} size={28} />
          <span className="agent-tool-name"><b>{agent.name}</b><AgentDetailTip agent={agent} /></span>
          <span className="agent-tool-state-badge"><Icon name="circle-alert" size={12} />Skill 目录未确认</span>
        </li>
        return <li key={agent.key} className="agent-tool-row">
          <AgentBrandIcon agent={agent} size={28} />
          <span className="agent-tool-name"><b>{agent.name}</b><AgentDetailTip agent={agent} /></span>
          <span className="agent-tool-toggle">
            {/* Clicking the visible label toggles too; the switch keeps its own aria-label. */}
            <span className="agent-tool-toggle-label" aria-hidden="true" onClick={() => onToggleCard(agent.key, !visible)}>显示在 Skill 卡片</span>
            <Tooltip content={CARD_TOGGLE_HINT} align="end" className="agent-tool-tip">
              <Switch checked={visible} onChange={(next) => onToggleCard(agent.key, next)} aria-label={`在 Skill 卡片上显示 ${agent.name}`} />
            </Tooltip>
          </span>
        </li>
      })}
    </ul>}
    {incomplete.length > 0 && <ul className="agent-tool-list agent-tool-list-incomplete" aria-label="检测未完成的工具">
      {incomplete.map((agent) => <li key={agent.key} className="agent-tool-row incomplete">
        <AgentBrandIcon agent={agent} size={28} />
        <span className="agent-tool-name"><b>{agent.name}</b><AgentDetailTip agent={agent} /></span>
        <span className="agent-tool-state-badge"><Icon name="circle-alert" size={12} />{agentStateLabel(agent)}</span>
      </li>)}
    </ul>}
    {!checking && status === 'success' && detected.length === 0 && incomplete.length === 0 && <p className="agent-tools-empty">安装支持的 Agent 后，点「重新检测」。</p>}
    {missing.length > 0 && <div className="agent-tools-missing">
      <button type="button" className="agent-tools-missing-toggle" aria-expanded={showMissing} aria-controls={showMissing ? 'agent-tools-missing-list' : undefined} onClick={() => setShowMissing((open) => !open)}>
        <Icon name="chev" size={12} />
        <span>未检测：{missing.map((agent) => agent.name).join('、')}</span>
      </button>
      {showMissing && <ul id="agent-tools-missing-list" className="agent-tools-missing-list">
        {missing.map((agent) => <li key={agent.key}>
          <AgentBrandIcon agent={agent} size={20} />
          <span><b>{agent.name}</b><small className="mono">{agent.dir}</small></span>
        </li>)}
      </ul>}
    </div>}
    {children}
  </div>
}

function trashKindLabel(item: TrashItem): string {
  if (item.reason === 'marketplace_version_replacement' && item.status === 'in_progress') return 'Skill 商店切换中断'
  if (item.reason === 'marketplace_version_replacement') return 'Skill 商店版本备份'
  if (item.kind === 'managed_asset') return '本机 Skill 备份'
  if (item.kind === 'agent_name_conflict') return '同名 Skill 备份'
  if (item.kind === 'agent_adoption') return 'Agent 原始备份'
  return '恢复项目'
}

function trashSourceLabel(item: TrashItem): string {
  if (item.reason === 'marketplace_version_replacement' && item.status === 'in_progress') {
    return '上次版本切换中断，两套内容均已保留；可恢复此版本，无法确认时不会覆盖'
  }
  if (item.reason === 'marketplace_version_replacement') return '可切换到此版本，当前版本也会继续保留'
  if (item.kind === 'managed_asset') return '本机文件、版本和配置备份；云端内容另行管理'
  if (item.sourceCount > 0) return `来自 ${item.sourceCount} 个 Agent 同名项`
  return '来自 Agent 导入备份'
}

function trashStatusLabel(item: TrashItem): string {
  if (item.status === 'restored') return '已恢复'
  if (item.reason === 'marketplace_version_replacement' && item.status === 'in_progress') return '切换中断，内容待确认'
  if (!item.restorable) return '暂不可恢复'
  return '可恢复'
}

function trashActionLabel(item: TrashItem, restoring: boolean): string {
  const marketplaceVersion = item.reason === 'marketplace_version_replacement'
  if (restoring) return marketplaceVersion ? '正在切换' : '正在恢复'
  if (marketplaceVersion && item.status === 'in_progress') return '恢复此版本'
  return marketplaceVersion ? '切换版本' : '恢复'
}

function trashDate(timestamp: number): Date | null {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return null
  const date = new Date(timestamp > 1_000_000_000_000 ? timestamp : timestamp * 1000)
  return Number.isNaN(date.getTime()) ? null : date
}

function formatTrashTime(timestamp: number): string {
  const date = trashDate(timestamp)
  if (!date) return '时间未知'
  const includeYear = date.getFullYear() !== new Date().getFullYear()
  return new Intl.DateTimeFormat('zh-CN', {
    ...(includeYear ? { year: 'numeric' as const } : {}),
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

function trashActionError(error: unknown): string {
  const message = messageOf(error)
  if (message.includes('已有新内容') || message.includes('未覆盖')) {
    return '原位置已有新的同名内容，SkillHub 没有覆盖它。请先打开文件夹检查。'
  }
  if (message.includes('不可恢复') || message.includes('恢复内容不存在')) {
    return '该项目已恢复，或恢复内容已不完整。'
  }
  return message
}

function RuntimeCliPathNotice({ guidance }: { guidance: NonNullable<RuntimeCliStatus['pathGuidance']> }) {
  const command = guidance.command
  return <div className="agent-runtime-notice cli-path-notice">
    <Icon name="info" size={14} />
    <div>
      <b>终端 PATH 提示</b>
      <span>{guidance.message}</span>
      {command && <code className="mono">{command}</code>}
      {command && <button type="button" className="btn btn-ghost btn-sm" onClick={() => void navigator.clipboard.writeText(command).then(() => toast('PATH 命令已复制')).catch((error: unknown) => toast(userMessage(error), 'error'))}>复制 PATH 命令</button>}
    </div>
  </div>
}

export default function SettingsPage() {
  const contentRef = useRef<HTMLDivElement>(null)
  const [activeSection, setActiveSection] = useState('settings-service')
  const serverInfo = useStore(state => state.serverInfo)
  const capabilities = useSpaceCapabilities()
  const space = useStore(state => state.activeSpace)
  const [instanceOpen, setInstanceOpen] = useState(false)
  useEffect(() => { setInstanceOpen(false) }, [space?.spaceId, space?.generation])
  const currentUser = useStore((state) => state.currentUser)
  const skillTitlePreference = useStore((state) => state.skillTitlePreference)
  const setSkillTitlePreference = useStore((state) => state.setSkillTitlePreference)
  const theme = useTheme()
  const appUpdate = useStore((state) => state.appUpdate)
  const agents = useStore((state) => state.agentCapabilities)
  const agentDetectionStatus = useStore((state) => state.agentDetectionStatus)
  const hiddenCardAgents = useStore((state) => state.hiddenCardAgents)
  const setCardAgentVisible = useStore((state) => state.setCardAgentVisible)
  const [shellIntegrated, setShellIntegrated] = useState<boolean | null>(null)
  const [confirmLegacyDisable, setConfirmLegacyDisable] = useState(false)
  const [disablingLegacy, setDisablingLegacy] = useState(false)
  const [runtimeCliStatus, setRuntimeCliStatus] = useState<RuntimeCliStatus | null>(null)
  const [runtimeCliError, setRuntimeCliError] = useState<string | null>(null)
  const [runtimeCliChecking, setRuntimeCliChecking] = useState(true)
  const [cliStorage, setCliStorage] = useState<RuntimeCliStorage | null>(null)
  const [cliStorageError, setCliStorageError] = useState<string | null>(null)
  const [cliCleanupWarnings, setCliCleanupWarnings] = useState<string[]>([])
  const [cliStorageBusy, setCliStorageBusy] = useState(false)
  const cliStorageBusyRef = useRef(false)
  const [trashItems, setTrashItems] = useState<TrashItem[]>([])
  const [accountTrashItems, setAccountTrashItems] = useState<ApiDeletedSkill[]>([])
  const [libraryTrashList, setLibraryTrashList] = useState<LibraryEntryList | null>(null)
  const libraryTrash = libraryTrashList && libraryTrashList.userId === currentUser?.id ? libraryTrashList.entries.filter(entry => entry.deleted) : []
  const [trashLoading, setTrashLoading] = useState(true)
  const [trashRefreshing, setTrashRefreshing] = useState(false)
  const [trashError, setTrashError] = useState<string | null>(null)
  const [restoringTrashId, setRestoringTrashId] = useState<string | null>(null)
  const [appVersion, setAppVersion] = useState('0.9.1')
  const trashGenerationRef = useRef(0)
  // 钥匙 rows (#289): the account-level auto-allow switch and the backup folder.
  const storedAutoAllow = useStore((state) => state.keyVault.autoAllow)
  const [autoAllow, setAutoAllow] = useState(storedAutoAllow)
  const [autoAllowState, setAutoAllowState] = useState<'loading' | 'ready' | 'busy' | 'error'>('loading')
  const [envBackups, setEnvBackups] = useState<EnvBackupSummary | null>(null)
  const [envBackupError, setEnvBackupError] = useState<string | null>(null)
  const [confirmBackupDelete, setConfirmBackupDelete] = useState(false)
  const [deletingBackups, setDeletingBackups] = useState(false)
  const accountUserId = currentUser?.id ?? null

  const loadAutoAllow = useCallback(async (): Promise<void> => {
    setAutoAllowState('loading')
    try {
      const settings = await getKeyVaultSettings(accountUserId)
      if ((useStore.getState().currentUser?.id ?? null) !== accountUserId) return
      setAutoAllow(settings.autoAllow)
      setAutoAllowState('ready')
    } catch {
      if ((useStore.getState().currentUser?.id ?? null) === accountUserId) setAutoAllowState('error')
    }
  }, [accountUserId])
  const toggleAutoAllow = async (enabled: boolean): Promise<void> => {
    setAutoAllowState('busy')
    try {
      await setKeyAutoAllow(enabled, null, accountUserId)
      if ((useStore.getState().currentUser?.id ?? null) !== accountUserId) return
      setAutoAllow(enabled)
      const vault = useStore.getState().keyVault
      if (vault.accountUserId === accountUserId) useStore.getState().setKeyVault({ ...vault, autoAllow: enabled })
      setAutoAllowState('ready')
    } catch (error: unknown) {
      toast(messageOf(error), 'error')
      setAutoAllowState('ready')
    }
  }
  const loadEnvBackups = useCallback(async (): Promise<void> => {
    try {
      setEnvBackups(await listEnvBackups())
      setEnvBackupError(null)
    } catch (error: unknown) {
      setEnvBackups(null)
      setEnvBackupError(messageOf(error))
    }
  }, [])
  const revealBackups = async (): Promise<void> => {
    try { await revealEnvBackups() }
    catch (error: unknown) { toast(`无法打开文件夹：${messageOf(error)}`, 'error') }
  }
  const deleteBackups = async (): Promise<void> => {
    setDeletingBackups(true)
    try {
      const { removed } = await deleteEnvBackups()
      toast(SETTINGS_KEY_COPY.backupDeleted(removed))
      setConfirmBackupDelete(false)
    } catch (error: unknown) {
      toast(messageOf(error), 'error')
    } finally {
      setDeletingBackups(false)
      await loadEnvBackups()
    }
  }
  useEffect(() => { void loadAutoAllow() }, [loadAutoAllow])
  useEffect(() => { void loadEnvBackups() }, [loadEnvBackups])

  const detectAgents = useCallback(async (): Promise<void> => {
    await refreshAgentCapabilities()
  }, [])
  const checkShell = useCallback(async (): Promise<void> => {
    try { setShellIntegrated(await checkShellIntegration()) }
    catch (error: unknown) { toast(messageOf(error), 'error') }
  }, [])
  const refreshCliStorage = useCallback(async (): Promise<void> => {
    setCliStorageError(null)
    try {
      setCliStorage(await getRuntimeCliStorage())
    } catch (error: unknown) {
      setCliStorage(null)
      setCliStorageError(messageOf(error))
    }
  }, [])
  const reloadCliStorage = async (): Promise<void> => {
    if (cliStorageBusyRef.current) return
    cliStorageBusyRef.current = true
    setCliStorageBusy(true)
    try { await refreshCliStorage() }
    finally {
      cliStorageBusyRef.current = false
      setCliStorageBusy(false)
    }
  }
  const cleanCliStorage = async (): Promise<void> => {
    if (cliStorageBusyRef.current || runtimeCliChecking || runtimeCliStatus?.managed !== true) return
    cliStorageBusyRef.current = true
    setCliStorageBusy(true)
    setCliCleanupWarnings([])
    try {
      const result = await cleanupRuntimeCli()
      setCliCleanupWarnings(result.warnings)
      toast(`已清理 ${result.deletedCount} 个旧副本，释放 ${formatBytes(result.freedBytes)}`, result.warnings.length ? 'warn' : 'default')
    } catch (error: unknown) {
      setCliCleanupWarnings([messageOf(error)])
    } finally {
      await refreshCliStorage()
      cliStorageBusyRef.current = false
      setCliStorageBusy(false)
    }
  }
  const checkRuntimeCli = useCallback(async (recheck = false): Promise<void> => {
    if (cliStorageBusyRef.current) return
    setRuntimeCliChecking(true)
    setRuntimeCliError(null)
    try {
      setRuntimeCliStatus(await getRuntimeCliStatus(recheck))
      if (recheck) await refreshCliStorage()
    } catch (error: unknown) {
      setRuntimeCliStatus(null)
      setRuntimeCliError(messageOf(error))
    } finally {
      setRuntimeCliChecking(false)
    }
  }, [refreshCliStorage])
  const refreshTrash = useCallback(async (initial = false): Promise<boolean> => {
    const expectedUserId = currentUser?.id ?? null
    const generation = ++trashGenerationRef.current
    if (initial) setTrashLoading(true)
    else setTrashRefreshing(true)
    setTrashError(null)
    try {
      const [localResult, accountResult, libraryResult] = await Promise.allSettled([
        listTrashItems().then(items => {
          if (generation === trashGenerationRef.current && (useStore.getState().currentUser?.id ?? null) === expectedUserId) {
            setTrashItems(items)
            setTrashLoading(false)
          }
          return items
        }),
        currentUser ? apiGetSkillTrash().then(items => {
          if (generation === trashGenerationRef.current && (useStore.getState().currentUser?.id ?? null) === expectedUserId) setAccountTrashItems(items)
          return items
        }) : Promise.resolve([]),
        currentUser ? libraryListEntries() : Promise.resolve(null),
      ])
      if (
        generation !== trashGenerationRef.current
        || (useStore.getState().currentUser?.id ?? null) !== expectedUserId
      ) return false
      const errors: string[] = []
      if (libraryResult.status === 'fulfilled') setLibraryTrashList(libraryResult.value)
      else errors.push(`无法读取账号同步回收站：${trashActionError(libraryResult.reason)}`)
      if (localResult.status === 'fulfilled') setTrashItems(localResult.value)
      else {
        setTrashItems([])
        errors.push(`无法读取本机回收站：${trashActionError(localResult.reason)}`)
      }
      if (accountResult.status === 'fulfilled') setAccountTrashItems(accountResult.value)
      else {
        setAccountTrashItems([])
        errors.push(`无法读取账号回收站：${trashActionError(accountResult.reason)}`)
      }
      setTrashError(errors.length > 0 ? errors.join('；') : null)
      return localResult.status === 'fulfilled'
    } catch (error: unknown) {
      if (
        generation === trashGenerationRef.current
        && (useStore.getState().currentUser?.id ?? null) === expectedUserId
      ) {
        setTrashItems([])
        setAccountTrashItems([])
        setTrashError(`无法读取回收站：${trashActionError(error)}`)
      }
      return false
    } finally {
      if (
        generation === trashGenerationRef.current
        && (useStore.getState().currentUser?.id ?? null) === expectedUserId
      ) {
        if (initial) setTrashLoading(false)
        else setTrashRefreshing(false)
      }
    }
  }, [currentUser])
  const openTrash = async (item: TrashItem): Promise<void> => {
    try {
      await openTrashItem(item.id)
    } catch (error: unknown) {
      toast(`无法打开文件夹：${trashActionError(error)}`, 'error')
    }
  }
  const restoreTrash = async (item: TrashItem): Promise<void> => {
    if (!item.restorable || restoringTrashId) return
    setRestoringTrashId(item.id)
    const name = item.displayName || item.skillId
    const marketplaceVersionSwap = item.reason === 'marketplace_version_replacement'
    try {
      if (marketplaceVersionSwap) await rollbackMarketplaceReplacement(item.id)
      else await restoreTrashItem(item.id)
      let accountRestored = true
      let accountRestoreError: string | null = null
      const shouldRestoreAccount = Boolean(
        !marketplaceVersionSwap
        && currentUser
        && item.serverId
        && item.serverOwnerId === currentUser.id
        && accountTrashItems.some((skill) => skill.id === item.serverId),
      )
      if (shouldRestoreAccount && item.serverId) {
        try {
          await apiRestoreSkill(item.serverId)
        } catch (error: unknown) {
          accountRestored = false
          accountRestoreError = `本机已恢复，但账号资产仍在回收站：${trashActionError(error)}`
        }
      }
      const refreshed = await refreshTrash()
      if (accountRestoreError) setTrashError(accountRestoreError)
      const target = marketplaceVersionSwap
        ? '我的 Skills，当前版本已保留在回收站'
        : item.kind === 'managed_asset' ? '我的 Skills' : '原 Agent 目录'
      toast(
        refreshed && accountRestored ? `「${name}」已恢复到${target}` : `「${name}」已恢复本机内容，账号状态请稍后重试`,
        refreshed && accountRestored ? 'default' : 'warn'
      )
    } catch (error: unknown) {
      toast(`无法恢复「${name}」：${trashActionError(error)}`, 'error')
    } finally {
      setRestoringTrashId(null)
    }
  }
  const restoreAccountTrash = async (skill: ApiDeletedSkill): Promise<void> => {
    if (restoringTrashId) return
    const restoreId = `account:${skill.id}`
    setRestoringTrashId(restoreId)
    try {
      await apiRestoreSkill(skill.id)
      await refreshTrash()
      toast(`「${skill.displayName}」已恢复到账号资产`)
    } catch (error: unknown) {
      toast(`无法恢复「${skill.displayName}」：${trashActionError(error)}`, 'error')
    } finally {
      setRestoringTrashId(null)
    }
  }
  const disableLegacy = async (): Promise<void> => {
    setDisablingLegacy(true)
    try {
      const backup = await disableLegacyShellIntegration()
      setShellIntegrated(false)
      setConfirmLegacyDisable(false)
      toast(backup ? `旧版全局加载已停用；原 .zshrc 已备份到 ${backup}` : '旧版全局加载已停用')
    } catch (error: unknown) {
      toast(messageOf(error), 'error')
    } finally {
      setDisablingLegacy(false)
    }
  }
  useEffect(() => {
    void Promise.all([detectAgents(), checkShell(), checkRuntimeCli(), refreshTrash(true)])
    void getVersion().then(setAppVersion).catch(() => undefined)
    return () => { trashGenerationRef.current += 1 }
  }, [checkRuntimeCli, checkShell, detectAgents, refreshTrash])

  useEffect(() => {
    if (!runtimeCliStatus || runtimeCliStatus.managed === false || runtimeCliStatus.commandPath) return
    const timer = window.setInterval(() => { void checkRuntimeCli() }, 1000)
    return () => window.clearInterval(timer)
  }, [runtimeCliStatus, checkRuntimeCli])

  useEffect(() => {
    void refreshCliStorage()
  }, [refreshCliStorage])

  const runtimeCliReady = !runtimeCliChecking && runtimeCliStatus?.ready === true
  const runtimeCliUnmanaged = runtimeCliStatus?.managed === false
  const runtimeCliIssue = runtimeCliError ?? runtimeCliStatus?.error ?? null
  const showFeedback = capabilities.profile === 'official' && currentUser?.marketplaceRole === 'admin'
  const settingsSections = [
    { id: 'settings-service', label: '服务与账号' },
    { id: 'settings-agents', label: 'Agent 工具' },
    { id: 'settings-keys', label: '钥匙' },
    ...(capabilities.profile === 'local' ? [] : [{ id: 'settings-ai', label: 'AI 与头像' }, { id: 'settings-sync', label: '同步与迁移' }]),
    ...(capabilities.profile === 'official' ? [] : [{ id: 'settings-store', label: 'Skill 商店' }]),
    { id: 'settings-preferences', label: '偏好' },
    { id: 'settings-trash', label: '回收站' },
    ...(showFeedback ? [{ id: 'settings-feedback', label: '反馈管理' }] : []),
    { id: 'settings-help', label: '帮助与关于' },
  ]
  useEffect(() => {
    const main = contentRef.current?.closest('.app-main')
    if (!main) return
    const updateActive = (): void => {
      const headings = contentRef.current?.querySelectorAll<HTMLElement>('[data-settings-section]')
      if (!headings?.length) return
      if (main.scrollTop + main.clientHeight >= main.scrollHeight - 4) {
        setActiveSection(headings[headings.length - 1].id)
        return
      }
      const top = main.getBoundingClientRect().top + 100
      let current = headings[0].id
      for (const heading of headings) {
        if (heading.getBoundingClientRect().top > top) break
        current = heading.id
      }
      setActiveSection(current)
    }
    main.addEventListener('scroll', updateActive, { passive: true })
    updateActive()
    return () => main.removeEventListener('scroll', updateActive)
  }, [capabilities.profile, showFeedback])
  const localServerIds = new Set(trashItems.flatMap((item) => (
    item.kind === 'managed_asset'
    && item.restorable
    && item.serverId
    && item.serverOwnerId === currentUser?.id
      ? [item.serverId]
      : []
  )))
  const accountOnlyTrash = accountTrashItems.filter((skill) => !localServerIds.has(skill.id))
  const trashItemCount = trashItems.filter((item) => item.restorable).length + accountOnlyTrash.length + libraryTrash.length

  const restoreLibraryTrash = async (entry: LibraryEntrySummary): Promise<void> => {
    if (restoringTrashId) return
    const expectedUserId = currentUser?.id
    setRestoringTrashId(`library:${entry.entryId}`)
    try {
      const report = await libraryRestoreEntry(entry.entryId)
      if (useStore.getState().currentUser?.id !== expectedUserId) return
      toast(report.problems.length ? '已恢复，文件稍后自动同步' : '已恢复，所有设备会自动下载')
      window.dispatchEvent(new Event(LIBRARY_ENTRIES_CHANGED_EVENT))
      await refreshTrash()
    } catch (error: unknown) { toast(trashActionError(error), 'error') }
    finally { setRestoringTrashId(null) }
  }

  if (instanceOpen && capabilities.profile === 'selfhost' && space && currentUser?.marketplaceRole === 'admin') {
    return <InstanceSettingsPage key={`${space.spaceId}:${space.generation}:${currentUser.id}`} space={space} onBack={() => setInstanceOpen(false)} />
  }
  return <>
    <PageHeading title="设置" subtitle="偏好与账号" />
    <div className="page-body settings-page">
      <nav className="settings-nav" aria-label="设置分组">{settingsSections.map(section => <button key={section.id} type="button" className={activeSection === section.id ? 'active' : ''} aria-current={activeSection === section.id ? 'location' : undefined} onClick={() => document.getElementById(section.id)?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' })}>{section.label}</button>)}</nav>
      <div className="settings-content" ref={contentRef}>
      <div id="settings-service" data-settings-section><ServiceSettings onOpenInstance={() => setInstanceOpen(true)} /></div>
      <p className="settings-label" id="settings-agents" data-settings-section>Agent 工具 <DocHelp topic="agents" variant="section" label="支持的工具" /></p>
      <AgentToolsPanel agents={agents} status={agentDetectionStatus} hiddenCardAgents={hiddenCardAgents} onToggleCard={setCardAgentVisible} onDetect={() => void detectAgents()}>
        {(!runtimeCliChecking || shellIntegrated) && <div className="agent-runtime-notices">
          {runtimeCliUnmanaged ? <div className="agent-runtime-notice"><Icon name="info" size={14} /><div><b>dev 构建不管理 CLI</b><span>Agent 继续使用正式版 CLI，dev 不会安装或更新它。</span></div></div> : !runtimeCliChecking && !runtimeCliReady && <div className={`agent-runtime-notice ${runtimeCliStatus?.commandPath ? 'danger' : ''}`}><Icon name="warn" size={14} /><div><b>{runtimeCliStatus?.commandPath ? 'CLI 安装有问题' : 'CLI 正在初始化'}</b><span>{runtimeCliIssue ?? '无法完成本机 skillhub 命令安装'}</span><small className="mono">命令路径：{runtimeCliStatus?.commandPath ?? '~/.local/bin/skillhub'}</small></div><button className="btn btn-ghost btn-sm" onClick={() => void checkRuntimeCli(true)}><Icon name="refresh" size={12} />重新检查</button></div>}
          {shellIntegrated && <div className="agent-runtime-notice warning"><Icon name="warn" size={14} /><div><b>发现旧版 Shell 全局加载</b><span>停用后，Skill 配置只会在 Skill 实际使用时获取。</span></div><button className="btn btn-danger-soft btn-sm" onClick={() => setConfirmLegacyDisable(true)}><Icon name="trash" size={12} />安全停用</button></div>}
        </div>}
      </AgentToolsPanel>

      <p className="settings-label" id="settings-keys" data-settings-section>钥匙 <DocHelp topic="keys" variant="section" label="钥匙是怎么用的" /></p>
      <div className="settings-group">
        <div className="settings-row settings-switch-row">
          <div className="settings-row-info"><b id="settings-auto-allow-title">{SETTINGS_KEY_COPY.autoAllowTitle}</b><span id="settings-auto-allow-description">{autoAllowState === 'error' && !currentUser ? SETTINGS_KEY_COPY.autoAllowSignedOut : SETTINGS_KEY_COPY.autoAllowDescription}</span></div>
          <Switch checked={autoAllow} busy={autoAllowState === 'busy'} disabled={autoAllowState === 'loading' || autoAllowState === 'error'} onChange={(next) => void toggleAutoAllow(next)} aria-labelledby="settings-auto-allow-title" aria-describedby="settings-auto-allow-description" />
        </div>
        <div className="settings-row settings-backup-row">
          <div className="settings-row-info"><b>{envBackupTitle(envBackups)}</b><span>{envBackupError ? `无法读取钥匙备份文件：${envBackupError}` : SETTINGS_KEY_COPY.backupDescription} <DocHelp topic="backup" variant="inline" label="了解更多" /></span></div>
          {envBackups && envBackups.count > 0
            ? <div className="settings-row-actions">
              <button type="button" className="btn btn-ghost btn-sm" title={envBackups.dir} onClick={() => void revealBackups()}><Icon name="folder" size={13} />{revealFolderLabel()}</button>
              <button type="button" className="btn btn-danger-soft btn-sm" onClick={() => setConfirmBackupDelete(true)}><Icon name="trash" size={13} />{SETTINGS_KEY_COPY.backupDelete}</button>
            </div>
            : !envBackupError && envBackups && <span className="settings-row-muted">{SETTINGS_KEY_COPY.backupEmpty}</span>}
        </div>
      </div>

      {capabilities.profile !== 'local' && <>
        <p className="settings-label" id="settings-ai" data-settings-section>AI 与头像 <DocHelp topic="ai" variant="section" label="AI 与头像说明" /></p>
        <section className="settings-group">
          {capabilities.profile === 'official' ? <div className="settings-row">
            <div className="settings-row-info"><b>AI 分析</b><span>分析 Skill 的用途、摘要和标签，由一探官方提供。</span></div>
            <span className="chip">{serverInfo ? capabilities.ai ? '已提供' : '未启用' : '状态未知'}</span>
          </div> : space && currentUser && <InstanceAiSettings key={`${space.spaceId}:${space.generation}:${currentUser.id}:${currentUser.marketplaceRole}`} space={space} admin={currentUser.marketplaceRole === 'admin'} />}
          {space && currentUser ? <AvatarSettings key={`${space.spaceId}:${space.generation}:${currentUser.id}:${currentUser.marketplaceRole}`} space={space} admin={currentUser.marketplaceRole === 'admin'} selfhost={capabilities.profile === 'selfhost'} />
            : <div className="settings-row"><div className="settings-row-info"><b>头像风格</b><span>登录后可选择头像风格</span></div></div>}
        </section>
        <p className="settings-label" id="settings-sync" data-settings-section>同步与迁移 <DocHelp topic="migrate" variant="section" label="迁移说明" /></p>
        <section className="settings-group">
          <OrganizerSyncStatus />
          <MigrationSettings />
        </section>
      </>}
      {capabilities.profile !== 'official' && <>
        <p className="settings-label" id="settings-store" data-settings-section>Skill 商店 <DocHelp topic="storeLogin" variant="section" label="商店登录说明" /></p>
        <section className="settings-group"><CatalogLogin /></section>
      </>}

      <p className="settings-label" id="settings-preferences" data-settings-section>偏好</p>
      <div className="settings-group">
        <div className="settings-row settings-choice-row">
          <div className="settings-row-info"><b>列表主要显示</b><span>选择 Skill 列表中更醒目的名称。</span></div>
          <SegmentedControl mode="radiogroup" size="sm" aria-label="列表主要显示" options={TITLE_OPTIONS} value={skillTitlePreference} onChange={setSkillTitlePreference} />
        </div>
        <div className="settings-row settings-choice-row">
          <div className="settings-row-info"><b>外观</b><span>跟随系统，或固定浅色 / 深色；切换立即生效并记住选择。</span></div>
          <SegmentedControl mode="radiogroup" size="sm" aria-label="外观" options={THEME_OPTIONS} value={theme.preference} onChange={theme.setPreference} />
        </div>
      </div>

      <p className="settings-label" id="settings-trash" data-settings-section>回收站</p>
      <section className="settings-group trash-group" aria-busy={trashLoading || trashRefreshing} aria-labelledby="trash-heading">
        <div className="trash-head">
          <div><b id="trash-heading">可恢复项目</b><span>本机 Skill、同名备份与当前账号资产都会保留在这里。</span></div>
          <div className="trash-head-actions">
            {!trashLoading && <span className="trash-count">{trashItemCount} 个可恢复</span>}
            <button className="ico-btn" type="button" title="刷新回收站" aria-label="刷新回收站" disabled={trashLoading || trashRefreshing || restoringTrashId !== null} onClick={() => void refreshTrash()}><Icon name="refresh" size={14} /></button>
          </div>
        </div>
        {trashError && <div className="trash-error" role="alert"><span>{trashError}</span><button className="btn btn-ghost" type="button" onClick={() => void refreshTrash()}>重试</button></div>}
        {trashLoading ? <div className="trash-loading" role="status"><span className="spin-icon" aria-hidden="true" /><span>正在读取回收站…</span></div>
          : trashItems.length === 0 && accountOnlyTrash.length === 0 && libraryTrash.length === 0 ? <div className="trash-empty"><span className="trash-empty-icon" aria-hidden="true"><Icon name="trash" size={17} /></span><div><b>回收站为空</b><span>移出的 Skill 与同名冲突备份会保留在这里，不会直接覆盖或清除。</span></div></div>
            : <div className="trash-list">{trashItems.map((item) => {
                const createdAt = trashDate(item.createdAt)
                const name = item.displayName || item.skillId
                return <article className="trash-item" key={item.id}>
                  <span className={`trash-kind-icon ${item.kind === 'managed_asset' ? 'managed' : 'backup'}`} aria-hidden="true"><Icon name={item.kind === 'managed_asset' ? 'skills' : 'hist'} size={16} /></span>
                  <div className="trash-item-copy">
                    <div className="trash-item-name"><b title={name}>{name}</b><span>{trashKindLabel(item)}</span></div>
                    <div className="trash-item-meta"><span>{trashSourceLabel(item)}</span><i aria-hidden="true" /><time dateTime={createdAt?.toISOString()}>{formatTrashTime(item.createdAt)}</time></div>
                  </div>
                  <div className="trash-actions">
                    <button className="btn btn-ghost trash-action" type="button" title={item.location} disabled={restoringTrashId !== null} onClick={() => void openTrash(item)}><Icon name="folder" size={13} />打开文件夹</button>
                    {item.restorable ? <button className="btn btn-soft trash-action" type="button" disabled={restoringTrashId !== null} onClick={() => void restoreTrash(item)}><Icon name="hist" size={13} />{trashActionLabel(item, restoringTrashId === item.id)}</button> : <span className="trash-item-status">{trashStatusLabel(item)}</span>}
                  </div>
                </article>
              })}{accountOnlyTrash.map((skill) => <article className="trash-item" key={`account:${skill.id}`}>
                <span className="trash-kind-icon account" aria-hidden="true"><Icon name="server" size={16} /></span>
                <div className="trash-item-copy">
                  <div className="trash-item-name"><b title={skill.displayName}>{skill.displayName}</b><span>账号资产</span></div>
                  <div className="trash-item-meta"><span>来自当前账号</span><i aria-hidden="true" /><time dateTime={skill.deletedAt}>{formatTrashTime(new Date(skill.deletedAt).getTime())}</time></div>
                </div>
                <div className="trash-actions">
                  <button className="btn btn-soft trash-action" type="button" disabled={restoringTrashId !== null} onClick={() => void restoreAccountTrash(skill)}><Icon name="hist" size={13} />{restoringTrashId === `account:${skill.id}` ? '正在恢复' : '恢复'}</button>
                </div>
              </article>)}{libraryTrash.map(entry => <article className="trash-item" key={`library:${entry.entryId}`}>
                <span className="trash-kind-icon account" aria-hidden="true"><Icon name="cloud" size={16} /></span>
                <div className="trash-item-copy"><div className="trash-item-name"><b>{entry.displayName}</b><span>账号同步库</span></div><div className="trash-item-meta">恢复后自动同步到所有设备</div></div>
                <div className="trash-actions"><button type="button" className="btn btn-soft trash-action" disabled={restoringTrashId !== null} onClick={() => void restoreLibraryTrash(entry)}><Icon name="hist" size={13} />{restoringTrashId === `library:${entry.entryId}` ? '正在恢复' : '恢复'}</button></div>
              </article>)}</div>}
      </section>

      {showFeedback && <><p className="settings-label" id="settings-feedback" data-settings-section>反馈管理</p><FeedbackAdminPanel /></>}

      <p className="settings-label" id="settings-help" data-settings-section>帮助与关于</p>
      <div className="settings-group">
        {runtimeCliStatus?.pathGuidance && <div className="settings-row"><RuntimeCliPathNotice guidance={runtimeCliStatus.pathGuidance} /></div>}
        <div className="settings-row"><div className="agent-runtime-notice cli-storage-notice" aria-busy={cliStorageBusy}>
          <Icon name="info" size={14} />
          <div><b>CLI 组件占用</b>
            {cliStorage ? <span>当前副本 {formatBytes(cliStorage.currentBytes)} · 可清理旧副本 {cliStorage.reclaimableCount} 个（{formatBytes(cliStorage.reclaimableBytes)}）</span> : <span>{cliStorageError ? `无法读取占用：${cliStorageError}` : '正在统计占用…'}</span>}
            {runtimeCliUnmanaged && <span>请在正式版中清理旧副本。</span>}
            {[...new Set([...cliCleanupWarnings, ...(cliStorage?.warnings ?? [])])].map(warning => <small key={warning} role="alert">{warning}</small>)}
          </div>
          {runtimeCliStatus?.managed === true && cliStorage && cliStorage.reclaimableCount > 0 && <button type="button" className="btn btn-ghost btn-sm" disabled={cliStorageBusy || runtimeCliChecking} onClick={() => void cleanCliStorage()}><Icon name="trash" size={12} />{cliStorageBusy ? '正在清理…' : '清理旧副本'}</button>}
          <button type="button" className="btn btn-ghost btn-sm" disabled={cliStorageBusy || runtimeCliChecking} onClick={() => void reloadCliStorage()}>刷新占用</button>
        </div></div>
        <div className="settings-row"><div className="settings-row-info"><b>使用文档</b><span>安装 Skill、钥匙、团队、自部署与常见问题。</span></div><DocHelp topic="docs" label="打开文档中心" /></div>
        <div className="settings-row"><div className="settings-row-info"><b>首次引导</b><span>重新了解使用方式和常用功能。</span></div><button className="btn btn-ghost btn-sm" onClick={() => window.dispatchEvent(new Event('skillhub-show-onboarding'))}>重新查看引导</button></div>
        <div className="settings-row"><div className="settings-row-info"><b>应用更新</b><span>{appUpdate.phase === 'checking' ? '正在从安全更新通道检查…' : appUpdate.phase === 'latest' ? '当前已是最新版本' : appUpdate.phase === 'available' ? `v${appUpdate.version} 可以下载` : appUpdate.phase === 'downloading' ? '正在下载并校验签名…' : appUpdate.phase === 'ready' ? '更新已安装，等待重启' : appUpdate.phase === 'error' ? appUpdate.error : '签名整包更新，失败时继续使用当前版本'}</span></div><button type="button" className="btn btn-ghost btn-sm" disabled={!supportsAppUpdates() || appUpdate.phase === 'checking' || appUpdate.phase === 'downloading'} onClick={() => void checkForAppUpdate()}><Icon name="refresh" size={13} />检查更新</button></div>
        <div className="settings-row settings-about-row"><div className="settings-row-info"><b>一探 SkillHub</b><span>v{appVersion} · 内部正式版</span></div><div className="settings-about-links">{LEGAL_LINKS.map((link) => <button key={link.url} type="button" className="btn btn-ghost btn-sm" onClick={() => void openLegalLink(link, openUrl, (message) => toast(message, 'error'), messageOf)}>{link.label}</button>)}</div></div>
      </div>
      </div>
    </div>
    {confirmBackupDelete && envBackups && <ConfirmModal eyebrow="钥匙备份文件" title={envBackupConfirmTitle(envBackups.count)} description={SETTINGS_KEY_COPY.backupConfirmDescription} confirmLabel={SETTINGS_KEY_COPY.backupDelete} destructive busy={deletingBackups} onCancel={() => setConfirmBackupDelete(false)} onConfirm={() => void deleteBackups()} />}
    {confirmLegacyDisable && <ConfirmModal eyebrow="安全迁移" title="停用旧版全局Skill 配置？" description="SkillHub 会先备份 .zshrc，再只移除包含 .skillhub/active.env 的加载行；每个 Skill 的本机值不会删除。" confirmLabel="备份并停用" destructive busy={disablingLegacy} onCancel={() => setConfirmLegacyDisable(false)} onConfirm={() => void disableLegacy()} />}
  </>
}
