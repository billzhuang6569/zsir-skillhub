import { useCatalogOffline } from '../lib/use-catalog-offline.js'
import { CATALOG_INSTALL_OFFLINE } from '../lib/catalog-cache.js'
import { marketplaceAction } from '../lib/marketplace-state.js'
import { isServerUnanalysed } from '../lib/instance-settings.js'
import { spaceProfile } from '../lib/space-capabilities.js'
import { userMessage } from '../lib/user-message.js'
import { useState } from 'react'
import type { LocalSkill } from '../store/index.js'
import { useStore } from '../store/index.js'
import { cardAgentOptions, orderedAgentEntries } from '../lib/agents.js'
import { enableSkill, disableSkill, getLocalSkill } from '../lib/tauri.js'
import { useShallow } from 'zustand/react/shallow'
import { selectSkillCardState } from '../lib/store-selectors.js'
import type { AgentInfo } from '../lib/tauri.js'
import { Icon } from './Icon.js'
import { SkillAvatarIcon } from './SkillAvatarIcon.js'
import { toast } from './Toast.js'
import { canManageSkillAsset, reconcileLocalSkillRefresh, visibleAgentKeys } from '../lib/ui-helpers.js'
import AgentBrandIcon from './AgentBrandIcon.js'
import { disableAgentLabel, disabledToastMessage, sharedProjectionAgents } from '../lib/skill-lifecycle-ui.js'
import { EditorialLabels } from './EditorialLabels.js'
import { StoreBadges } from './store/StoreUI.js'
import { editorialLabelsBesideBadges } from '../lib/store-home.js'
import './store/StoreUI.css'
import './SkillCard.css'
import { skillListText } from '../lib/skill-title.js'
import { skillVersionDisplay } from '../lib/versioning.js'
import { envKeyIssue, type EnvKeySummary } from '../lib/skill-library.js'

function messageOf(error: unknown): string {
  return userMessage(error)
}

/** SkillAvatar with the design-system hairline ring; corners follow size (store `.tsh-avatar`). */
function CategoryIcon({ avatarUrl, status, size = 48 }: { avatarUrl?: string | null; status?: string | null; size?: number }) {
  const radius = size >= 72 ? 'lg' : size > 36 ? 'md' : 'sm'
  return <SkillAvatarIcon className={`skill-cat-icon tsh-avatar tsh-avatar-${radius}`} avatarUrl={avatarUrl} status={status} size={size} />
}

/** Store badges (精选 / 原创 / 热门 / 新上架) with icon and word, in the server's normalised order. */
function MarketplaceBadges({ badges = [] }: { badges?: LocalSkill['marketplaceBadges'] }) {
  return <StoreBadges badges={badges} />
}

type Props = {
  skill: LocalSkill
  dimmed?: boolean
  /** Resolved key readiness (needs_value / needs_choice counts) from the native policy. */
  envKeys?: EnvKeySummary
  envPolicyFailed?: boolean
  context?: 'library' | 'marketplace'
  publisherName?: string
  onOpen?: () => void
  onInstall?: (agentKey?: string) => void
  onShare?: () => void
}

export default function SkillCard({
  skill,
  dimmed,
  envKeys,
  envPolicyFailed = false,
  context = 'library',
  publisherName,
  onOpen,
  onInstall,
  onShare,
}: Props) {
  // Field selector + shallow compare: an unrelated store update (search text,
  // another Skill's env readiness, a toast) does not re-render every card.
  const { openSkillSheet, teams, setSkills, replaceSkill, activeTeamId, currentUser, promptForAuth, skillTitlePreference } = useStore(useShallow(selectSkillCardState))
  // Detection is refreshed once by App on launch and window focus; every card
  // reads that shared result instead of issuing its own native call.
  const installedAgents = useStore((state) => state.agentCapabilities)
  const hiddenCardAgents = useStore((state) => state.hiddenCardAgents)
  const unanalysed = useStore(state => isServerUnanalysed(spaceProfile(state.activeSpace), skill.serverAnalysisStatus))
  const [busyAgent, setBusyAgent] = useState<string | null>(null)
  const offlineAt = useCatalogOffline()
  const isMarketplace = context === 'marketplace'
  const title = skillListText(skill, skillTitlePreference)
  const versionDisplay = skillVersionDisplay(skill)
  const marketAction = marketplaceAction(skill)
  const managedSkillId = skill.marketplaceLocalId ?? skill.id
  const visibleAgents = new Set(visibleAgentKeys(installedAgents, skill.agents))
  const visibleAgentEntries = orderedAgentEntries(skill.agents)
    .filter(([key]) => visibleAgents.has(key))
  const cardAgents = cardAgentOptions(installedAgents, skill.agents, hiddenCardAgents)
  const brokenAgents = visibleAgentEntries.filter(([, status]) => status === 'broken').length
  // Personal `configured` state cannot account for a selected team value.
  // Only the resolved runtime policy is allowed to raise this issue badge.
  const keyIssue = envKeyIssue(envKeys)
  const hasIssues = skill.isOrphan
    || brokenAgents > 0
    || Boolean(keyIssue)
    || envPolicyFailed
    || skill.hasWorkingCopy
    || Boolean(versionDisplay.problem)
    || (Boolean(currentUser) && skill.accountSyncRequired)
  const primaryIssueTone = skill.isOrphan || brokenAgents > 0 || Boolean(versionDisplay.problem)
    ? 'danger'
    : keyIssue || envPolicyFailed
      ? 'warning'
      : 'info'
  const openPrimaryIssue = (): void => {
    if (skill.isOrphan || brokenAgents > 0) openSkillSheet(skill.id)
    else if (keyIssue || envPolicyFailed) openSkillSheet(skill.id, 'environment', 'env')
    else if (skill.hasWorkingCopy || versionDisplay.problem) openSkillSheet(skill.id, 'versions')
    else openSkillSheet(skill.id)
  }
  const sharedTeamIds = Object.keys(skill.sharedTo ?? {})
  const isTeamDistributed = Boolean(skill.teamSharedFrom) || sharedTeamIds.length > 0
  const activeTeamName = activeTeamId
    && (skill.teamSharedFrom === activeTeamId || sharedTeamIds.includes(activeTeamId))
    ? teams.find((team) => team.id === activeTeamId)?.name
    : undefined
  const teamName = activeTeamName
    ?? teams.find((team) => team.id === skill.teamSharedFrom)?.name
    ?? teams.find((team) => sharedTeamIds.includes(team.id))?.name
    ?? (skill.teamSharedFrom || sharedTeamIds.length > 0 ? '团队 Skill' : '个人 Skill')
  const factName = isMarketplace
    ? skill.authorName ?? publisherName ?? 'Skill 作者'
    : teamName
  const openDetails = (): void => {
    if (onOpen) onOpen()
    else openSkillSheet(skill.id)
  }
  const openAgentInstall = (agentKey: string): void => {
    if (onInstall) onInstall(agentKey)
    else openSkillSheet(skill.id, 'profile', `install:${agentKey}`)
  }

  const toggleAgent = async (agent: AgentInfo): Promise<void> => {
    if (busyAgent) return
    const status = skill.agents[agent.key]
    if (status !== 'on' || !skill.localPath) {
      openAgentInstall(agent.key)
      return
    }
    setBusyAgent(agent.key)
    try {
      await disableSkill(managedSkillId, agent.key)
      // Only the affected Skill is read back; the library watch reconciles the
      // whole list in the background without blocking this feedback.
      const refreshed = await getLocalSkill(managedSkillId)
      if (!refreshed) throw new Error('停用后未找到本机 Skill，请刷新列表')
      if (isMarketplace) {
        replaceSkill(skill.id, {
          ...skill,
          ...reconcileLocalSkillRefresh(skill, refreshed),
          id: skill.id,
          marketplaceLocalId: managedSkillId,
        })
      } else {
        setSkills(useStore.getState().skills.map((item) => item.id === managedSkillId
          ? reconcileLocalSkillRefresh(item, refreshed)
          : item))
      }
      toast(disabledToastMessage(agent.name, sharedProjectionAgents(agent.key, installedAgents)), 'default', async () => { await enableSkill(managedSkillId, agent.key); const restored = await getLocalSkill(managedSkillId); if (restored) setSkills(useStore.getState().skills.map((item) => item.id === managedSkillId ? reconcileLocalSkillRefresh(item, restored) : item)) })
    } catch (error: unknown) {
      toast(`无法更新 ${agent.name}：${messageOf(error)}`, 'error')
    } finally {
      setBusyAgent(null)
    }
  }

  const share = (): void => {
    if (!currentUser) {
      promptForAuth({
        reason: '登录后即可把这个 Skill 分享给团队',
        intent: { kind: 'share-skill', skillId: skill.id },
      })
      return
    }
    openSkillSheet(skill.id, 'profile', 'share')
  }

  return <>
    <article
      className={`skill-card skill-card-rich${isMarketplace ? ' marketplace' : ''}${skill.hasWorkingCopy ? ' wc' : ''}${dimmed ? ' dimmed' : ''}${skill.isOrphan ? ' orphan' : ''}`}
      title={title.primary}
    >
      <button
        className="card-open-control"
        aria-label={`查看 ${title.primary} 详情`}
        disabled={dimmed}
        onClick={openDetails}
        type="button"
      />
      <div className={`card-top${hasIssues ? ' has-issue' : ''}`}>
        <div className="card-identity">
          <CategoryIcon avatarUrl={skill.avatarUrl} status={skill.avatarStatus} />
          <div className="card-head">
            <div className="card-eyebrow">{skill.category ?? '其他'}</div>
            <div className="card-title-row"><h3 className={`card-title${skillTitlePreference === 'skill-name' ? ' skill-primary-name' : ''}`}>{title.primary}</h3>{skill.isSystem && <span className="card-system">系统</span>}{isMarketplace && <MarketplaceBadges badges={skill.marketplaceBadges} />}<span className="card-version mono">{versionDisplay.label}</span>{skill.versionStatus === 'pending' && <span className="card-version">待确认</span>}{skill.hasWorkingCopy && <span className="card-version">已修改</span>}</div>
            {title.secondary && <span className={`card-slug${skillTitlePreference === 'ai-title' ? ' mono' : ''}`}>{title.secondary}</span>}
            {versionDisplay.problem && <span className="card-problem" title={versionDisplay.problem} role="status">{versionDisplay.problem}</span>}
          </div>
        </div>
        <div className={`card-side${hasIssues ? ' has-issue' : ''}`}>
          <div className="card-icon-actions">
            {isMarketplace && onShare && <button type="button" aria-label={`分享 ${skill.displayName}`} title="复制分享链接" disabled={dimmed} onClick={onShare}><Icon name="share" size={14} /></button>}
            {!isMarketplace && skill.localPath && canManageSkillAsset(skill) && <button type="button" aria-label={`将 ${skill.displayName} 移入回收站`} title="移入回收站" onClick={(event) => { event.stopPropagation(); openSkillSheet(skill.id, 'profile', 'delete') }}><Icon name="trash" size={14} /></button>}
            {!isMarketplace && canManageSkillAsset(skill) && <button type="button" aria-label={`分享 ${skill.displayName}`} title="分享" onClick={(event) => { event.stopPropagation(); share() }}><Icon name="share" size={14} /></button>}
          </div>
          {hasIssues && (
            <div className="card-issue-stack" aria-label="Skill 问题">
              <button type="button" className={`card-issue ${primaryIssueTone}`} onClick={(event) => { event.stopPropagation(); openPrimaryIssue() }}>
                {skill.isOrphan
                  ? <><Icon name="warn" size={13} />资料暂不可用</>
                  : brokenAgents > 0
                    ? <><Icon name="warn" size={13} />安装有问题</>
                    : keyIssue
                      ? <><Icon name={keyIssue.icon} size={13} strokeWidth={1.75} />{keyIssue.label}</>
                      : envPolicyFailed
                        ? <><Icon name="warn" size={13} />钥匙检查未完成</>
                        : versionDisplay.problem
                          ? <><Icon name="warn" size={13} />版本需要处理</>
                          : skill.hasWorkingCopy
                            ? <><Icon name="hist" size={13} />已修改</>
                            : <><Icon name="refresh" size={13} />云端关联需更新</>}
              </button>
            </div>
          )}
        </div>
      </div>



      {unanalysed && <span className="inline-status checking">未分析</span>}
      {skill.description && <p className="card-desc">{skill.description}</p>}
      {skill.labels.length > 0 && <div className="card-labels compact">{skill.labels.slice(0, 3).map((label) => <i key={label}>{label}</i>)}</div>}
      {isMarketplace && <EditorialLabels labels={editorialLabelsBesideBadges(skill.marketplaceEditorialLabels, skill.marketplaceBadges)}/>}

      <div className="card-agent-line" aria-label="Agent 安装状态">
        {cardAgents.length > 0
          ? <div className="card-agent-buttons" data-tour="install">{cardAgents.map((agent) => {
              const status = skill.agents[agent.key] ?? null
              const state = status === 'on' ? 'installed' : status === 'broken' ? 'broken' : 'available'
              const label = skill.isSystem
                ? `${agent.name} 由 SkillHub 自动维护`
                : state === 'installed'
                ? disableAgentLabel(agent.name, sharedProjectionAgents(agent.key, installedAgents))
                : state === 'broken'
                  ? `${agent.name} 安装有问题，点击修复`
                  : `安装到 ${agent.name}`
              return <button
                type="button"
                key={agent.key}
                className={`card-agent-button ${state}`}
                aria-label={label}
                title={offlineAt && isMarketplace && !skill.localPath ? CATALOG_INSTALL_OFFLINE : label}
                disabled={busyAgent !== null || skill.isSystem || Boolean(offlineAt && isMarketplace && !skill.localPath)}
                onClick={(event) => { event.stopPropagation(); void toggleAgent(agent) }}
              >
                <AgentBrandIcon agent={agent} size={28} />
                <span className="card-agent-state"><Icon name={state === 'broken' ? 'warn' : state === 'installed' ? 'check' : 'plus'} size={8} /></span>
                {busyAgent === agent.key && <span className="card-agent-busy spin-icon" aria-hidden="true" />}
              </button>
            })}</div>
          : <span className="card-agent-empty"><Icon name="clock" size={13} />未检测到 AI 工具</span>}
        {isMarketplace && onInstall && <button type="button" className={`btn btn-ghost btn-sm card-marketplace-actions${marketAction.update ? ' marketplace-update' : ''}`} title={offlineAt ? CATALOG_INSTALL_OFFLINE : undefined} disabled={Boolean(offlineAt) || dimmed || (marketAction.joined && !marketAction.update)} onClick={() => onInstall()}><Icon name={marketAction.update ? 'import' : marketAction.joined ? 'check' : 'plus'} size={12} />{marketAction.label}</button>}
      </div>

      <div className="card-facts">
        {isMarketplace
          ? <span title="作者"><Icon name="user" size={13} />{factName}</span>
          : <span title={isTeamDistributed ? '团队' : '归属'}><Icon name={isTeamDistributed ? 'team' : 'user'} size={13} />{factName}</span>}
        {isMarketplace
          ? <><span className="card-downloads" title="安装量"><Icon name="import" size={13} />{skill.installCount.toLocaleString()}</span><span className="card-downloads" title="正在使用"><Icon name="user" size={13} />{(skill.marketplaceUserCount ?? 0).toLocaleString()}</span></>
          : isTeamDistributed && <span className="card-downloads" title="团队包下载次数"><Icon name="import" size={13} />{skill.installCount.toLocaleString()}</span>}
      </div>
    </article>
  </>
}

export { CategoryIcon, MarketplaceBadges }
