import { useCatalogOffline } from '../lib/use-catalog-offline.js'
import { catalogOfflineAt, catalogOfflineMessage, CATALOG_INSTALL_OFFLINE } from '../lib/catalog-cache.js'
import { marketplaceAction } from '../lib/marketplace-state.js'
import { userMessage } from '../lib/user-message.js'
import {
  useCallback, useEffect, useMemo, useRef, useState,
} from 'react'
import { Icon } from '../components/Icon.js'
import { BlankDragSpacer } from '../components/WindowDragRegion.js'
import { PageHeading } from '../components/PageHeading.js'
import { EditorialLabels } from '../components/EditorialLabels.js'
import SkillCard, { CategoryIcon, MarketplaceBadges } from '../components/SkillCard.js'
import ConfirmModal from '../components/ConfirmModal.js'
import FocusTrapDialog from '../components/FocusTrapDialog.js'
import { toast } from '../components/Toast.js'
import { EmptyState, LoadError, SkeletonBlock } from '../components/StateViews.js'
import { EMPTY_COPY, LOADING_COPY, RETRY_LABEL, loadFailedMessage } from '../lib/state-copy.js'
import {
  SectionHead, StatTile, StoreCarousel, StoreSearchBar, StoreSkeleton, StoreSkillCard, StoreSkillRow,
  StoreIcon, TopicCard, TrendingList,
} from '../components/store/StoreUI.js'
import { StoreFeed, StoreFilterBar, type StoreFilterDef } from '../components/store/StoreFeed.js'
import {
  API_KEY_OPTIONS, CATALOG_SEARCH_DEBOUNCE_MS, CATALOG_SORTS, DEFAULT_CATALOG_CRITERIA, DEFAULT_CATALOG_SORT,
  applyCapabilities, catalogQuery, catalogResetKey, disableFeatures, guardApiKeyFilter, pageHasMore, rankingPresetSort,
  readCapabilities, rejectedFeatures, visibleSorts,
  type CatalogCriteria, type FeedPage, type StoreCapabilities,
} from '../lib/store-catalog.js'
import { agentDisplayName } from '../lib/agents.js'
import {
  apiApproveMarketplaceSubmission,
  apiCreateMarketplaceInstallIntent, apiFinishMarketplaceInstallIntent,
  apiDownloadMarketplacePackage,
  apiGetMarketplace,
  apiGetMarketplaceCategories,
  apiGetMarketplaceHome,
  apiGetMarketplaceStats,
  apiGetMarketplaceTrending,
  apiGetMarketplaceAdminSubmission,
  apiGetMarketplaceAdminSubmissions,
  apiGetMarketplacePackageInspection,
  apiGetMarketplaceMine,
  apiGetMarketplaceSkill,
  apiGetMarketplaceTopic,
  apiRejectMarketplaceSubmission,
  apiStartMarketplaceReview,
  apiUnpublishMarketplaceSkill,
  apiWithdrawMarketplaceSubmission,
  type ApiMarketplaceAdminSubmission,
  type ApiMarketplaceHome,
  type ApiMarketplaceItem,
  type ApiMarketplaceMineItem,
  type ApiMarketplacePackageInspection,
  type ApiMarketplaceStats,
  type ApiMarketplaceTopic,
  type MarketplaceSubmissionStatus,
} from '../lib/api.js'
import { mergeMarketplaceSkill } from '../lib/skills.js'
import {
  editorialLabelsBesideBadges, formatStoreCount, formatStoreDate, loadRanking, loadStoreStats, searchSuggestions, statTiles,
  storeTabs, topicTone, type Ranking, type RankingRange, type StoreTab,
} from '../lib/store-home.js'
import { acquireMarketplaceSkill } from '../lib/marketplace-acquisition.js'
import { offerKeyInstallGuide } from '../lib/skill-keys.js'
import { buildMarketplaceShareUrl } from '../lib/marketplace-deep-link.js'
import { syncMarketplaceManagedPresence } from '../lib/marketplace-presence.js'
import { skillListText } from '../lib/skill-title.js'
import { currentSpace, getLocalSkills, importSkillPackage } from '../lib/tauri.js'
import { requestLibrarySync } from '../lib/library-sync.js'
import { openUrl } from '@tauri-apps/plugin-opener'
import { classifyMarkdownLink } from '../lib/markdown.js'
import { topicArticleOf } from '../lib/topic-article.js'
import { TopicArticleBody } from '../components/store/TopicArticle.js'
import { articleSkills, installAllPlan, topicSkillMap, type InstallAllResult } from '../lib/topic-install.js'
import { useStore, type LocalSkill } from '../store/index.js'
import './MarketplacePage.css'

// 首页 / 全部技能 / 我的 (/ 审核队列), see storeTabs.
type MarketplaceMode = StoreTab
type CatalogPreset = Partial<CatalogCriteria>

const FEATURED_HOME_SIZE = 6
const LATEST_HOME_SIZE = 5
const RANKING_RANGES = [{ id: 'day', label: '今日' }, { id: 'week', label: '本周' }]

/** The most common category among a topic's Skills, used as the TopicCard kicker. */
function topicKicker(topic: ApiMarketplaceTopic): string | undefined {
  const counts = new Map<string, number>()
  for (const item of topic.items) if (item.category) counts.set(item.category, (counts.get(item.category) ?? 0) + 1)
  return [...counts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0]
}

async function readLocalSkills(): Promise<LocalSkill[]> {
  try { return await getLocalSkills() }
  catch { return useStore.getState().skills.filter((skill) => Boolean(skill.localPath)) }
}

function catalogLocals(skills: LocalSkill[]): LocalSkill[] {
  const space = useStore.getState().activeSpace
  return !space || space.spaceId === 'official' ? skills : skills.filter(skill => Boolean(skill.catalogOrigin))
}

function mergeCatalogItems(items: ApiMarketplaceItem[], localSkills: LocalSkill[]): LocalSkill[] {
  const userId = useStore.getState().currentUser?.id
  return items.map((item) => mergeMarketplaceSkill(item, catalogLocals(localSkills).find((skill) => skill.serverId === item.id), userId))
}
type MarketplaceView = 'card' | 'list'
type MineAction =
  | { kind: 'withdraw'; item: ApiMarketplaceMineItem; submissionId: string }
  | { kind: 'unpublish'; item: ApiMarketplaceMineItem }
  | null

const REVIEW_PAGE_SIZE = 25
const REVIEW_STATUSES: MarketplaceSubmissionStatus[] = [
  'submitted', 'under_review', 'approved', 'rejected', 'withdrawn',
]

const MARKETPLACE_DIRECTORIES = [
  { value: '全部', label: '全部' },
  { value: '协作与办公', label: '办公' },
  { value: '开发与工程', label: '编程' },
  { value: '内容与创作', label: '创作' },
  { value: '自动化与集成', label: '自动化' },
  { value: '搜索与研究', label: '研究' },
  { value: '数据与分析', label: '数据' },
  { value: '其他', label: '其他' },
] as const

const STATUS_LABELS: Record<MarketplaceSubmissionStatus, string> = {
  submitted: '待审核',
  under_review: '审核中',
  approved: '已通过',
  rejected: '未通过',
  withdrawn: '已撤回',
}

function messageOf(error: unknown): string {
  return userMessage(error)
}

function formatDate(value: string | null | undefined): string {
  if (!value) return '时间未知'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '时间未知' : date.toLocaleString('zh-CN')
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '未知'
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

function statusTone(status: MarketplaceSubmissionStatus): string {
  if (status === 'approved') return 'chip-ok'
  if (status === 'rejected') return 'chip-danger'
  if (status === 'submitted' || status === 'under_review') return 'chip-accent'
  return ''
}

function SubmissionStatus({ status }: { status: MarketplaceSubmissionStatus }) {
  return <span className={`chip marketplace-status ${statusTone(status)}`}>{STATUS_LABELS[status]}</span>
}

function MarketplaceSkillRow({
  skill,
  dimmed,
  onOpen,
  onInstall,
  onShare,
}: {
  skill: LocalSkill
  dimmed: boolean
  onOpen: () => void
  onInstall: () => void
  onShare: () => void
}) {
  const skillTitlePreference = useStore((state) => state.skillTitlePreference)
  const title = skillListText(skill, skillTitlePreference)
  const action = marketplaceAction(skill)
  return <article className={`marketplace-skill-row${dimmed ? ' dimmed' : ''}`}>
    <button type="button" className="marketplace-skill-row-main" disabled={dimmed} aria-label={`查看 ${title.primary} 详情`} onClick={onOpen}>
      <CategoryIcon avatarUrl={skill.avatarUrl} />
      {/* Line 1: primary name with NEW/HOT, 精选 and editorial labels; line 2: the other name. */}
      <span className="marketplace-skill-row-name">
        <span className="marketplace-skill-row-title"><strong className={skillTitlePreference === 'skill-name' ? 'skill-primary-name' : undefined} title={title.primary}>{title.primary}</strong><MarketplaceBadges badges={skill.marketplaceBadges} /><EditorialLabels labels={editorialLabelsBesideBadges(skill.marketplaceEditorialLabels, skill.marketplaceBadges)} limit={2}/></span>
        {title.secondary && <small className={skillTitlePreference === 'ai-title' ? 'mono' : undefined} title={title.secondary}>{title.secondary}</small>}
      </span>
    </button>
    <div className="marketplace-skill-row-metrics" aria-label="Skill 数据">
      <span title={`${skill.installCount.toLocaleString()} 次安装`}><Icon name="import" size={13} />{skill.installCount.toLocaleString()}</span>
      <span title={`${(skill.marketplaceUserCount ?? 0).toLocaleString()} 位用户在用`}><Icon name="user" size={13} />{(skill.marketplaceUserCount ?? 0).toLocaleString()}</span>
    </div>
    <div className="marketplace-row-actions"><button type="button" className="btn btn-ghost btn-sm" aria-label={`分享 ${skill.displayName}`} onClick={onShare}><Icon name="share" size={13} /></button><button type="button" className={`btn btn-ghost btn-sm marketplace-skill-row-install${action.update ? ' marketplace-update' : ''}`} title={catalogOfflineAt() ? CATALOG_INSTALL_OFFLINE : undefined} disabled={Boolean(catalogOfflineAt()) || dimmed || (action.joined && !action.update)} onClick={onInstall}>{action.label}</button></div>
  </article>
}

export default function MarketplacePage() {
  const offlineAt = useCatalogOffline()
  const spaceCaps = useSpaceCapabilities()
  const {
    currentUser: businessUser, marketplaceSkills, agentCapabilities,
    setMarketplaceSkills, openSkillSheet, setView,
    pendingMarketplaceIntent, setPendingMarketplaceIntent,
    skillTitlePreference,
  } = useStore()
  const currentUser = spaceCaps.profile === 'official' && spaceCaps.marketplace ? businessUser : null
  const [mode, setMode] = useState<MarketplaceMode>('home')
  const [catalogView, setCatalogView] = useState<MarketplaceView>(() => {
    try { return window.localStorage.getItem('skillhub:marketplace-view') === 'list' ? 'list' : 'card' }
    catch { return 'card' }
  })
  const [searchInput, setSearchInput] = useState('')
  // 全部技能: requested criteria; unsupported options are dropped by applyCapabilities below.
  const [catalogRequest, setCatalogRequest] = useState<CatalogCriteria>(DEFAULT_CATALOG_CRITERIA)
  const [capabilities, setCapabilities] = useState<StoreCapabilities>(readCapabilities)
  const catalog = useMemo(() => applyCapabilities(catalogRequest, capabilities), [catalogRequest, capabilities])
  const catalogKey = catalogResetKey(catalog)
  const [catalogRefresh, setCatalogRefresh] = useState(0)
  const [total, setTotal] = useState<number | null>(null)
  const [catalogCategories, setCatalogCategories] = useState<string[]>([])
  const [knownCategories, setKnownCategories] = useState<string[]>([])
  const [selectedTopic, setSelectedTopic] = useState<ApiMarketplaceTopic | null>(null)
  const [topicSkills, setTopicSkills] = useState<LocalSkill[]>([])
  const [topicInstall, setTopicInstall] = useState<{ running: boolean; results: Record<string, InstallAllResult> }>({ running: false, results: {} })
  // 首页: every panel loads on its own and hides itself when its source is unavailable.
  const [home, setHome] = useState<ApiMarketplaceHome | null>(null)
  const [homeLatest, setHomeLatest] = useState<LocalSkill[]>([])
  const [homeError, setHomeError] = useState<string | null>(null)
  const [homeFeatured, setHomeFeatured] = useState<LocalSkill[] | null>(null)
  const [homeFeaturedError, setHomeFeaturedError] = useState(false)
  const [storeStats, setStoreStats] = useState<ApiMarketplaceStats | null>(null)
  const [rankingRange, setRankingRange] = useState<RankingRange>('day')
  const [ranking, setRanking] = useState<Ranking<LocalSkill> | null>(null)
  const [rankingLoading, setRankingLoading] = useState(true)
  const [rankingFailed, setRankingFailed] = useState(false)
  const trendingAvailable = useRef(true)
  const [categoryCounts, setCategoryCounts] = useState<Record<string, number>>({})
  const [homeQuery, setHomeQuery] = useState('')
  const homeGenerationRef = useRef(0)
  const pageHeadRef = useRef<HTMLDivElement>(null)
  const [pageHeadHeight, setPageHeadHeight] = useState(0)
  const acquisitionBusy = useRef(false)
  const [openingSkillId, setOpeningSkillId] = useState<string | null>(null)
  const [mineItems, setMineItems] = useState<ApiMarketplaceMineItem[]>([])
  const [mineLoading, setMineLoading] = useState(false)
  const [mineError, setMineError] = useState<string | null>(null)
  const [mineAction, setMineAction] = useState<MineAction>(null)
  const [mineBusy, setMineBusy] = useState(false)
  const [reviewStatus, setReviewStatus] = useState<MarketplaceSubmissionStatus>('submitted')
  const [reviewPage, setReviewPage] = useState(1)
  const [reviewTotal, setReviewTotal] = useState(0)
  const [reviewTotalPages, setReviewTotalPages] = useState(0)
  const [reviewItems, setReviewItems] = useState<ApiMarketplaceAdminSubmission[]>([])
  const [reviewLoading, setReviewLoading] = useState(false)
  const [reviewError, setReviewError] = useState<string | null>(null)
  const [reviewBusyId, setReviewBusyId] = useState<string | null>(null)
  const [reviewDetailId, setReviewDetailId] = useState<string | null>(null)
  const [reviewDetail, setReviewDetail] = useState<ApiMarketplaceAdminSubmission | null>(null)
  const [reviewPackage, setReviewPackage] = useState<ApiMarketplacePackageInspection | null>(null)
  const [selectedReviewFilePath, setSelectedReviewFilePath] = useState<string | null>(null)
  const [reviewPackageChecked, setReviewPackageChecked] = useState(false)
  const [reviewDetailLoading, setReviewDetailLoading] = useState(false)
  const [reviewDetailError, setReviewDetailError] = useState<string | null>(null)
  const [rejecting, setRejecting] = useState<ApiMarketplaceAdminSubmission | null>(null)
  const [rejectReason, setRejectReason] = useState('')
  const mineGenerationRef = useRef(0)
  const reviewGenerationRef = useRef(0)
  const reviewDetailGenerationRef = useRef(0)
  const accountGenerationRef = useRef(0)
  const isMarketplaceAdmin = currentUser?.marketplaceRole === 'admin'
  const privilegeScope = `${currentUser?.id ?? 'guest'}:${isMarketplaceAdmin ? 'admin' : 'user'}`
  const [privilegedStateScope, setPrivilegedStateScope] = useState(privilegeScope)
  const privilegedStateIsCurrent = privilegedStateScope === privilegeScope

  // Search filters in place after 250ms; a changed query resets the feed.
  useEffect(() => {
    const timeout = window.setTimeout(() => {
      const next = searchInput.trim()
      setCatalogRequest((current) => current.query === next ? current : { ...current, query: next })
    }, CATALOG_SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(timeout)
  }, [searchInput])

  // The FilterBar pins directly under the sticky page head, whatever its height.
  useEffect(() => {
    const head = pageHeadRef.current
    if (!head) return
    const update = (): void => setPageHeadHeight(head.offsetHeight)
    update()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update)
    observer?.observe(head)
    return () => observer?.disconnect()
  }, [])

  useEffect(() => {
    // Author and reviewer data must never survive an account or role change.
    // The render gate below hides the old scope synchronously; these generation
    // bumps also prevent any in-flight response from restoring stale data.
    accountGenerationRef.current += 1
    mineGenerationRef.current += 1
    reviewGenerationRef.current += 1
    reviewDetailGenerationRef.current += 1
    setMineItems([])
    setMineLoading(false)
    setMineError(null)
    setMineAction(null)
    setMineBusy(false)
    setReviewItems([])
    setReviewLoading(false)
    setReviewError(null)
    setReviewBusyId(null)
    setReviewDetailId(null)
    setReviewDetail(null)
    setReviewPackage(null)
    setSelectedReviewFilePath(null)
    setReviewPackageChecked(false)
    setReviewDetailLoading(false)
    setReviewDetailError(null)
    setRejecting(null)
    setRejectReason('')
    setPrivilegedStateScope(privilegeScope)
    setMode((currentMode) => (
      !currentUser || (!isMarketplaceAdmin && currentMode === 'review')
        ? currentMode === 'mine' || currentMode === 'review' ? 'home' : currentMode
        : currentMode
    ))
  }, [privilegeScope])

  /**
   * One 全部技能 page, merged with the local runtime state. A 400 that names rising or
   * apiKey hides that option for this session (the criteria then change, which resets
   * the feed); an older server that silently ignores apiKey is caught by the guard.
   */
  const fetchCatalogPage = useCallback(async (page: number): Promise<FeedPage<LocalSkill>> => {
    const request = catalogQuery(catalog, page)
    try {
      const [result, localSkills] = await Promise.all([apiGetMarketplace(request), readLocalSkills()])
      const guarded = guardApiKeyFilter(result.items, catalog.apiKey)
      if (guarded.ignoredByServer) setCapabilities((current) => disableFeatures(current, ['apiKey']))
      if (result.categories?.length) {
        setKnownCategories((current) => Array.from(new Set([...current, ...(result.categories ?? []).map((category) => category.trim()).filter(Boolean)])))
      }
      return {
        items: mergeCatalogItems(guarded.items, localSkills),
        total: result.total,
        hasMore: pageHasMore(page, result.total, result.items.length),
      }
    } catch (error: unknown) {
      const rejected = rejectedFeatures(error, request)
      if (rejected.length) setCapabilities((current) => disableFeatures(current, rejected))
      throw error
    }
    // The feed resets on catalogKey; the callback follows exactly the same criteria.
  }, [catalogKey])

  // 场景分类 options; the home categories and the stable directory list remain the fallback.
  useEffect(() => {
    if (mode !== 'catalog') return
    let active = true
    apiGetMarketplaceCategories().then((response) => {
      if (active) setCatalogCategories(response.items.map((category) => category.name).filter(Boolean))
    }, () => undefined)
    return () => { active = false }
  }, [mode])

  useEffect(() => { setTotal(null) }, [catalogKey])

  /**
   * 首页 data: /marketplace/home (topics, latest, popular, categories), 精选 Skills,
   * /marketplace/stats and per-category counts. Each source fails on its own; stats
   * that are unavailable hide the 商店动态 panel instead of showing empty numbers.
   */
  const loadHome = useCallback(async (silent = false): Promise<void> => {
    const generation = ++homeGenerationRef.current
    if (!silent) { setHomeError(null); setHomeFeaturedError(false) }
    const [homeResult, featuredResult, statsResult, localSkills] = await Promise.all([
      apiGetMarketplaceHome(8).then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error })),
      apiGetMarketplace({ featured: true, sort: 'popular', page: 1, pageSize: FEATURED_HOME_SIZE })
        .then((value) => ({ ok: true as const, value }), () => ({ ok: false as const })),
      loadStoreStats(apiGetMarketplaceStats),
      readLocalSkills(),
    ])
    if (generation !== homeGenerationRef.current) return
    setStoreStats(statsResult)
    if (homeResult.ok) {
      setHome(homeResult.value)
      setHomeError(null)
      setHomeLatest(mergeCatalogItems(homeResult.value.latest.slice(0, LATEST_HOME_SIZE), localSkills))
      setKnownCategories(homeResult.value.categories.map((category) => category.name))
    } else if (!silent) setHomeError(messageOf(homeResult.error))
    if (featuredResult.ok) { setHomeFeatured(mergeCatalogItems(featuredResult.value.items, localSkills)); setHomeFeaturedError(false) }
    else if (!silent) setHomeFeaturedError(true)
  }, [])

  // 飙升榜 (今日 / 本周); falls back to the popular ranking once trending is unavailable.
  useEffect(() => {
    if (mode !== 'home') return
    let active = true
    setRankingLoading(true)
    void readLocalSkills().then((localSkills) => loadRanking<LocalSkill>({
      trending: apiGetMarketplaceTrending,
      popular: (limit) => apiGetMarketplace({ sort: 'popular', page: 1, pageSize: limit }).then((result) => result.items),
      toSkill: (item) => mergeCatalogItems([item], localSkills)[0]!,
    }, rankingRange, trendingAvailable.current)).then((value) => {
      if (!active) return
      setRanking(value)
      setRankingFailed(false)
      if (value.mode === 'popular') trendingAvailable.current = false
    }, () => { if (active) setRankingFailed(true) }).finally(() => { if (active) setRankingLoading(false) })
    return () => { active = false }
  }, [mode, rankingRange])

  // 按场景浏览 counts: one pageSize=1 request per category; a failed count is simply not shown.
  useEffect(() => {
    if (mode !== 'home' || !home?.categories.length) return
    let active = true
    for (const category of home.categories) {
      apiGetMarketplace({ category: category.name, page: 1, pageSize: 1 })
        .then((result) => { if (active) setCategoryCounts((current) => ({ ...current, [category.name]: result.total })) }, () => undefined)
    }
    return () => { active = false }
  }, [home, mode])

  const homeSuggestions = useMemo(() => home ? searchSuggestions([...home.popular, ...home.latest]) : [], [home])

  /** Opens 全部技能 with a preset (search, sort, category or featured-only). */
  const openCatalog = (preset: CatalogPreset): void => {
    topicGeneration.current += 1 // a late topic read never reopens the topic
    setSelectedTopic(null)
    setTopicSkills([])
    const next: CatalogCriteria = { ...DEFAULT_CATALOG_CRITERIA, ...preset, query: preset.query?.trim() ?? '' }
    setSearchInput(next.query)
    setCatalogRequest(next)
    setMode('catalog')
  }

  const updateCatalog = (patch: Partial<CatalogCriteria>): void => setCatalogRequest((current) => ({ ...current, ...patch }))
  const clearCatalogFilters = (): void => {
    setSearchInput('')
    setCatalogRequest((current) => ({ ...DEFAULT_CATALOG_CRITERIA, sort: current.sort }))
  }

  const mergeTopicItems = async (items: ApiMarketplaceItem[]): Promise<LocalSkill[]> => {
    const localResult = await Promise.allSettled([getLocalSkills()])
    const localSkills = localResult[0]?.status === 'fulfilled'
      ? localResult[0].value
      : useStore.getState().skills.filter((skill) => Boolean(skill.localPath))
    const localByServerId = new Map(catalogLocals(localSkills).flatMap((skill) => skill.serverId ? [[skill.serverId, skill] as const] : []))
    return items.map((item) => mergeMarketplaceSkill(item, localByServerId.get(item.id), useStore.getState().currentUser?.id))
  }
  // #213 topic article: the home list has no body, so the topic is read again by slug.
  // `loading` keeps the old list out of sight until the body arrives; `failed` keeps the
  // old layout with a 重试 notice (offline); a Server without bodies keeps the old layout.
  const [topicLoad, setTopicLoad] = useState<'idle' | 'loading' | 'failed'>('idle')
  const topicGeneration = useRef(0)
  const homeScrollTop = useRef(0)
  const scrollPane = (): HTMLElement | null => document.querySelector<HTMLElement>('.app-main')
  const openTopic = async (topic: ApiMarketplaceTopic, keepScroll = false): Promise<void> => {
    const generation = ++topicGeneration.current
    try {
      if (!keepScroll) homeScrollTop.current = scrollPane()?.scrollTop ?? 0
      setSelectedTopic(topic)
      setTopicSkills(await mergeTopicItems(topic.items))
      setTopicInstall({ running: false, results: {} })
      setTopicLoad('loading')
      if (!keepScroll) scrollPane()?.scrollTo({ top: 0 })
    } catch (error: unknown) {
      toast(`无法打开专题：${messageOf(error)}`, 'error')
      return
    }
    try {
      const detail = await apiGetMarketplaceTopic(topic.slug)
      const merged = await mergeTopicItems(detail.items)
      if (generation !== topicGeneration.current) return
      setSelectedTopic(detail)
      setTopicSkills(merged)
      setTopicLoad('idle')
    } catch {
      if (generation === topicGeneration.current) setTopicLoad('failed')
    }
  }
  /** 返回首页: back to where the home page was scrolled. */
  const closeTopic = (): void => {
    topicGeneration.current += 1
    setSelectedTopic(null)
    setTopicSkills([])
    setTopicLoad('idle')
    const top = homeScrollTop.current
    window.requestAnimationFrame(() => scrollPane()?.scrollTo({ top }))
  }
  const openTopicLink = (href: string): void => {
    // Topic links have no Skill files: only web links do something, in the system browser.
    const target = classifyMarkdownLink(href, [])
    if (target.kind === 'external') void openUrl(target.url).catch((reason: unknown) => toast(messageOf(reason), 'error'))
  }

  useEffect(() => {
    if (mode !== 'home') return
    void loadHome()
    return () => { homeGenerationRef.current += 1 }
  }, [loadHome, mode])

  useEffect(() => {
    const refreshFromNavigation = (): void => {
      if (mode === 'home') void loadHome(true)
      else if (mode === 'catalog') setCatalogRefresh((value) => value + 1)
      else setMode('home')
    }
    window.addEventListener('skillhub:refresh-marketplace', refreshFromNavigation)
    return () => window.removeEventListener('skillhub:refresh-marketplace', refreshFromNavigation)
  }, [loadHome, mode])

  const changeCatalogView = (next: MarketplaceView): void => {
    setCatalogView(next)
    try { window.localStorage.setItem('skillhub:marketplace-view', next) }
    catch { /* The current view still works when local preferences are unavailable. */ }
  }

  const shareMarketplaceSkill = async (skill: LocalSkill): Promise<void> => {
    try {
      await navigator.clipboard.writeText(buildMarketplaceShareUrl(skill.serverId ?? ''))
      toast('分享链接已复制')
    } catch (error: unknown) { toast(`分享失败：${messageOf(error)}`, 'error') }
  }

  const [updateTarget, setUpdateTarget] = useState<LocalSkill | null>(null)
  /** The one join / update path for every store surface. Resolves true when the Skill was joined or updated. */
  const joinMySkills = async (skill: LocalSkill, confirmed = false): Promise<boolean> => {
    if (catalogOfflineAt()) { toast(CATALOG_INSTALL_OFFLINE, 'error'); return false }
    if (marketplaceAction(skill).update && !confirmed) { setUpdateTarget(skill); return false }
    if (acquisitionBusy.current) return false
    acquisitionBusy.current = true
    setOpeningSkillId(skill.id)
    let receipt = skill.marketplaceInstallIntentId
    try {
      const acquisitionSpace = await currentSpace()
      if (!skill.serverId) throw new Error('缺少商店 Skill 标识')
      const detail = await apiGetMarketplaceSkill(skill.serverId)
      if (!confirmed && !receipt) receipt = await apiCreateMarketplaceInstallIntent(skill.serverId, `app:${crypto.randomUUID()}`, 'app', 'join').then(value => value?.id).catch(() => undefined)
      const local = await acquireMarketplaceSkill(mergeMarketplaceSkill(detail, undefined), {
        spaceId: acquisitionSpace.spaceId,
        currentUserId: useStore.getState().currentUser?.id, localSkills: getLocalSkills, download: apiDownloadMarketplacePackage, importPackage: (data) => importSkillPackage(data, acquisitionSpace),
      }, confirmed)
      const state = useStore.getState()
      state.setSkills([...state.skills.filter(item => item.id !== local.id), local])
      if (state.currentUser) await syncMarketplaceManagedPresence()
      // 全部技能 rows pick up the new local state through withLiveRuntime; the home panels reload quietly.
      if (mode === 'home') await loadHome(true)
      if (receipt) void apiFinishMarketplaceInstallIntent(receipt, 'completed').catch(() => undefined)
      // "加入即同步": the new or updated Skill joins the account right away.
      requestLibrarySync()
      setUpdateTarget(null)
      toast(confirmed ? 'Skill 已更新' : '已加入我的 Skills')
      if (!confirmed) offerKeyInstallGuide(local)
      return true
    } catch (error: unknown) { if (receipt) void apiFinishMarketplaceInstallIntent(receipt, 'failed').catch(() => undefined); toast(`加入失败：${messageOf(error)}`, 'error'); return false }
    finally { acquisitionBusy.current = false; setOpeningSkillId(null) }
  }

  /**
   * 全部安装 (#213 §4.4): the topic's Skills one after another through joinMySkills, with a
   * result per Skill. Joined ones are skipped, updates wait for their own confirmation, and
   * an account switch stops every later write.
   */
  const installTopicSkills = async (skills: LocalSkill[]): Promise<void> => {
    if (topicInstall.running) return
    const accountId = useStore.getState().currentUser?.id
    const results: Record<string, InstallAllResult> = {}
    const publish = (running: boolean): void => setTopicInstall({ running, results: { ...results } })
    for (const skill of skills) {
      const plan = installAllPlan(withLiveRuntime(skill))
      if (plan !== 'install') { results[skill.id] = plan; continue }
      if (useStore.getState().currentUser?.id !== accountId) { results[skill.id] = 'stopped'; continue }
      results[skill.id] = 'running'; publish(true)
      results[skill.id] = await joinMySkills(withLiveRuntime(skill)) ? 'done' : 'failed'
    }
    publish(false)
  }

  const liveLocalSkills = useStore(state => state.skills)
  const withLiveRuntime = (catalog: LocalSkill): LocalSkill => {
    const local = catalogLocals(liveLocalSkills).find(item => item.serverId === catalog.serverId && item.localPath)
    return local ? { ...catalog, localPath: local.localPath, marketplaceLocalId: local.id, marketplaceLocalVersion: local.acquisitionVersion ?? local.version, agents: local.agents, installed: local.installed } : catalog
  }
  const renderCatalogSkills = (skills: LocalSkill[], keyPrefix: string) => catalogView === 'list'
    ? <div className="marketplace-skill-list">{skills.map(withLiveRuntime).map((skill) => <MarketplaceSkillRow key={`${keyPrefix}:${skill.id}`} skill={skill} dimmed={openingSkillId === skill.id} onOpen={() => void openMarketplaceSkill(skill)} onInstall={() => void joinMySkills(skill)} onShare={() => void shareMarketplaceSkill(skill)} />)}</div>
    : <div className="skills-grid marketplace-grid">{skills.map(withLiveRuntime).map((skill) => <SkillCard key={`${keyPrefix}:${skill.id}`} skill={skill} context="marketplace" publisherName={skill.authorName} dimmed={openingSkillId === skill.id} onOpen={() => void openMarketplaceSkill(skill)} onInstall={(agentKey) => { if (agentKey) void openMarketplaceSkill(skill, `install:${agentKey}`); else void joinMySkills(skill) }} onShare={() => void shareMarketplaceSkill(skill)} />)}</div>

  const loadMine = useCallback(async (): Promise<void> => {
    if (!currentUser) return
    const generation = ++mineGenerationRef.current
    setMineLoading(true)
    setMineError(null)
    try {
      const response = await apiGetMarketplaceMine()
      if (generation === mineGenerationRef.current) setMineItems(response.items)
    } catch (error: unknown) {
      if (generation === mineGenerationRef.current) setMineError(messageOf(error))
    } finally {
      if (generation === mineGenerationRef.current) setMineLoading(false)
    }
  }, [currentUser])

  useEffect(() => {
    if (mode !== 'mine') return
    void loadMine()
    return () => { mineGenerationRef.current += 1 }
  }, [loadMine, mode])

  const loadReviewQueue = useCallback(async (): Promise<void> => {
    if (!isMarketplaceAdmin) return
    const generation = ++reviewGenerationRef.current
    setReviewLoading(true)
    setReviewError(null)
    try {
      const response = await apiGetMarketplaceAdminSubmissions(
        reviewStatus,
        reviewPage,
        REVIEW_PAGE_SIZE,
      )
      if (generation === reviewGenerationRef.current) {
        const lastPage = Math.max(1, response.totalPages)
        if (reviewPage > lastPage) {
          setReviewPage(lastPage)
          return
        }
        setReviewItems(response.items)
        setReviewTotal(response.total)
        setReviewTotalPages(response.totalPages)
      }
    } catch (error: unknown) {
      if (generation === reviewGenerationRef.current) setReviewError(messageOf(error))
    } finally {
      if (generation === reviewGenerationRef.current) setReviewLoading(false)
    }
  }, [isMarketplaceAdmin, reviewPage, reviewStatus])

  useEffect(() => {
    if (mode !== 'review') return
    void loadReviewQueue()
    return () => { reviewGenerationRef.current += 1 }
  }, [loadReviewQueue, mode])

  const openReviewDetail = async (submissionId: string): Promise<void> => {
    const generation = ++reviewDetailGenerationRef.current
    setReviewDetailId(submissionId)
    setReviewDetail(null)
    setReviewPackage(null)
    setSelectedReviewFilePath(null)
    setReviewPackageChecked(false)
    setReviewDetailError(null)
    setReviewDetailLoading(true)
    try {
      const [detail, packageInspection] = await Promise.all([
        apiGetMarketplaceAdminSubmission(submissionId),
        apiGetMarketplacePackageInspection(submissionId),
      ])
      if (
        packageInspection.submissionId !== detail.id
        || packageInspection.versionId !== detail.version.id
        || (detail.version.packageSha256
          && detail.version.packageSha256 !== packageInspection.packageSha256)
        || (detail.version.packageSize !== null
          && detail.version.packageSize !== undefined
          && detail.version.packageSize !== packageInspection.packageSize)
      ) {
        throw new Error('固定版本安装包与审核提交不一致')
      }
      if (generation === reviewDetailGenerationRef.current) {
        setReviewDetail(detail)
        setReviewPackage(packageInspection)
        setSelectedReviewFilePath(
          packageInspection.files.find((file) => file.path === 'SKILL.md')?.path
          ?? packageInspection.files.find((file) => file.kind === 'text')?.path
          ?? packageInspection.files[0]?.path
          ?? null,
        )
      }
    } catch (error: unknown) {
      if (generation === reviewDetailGenerationRef.current) setReviewDetailError(messageOf(error))
    } finally {
      if (generation === reviewDetailGenerationRef.current) setReviewDetailLoading(false)
    }
  }

  const closeReviewDetail = (): void => {
    reviewDetailGenerationRef.current += 1
    setReviewDetailId(null)
    setReviewDetail(null)
    setReviewPackage(null)
    setSelectedReviewFilePath(null)
    setReviewPackageChecked(false)
    setReviewDetailError(null)
    setReviewDetailLoading(false)
  }

  const openMarketplaceSkill = async (skill: LocalSkill, action?: 'install' | 'discuss' | `install:${string}`): Promise<void> => {
    if (!skill.serverId || openingSkillId) return
    setOpeningSkillId(skill.id)
    try {
      const [detailResult, localResult] = await Promise.allSettled([
        apiGetMarketplaceSkill(skill.serverId),
        getLocalSkills(),
      ])
      if (detailResult.status === 'rejected') throw detailResult.reason
      const detail = detailResult.value
      const localSkills = localResult.status === 'fulfilled'
        ? localResult.value
        : useStore.getState().skills.filter((candidate) => Boolean(candidate.localPath))
      const merged = mergeMarketplaceSkill(
        detail,
        catalogLocals(localSkills).find((candidate) => candidate.serverId === detail.id),
        useStore.getState().currentUser?.id,
      )
      const current = useStore.getState().marketplaceSkills
      setMarketplaceSkills(current.some((candidate) => candidate.serverId === detail.id)
        ? current.map((candidate) => candidate.serverId === detail.id ? merged : candidate)
        : [...current, merged])
      openSkillSheet(merged.id, 'profile', action)
    } catch (error: unknown) {
      toast(`无法打开这个 Skill：${messageOf(error)}`, 'error')
    } finally {
      setOpeningSkillId(null)
    }
  }

  useEffect(() => {
    if (!pendingMarketplaceIntent) return
    if (mode !== 'catalog') { setMode('catalog'); return }
    const intent = pendingMarketplaceIntent
    let active = true
    void Promise.all([apiGetMarketplaceSkill(intent.listingId), getLocalSkills()])
      .then(async ([detail, localSkills]) => {
        if (!active) return
        const merged = {
          ...mergeMarketplaceSkill(
            detail,
            catalogLocals(localSkills).find((candidate) => candidate.serverId === detail.id),
            useStore.getState().currentUser?.id,
          ),
          marketplaceInstallIntentId: intent.intentId,
        }
        const current = useStore.getState().marketplaceSkills
        setMarketplaceSkills(current.some((candidate) => candidate.serverId === detail.id)
          ? current.map((candidate) => candidate.serverId === detail.id ? merged : candidate)
          : [...current, merged])
        if (intent.action === 'install') await joinMySkills(merged)
        else openSkillSheet(merged.id, 'profile', intent.action)
      })
      .catch((error: unknown) => {
        if (active) toast(`无法打开这个 Skill：${messageOf(error)}`, 'error')
      })
      .finally(() => { if (active) setPendingMarketplaceIntent(null) })
    return () => { active = false }
  }, [mode, openSkillSheet, pendingMarketplaceIntent, setMarketplaceSkills, setPendingMarketplaceIntent])

  const executeMineAction = async (): Promise<void> => {
    if (!mineAction) return
    const accountGeneration = accountGenerationRef.current
    const action = mineAction
    setMineBusy(true)
    try {
      if (action.kind === 'withdraw') {
        await apiWithdrawMarketplaceSubmission(action.submissionId)
        if (accountGeneration !== accountGenerationRef.current) return
        toast('审核申请已撤回，当前已上架版本不受影响')
      } else {
        await apiUnpublishMarketplaceSkill(action.item.skillId)
        if (accountGeneration !== accountGenerationRef.current) return
        toast('Skill 已从商店下架，本机和资产库内容仍保留')
      }
      setMineAction(null)
      await loadMine()
    } catch (error: unknown) {
      if (accountGeneration !== accountGenerationRef.current) return
      toast(`操作失败：${messageOf(error)}`, 'error')
    } finally {
      if (accountGeneration === accountGenerationRef.current) setMineBusy(false)
    }
  }

  const reviewAction = async (
    item: ApiMarketplaceAdminSubmission,
    action: 'start' | 'approve',
  ): Promise<void> => {
    if (action === 'approve' && (
      !reviewPackage
      || !reviewPackageChecked
      || reviewPackage.submissionId !== item.id
      || reviewPackage.versionId !== item.version.id
    )) {
      toast('请先完整加载并确认当前哈希安装包', 'error')
      return
    }
    const accountGeneration = accountGenerationRef.current
    setReviewBusyId(item.id)
    try {
      if (action === 'start') await apiStartMarketplaceReview(item.id)
      else await apiApproveMarketplaceSubmission(item.id)
      if (accountGeneration !== accountGenerationRef.current) return
      toast(action === 'start' ? '已开始审核' : '审核已通过，商店版本已更新')
      closeReviewDetail()
      await loadReviewQueue()
    } catch (error: unknown) {
      if (accountGeneration !== accountGenerationRef.current) return
      toast(`审核操作失败：${messageOf(error)}`, 'error')
    } finally {
      if (accountGeneration === accountGenerationRef.current) setReviewBusyId(null)
    }
  }

  const rejectSubmission = async (): Promise<void> => {
    if (!rejecting || !rejectReason.trim()) return
    const accountGeneration = accountGenerationRef.current
    const submission = rejecting
    const reason = rejectReason.trim()
    setReviewBusyId(submission.id)
    try {
      await apiRejectMarketplaceSubmission(submission.id, { reason })
      if (accountGeneration !== accountGenerationRef.current) return
      toast('已退回给作者修改')
      setRejecting(null)
      setRejectReason('')
      await loadReviewQueue()
    } catch (error: unknown) {
      if (accountGeneration !== accountGenerationRef.current) return
      toast(`退回失败：${messageOf(error)}`, 'error')
    } finally {
      if (accountGeneration === accountGenerationRef.current) setReviewBusyId(null)
    }
  }

  // 场景分类: the server's enabled categories; until they load, the stable directory list plus
  // any category seen on home or in results. The selected value always stays selectable.
  const categoryOptions = useMemo(() => {
    const fallback = [
      ...MARKETPLACE_DIRECTORIES.filter((directory) => directory.value !== '全部').map((directory) => directory.value),
      ...knownCategories,
    ]
    const names = catalogCategories.length > 0 ? catalogCategories : fallback
    return Array.from(new Set([...names, ...(catalog.category ? [catalog.category] : [])]))
  }, [catalogCategories, knownCategories, catalog.category])
  // Agents come from AGENT_DEFINITIONS for this platform (agentCapabilities); never a guessed list.
  const marketplaceAgentKeys = useMemo(
    () => Array.from(new Set(agentCapabilities.map((agent) => agent.key))),
    [agentCapabilities],
  )
  const catalogFilters = useMemo<StoreFilterDef[]>(() => {
    const agentKeys = [...marketplaceAgentKeys, ...(catalog.agent && !marketplaceAgentKeys.includes(catalog.agent) ? [catalog.agent] : [])]
    const filters: StoreFilterDef[] = [
      { id: 'category', label: '场景分类', value: catalog.category, options: [{ value: '', label: '所有场景分类' }, ...categoryOptions.map((name) => ({ value: name, label: name }))] },
      { id: 'agent', label: 'Agent', value: catalog.agent, options: [{ value: '', label: '所有 Agent' }, ...agentKeys.map((key) => ({ value: key, label: agentDisplayName(key) }))] },
    ]
    if (capabilities.apiKey) filters.push({ id: 'apiKey', label: 'API Key', value: catalog.apiKey, options: API_KEY_OPTIONS })
    return filters
  }, [capabilities.apiKey, catalog.agent, catalog.apiKey, catalog.category, categoryOptions, marketplaceAgentKeys])
  const onCatalogFilterChange = (id: string, value: string): void => {
    if (id === 'category') updateCatalog({ category: value })
    else if (id === 'agent') updateCatalog({ agent: value })
    else if (id === 'apiKey') updateCatalog({ apiKey: value === 'none' || value === 'required' ? value : '' })
  }
  const activeCatalogChips = [
    catalog.featured && { key: 'featured', text: '仅看精选', clear: () => updateCatalog({ featured: false }) },
    catalog.query && { key: 'query', text: `搜索：${catalog.query}`, clear: () => { setSearchInput(''); updateCatalog({ query: '' }) } },
    catalog.category && { key: 'category', text: catalog.category, clear: () => updateCatalog({ category: '' }) },
    catalog.agent && { key: 'agent', text: agentDisplayName(catalog.agent), clear: () => updateCatalog({ agent: '' }) },
    catalog.apiKey && { key: 'apiKey', text: API_KEY_OPTIONS.find((option) => option.value === catalog.apiKey)?.label ?? 'API Key', clear: () => updateCatalog({ apiKey: '' }) },
  ].filter((chip): chip is { key: string; text: string; clear: () => void } => Boolean(chip))
  const catalogHeading = catalog.featured ? '精选 Skills' : '全部技能'
  const selectedReviewFile = reviewPackage?.files.find(
    (file) => file.path === selectedReviewFilePath,
  ) ?? null
  const visibleReviewCompatibleAgents = reviewDetail?.snapshot.compatibleAgents
    .filter((agent) => marketplaceAgentKeys.includes(agent)) ?? []

  const homeTopics = home?.topics.slice(0, 24) ?? []
  const homeCategories = home?.categories ?? []
  const openStoreSkill = (skill: LocalSkill): void => { void openMarketplaceSkill(skill) }
  const installStoreSkill = (skill: LocalSkill): void => { void joinMySkills(skill) }
  const storeItemProps = (skill: LocalSkill) => {
    const live = withLiveRuntime(skill)
    return { skill: live, busy: openingSkillId === skill.id, onOpen: () => openStoreSkill(live), onInstall: () => installStoreSkill(live) }
  }
  // Topic detail: hero → article (body + embedded store cards) when the Server sends a body;
  // the old 简介 + list layout for an old Server, and with a 重试 notice when the body could not be read.
  const topicPage = (topic: ApiMarketplaceTopic) => {
    const article = topicArticleOf(topic)
    const skills = topicSkills.map(withLiveRuntime)
    const updated = formatStoreDate(topic.updatedAt ?? topic.publishedAt)
    const legacy = <>
      {topic.introContent && <p className="marketplace-topic-intro">{topic.introContent}</p>}
      <div className="marketplace-section-tools"><span>{topicSkills.length} 个 Skill</span></div>
      {topicSkills.length > 0 ? renderCatalogSkills(topicSkills, 'topic') : <EmptyState copy={EMPTY_COPY.storeTopicNone} icon="box" compact className="marketplace-empty"><button type="button" className="btn btn-ghost btn-sm" onClick={closeTopic}>返回首页</button></EmptyState>}
    </>
    return <section className="marketplace-topic-page" aria-label={`${topic.title}专题`} data-topic-layout={article ? 'article' : topicLoad === 'loading' ? 'loading' : 'legacy'}>
      <button type="button" className="btn btn-ghost btn-sm marketplace-topic-back" onClick={closeTopic}><Icon name="left" size={12} />返回首页</button>
      <div className="marketplace-topic-hero"><span className="marketplace-topic-art" aria-hidden="true" /><div className="marketplace-topic-hero-content">
        <span className="marketplace-topic-kicker">精选专题</span>
        <h2>{topic.title}</h2>{topic.description && <p className="marketplace-topic-lead">{topic.description}</p>}
        <span className="marketplace-topic-count">{topicSkills.length} 个 Skill{updated && ` · 更新于 ${updated}`}</span>
      </div></div>
      {article
        ? <TopicArticleBody article={article} skills={topicSkillMap(skills)} busyId={openingSkillId}
          onOpen={(skill) => void openMarketplaceSkill(skill)} onInstall={(skill) => void joinMySkills(skill)} onLink={openTopicLink}
          installAll={topicInstall} onInstallAll={() => void installTopicSkills(articleSkills(article, topicSkillMap(skills)))} />
        : topicLoad === 'loading'
          ? <SkeletonBlock layout="text" className="tsh-article-loading" label={LOADING_COPY.topicArticle} />
          : <>
            {topicLoad === 'failed' && <p className="tsh-article-error" role="alert">{loadFailedMessage('专题正文')}，先显示 Skill 列表。<button type="button" className="tsh-btn tsh-btn-sm" onClick={() => void openTopic(topic, true)}>{RETRY_LABEL}</button></p>}
            {legacy}
          </>}
    </section>
  }

  const switchTab = (next: MarketplaceMode): void => {
    topicGeneration.current += 1
    setSelectedTopic(null)
    setTopicSkills([])
    // The 全部技能 tab itself never carries the 精选 preset; other filters are kept.
    if (next === 'catalog') updateCatalog({ featured: false })
    setMode(next)
  }

  // 首页 sections, in order: search → 商店动态 → 精选专题 → 精选 Skills + 飙升榜 → 按场景浏览 → 最近上新.
  // No download-client banner on desktop.
  const storeHome = <div className="tsh-home" aria-label="Skill 商店首页">
    <section className={storeStats ? 'tsh-hero' : 'tsh-hero is-single'} data-store-section="search" aria-label="搜索 Skill">
      <div>
        <h2>找到会干活的 <em>AI Skill</em></h2>
        <p>{storeStats ? `${formatStoreCount(storeStats.totalSkills)} 个经过审核的 Skill，` : '经过审核的专家 Skill，'}一键安装到你常用的 Agent，让 AI 从通用走向专用。</p>
        <StoreSearchBar value={homeQuery} onChange={setHomeQuery} onSubmit={(value) => openCatalog({ query: value })} suggestions={homeSuggestions} />
      </div>
      {storeStats && <aside className="tsh-panel" data-store-section="stats" aria-label="商店动态">
        <div className="tsh-panel-head"><h3 className="tsh-panel-title">商店动态</h3></div>
        <div className="tsh-stats">{statTiles(storeStats).map((tile) => <StatTile key={tile.label} {...tile} />)}</div>
      </aside>}
    </section>

    {homeError && <section className="tsh-section tsh-home-error" role="alert">{loadFailedMessage('商店首页', homeError)}<button type="button" className="tsh-chip" onClick={() => void loadHome()}>{RETRY_LABEL}</button></section>}

    {homeTopics.length > 0 && <section className="tsh-section" data-store-section="topics" aria-labelledby="store-home-topics">
      <StoreCarousel label="精选专题列表" head={<h2 className="tsh-section-title" id="store-home-topics">精选专题<span className="tsh-section-sub">编辑挑选的 Skill 组合</span></h2>}>
        {homeTopics.map((topic, index) => <TopicCard key={topic.id || topic.slug} topic={topic} tone={topicTone(index)} kicker={index === 0 ? '编辑推荐' : topicKicker(topic)} onOpen={() => void openTopic(topic)} />)}
      </StoreCarousel>
    </section>}

    <section className={rankingFailed ? 'tsh-section' : 'tsh-section tsh-split'} data-store-section="featured">
      <div>
        <SectionHead title="精选 Skills" more="查看全部" onMore={() => openCatalog({ featured: true, sort: 'popular' })} />
        {homeFeaturedError
          ? <p className="tsh-home-error" role="alert">{loadFailedMessage('精选 Skills ')}<button type="button" className="tsh-chip" onClick={() => void loadHome()}>{RETRY_LABEL}</button></p>
          : <div className="tsh-grid" aria-busy={homeFeatured === null}>{homeFeatured === null
            ? Array.from({ length: FEATURED_HOME_SIZE }, (_, index) => <StoreSkeleton key={index} variant="card" />)
            : homeFeatured.map((skill) => <StoreSkillCard key={skill.id} {...storeItemProps(skill)} />)}</div>}
        {homeFeatured !== null && homeFeatured.length === 0 && !homeFeaturedError && <p className="tsh-muted">暂时没有精选 Skill，可以去全部技能看看。</p>}
      </div>
      {!rankingFailed && <div data-store-section="ranking">
        <SectionHead title={ranking?.mode === 'popular' ? '大家在装' : '热门趋势'} more="查看全部" onMore={() => openCatalog({ sort: rankingPresetSort(ranking?.mode, capabilities) })} />
        <TrendingList title={ranking?.mode === 'popular' ? '热门榜' : '飙升榜'} items={ranking?.items.map((item) => ({ ...item, skill: withLiveRuntime(item.skill) })) ?? []} loading={rankingLoading}
          ranges={ranking?.mode === 'trending' ? RANKING_RANGES : undefined} range={rankingRange} onRangeChange={(id) => setRankingRange(id === 'week' ? 'week' : 'day')} onOpen={openStoreSkill} />
      </div>}
    </section>

    {homeCategories.length > 0 && <section className="tsh-section" data-store-section="categories" aria-labelledby="store-home-categories">
      <SectionHead id="store-home-categories" title="按场景浏览" more="全部技能" onMore={() => openCatalog({})} />
      <div className="tsh-cats">{homeCategories.map((category) => <button key={category.id || category.name} type="button" className="tsh-cat" onClick={() => openCatalog({ category: category.name })}>
        {category.name}{categoryCounts[category.name] !== undefined && <small className="tsh-num">{formatStoreCount(categoryCounts[category.name])}</small>}
      </button>)}</div>
    </section>}

    {(homeLatest.length > 0 || (!home && !homeError)) && <section className="tsh-section" data-store-section="latest" aria-labelledby="store-home-latest">
      <SectionHead id="store-home-latest" title="最近上新" more="更多" onMore={() => openCatalog({ sort: 'latest' })} />
      <div className="tsh-list" aria-busy={!home}>{home
        ? homeLatest.map((skill) => <StoreSkillRow key={skill.id} {...storeItemProps(skill)} />)
        : Array.from({ length: 3 }, (_, index) => <StoreSkeleton key={index} variant="row" />)}</div>
    </section>}
  </div>

  return <>
    {updateTarget && <ConfirmModal title={`更新「${updateTarget.displayName}」？`} description={`从 ${updateTarget.marketplaceLocalVersion} 更新到 ${updateTarget.version}。现有内容会完整备份，可在设置回收站恢复。已有 Agent 安装与配置保留。`} confirmLabel="备份并更新" busy={Boolean(openingSkillId)} onCancel={() => setUpdateTarget(null)} onConfirm={() => void joinMySkills(updateTarget, true)} />}
    <PageHeading
      title="Skill 商店"
      subtitle="发现并安装公开发布的 Agent Skill"
      className="marketplace-title-row"
      headRef={pageHeadRef}
      actions={<>
        <BlankDragSpacer />
        <div className="seg-ctrl marketplace-mode-tabs" role="tablist" aria-label="Skill 商店视图">
          {storeTabs({ signedIn: Boolean(currentUser), admin: isMarketplaceAdmin }).map((tab) => <button key={tab.id} type="button" role="tab" aria-selected={mode === tab.id} className={mode === tab.id ? 'active' : ''} onClick={() => switchTab(tab.id)}>{tab.label}</button>)}
        </div>
      </>}
    />

    <div className="page-body marketplace-page-body marketplace-page">
      {offlineAt && <div className="banner" role="status">{catalogOfflineMessage(offlineAt)}；{CATALOG_INSTALL_OFFLINE}</div>}
      {mode === 'home' && (selectedTopic ? topicPage(selectedTopic) : storeHome)}

      {mode === 'catalog' && <>
        <div className="tsh-home tsh-catalog">
          <div className="tsh-listhead">
            <h2>{catalogHeading}</h2>
            <p aria-live="polite">按场景、Agent 与热度找到合适的 Skill{total !== null && <> · 共 <span className="tsh-num">{formatStoreCount(total)}</span> 个</>}</p>
          </div>
          <nav className="tsh-sticky" aria-label="Skill 商店目录" style={{ top: pageHeadHeight }}>
            <StoreFilterBar sorts={visibleSorts(capabilities)} sort={catalog.sort} onSortChange={(id) => updateCatalog({ sort: CATALOG_SORTS.find((sort) => sort.id === id)?.id ?? DEFAULT_CATALOG_SORT })}
              filters={catalogFilters} onFilterChange={onCatalogFilterChange} view={catalogView} onViewChange={changeCatalogView} />
            <label className="tsh-search tsh-searchrow"><StoreIcon name="search" size={18} /><input type="search" aria-label="搜索 Skill 商店" placeholder="搜索技能名称、描述或关键词…" value={searchInput} onChange={(event) => setSearchInput(event.target.value)} />{searchInput && <button type="button" className="tsh-iconbtn tsh-search-clear" aria-label="清空搜索" onClick={() => setSearchInput('')}><StoreIcon name="x" size={16} /></button>}</label>
          </nav>
          {activeCatalogChips.length > 0 && <div className="tsh-active-filters">
            {activeCatalogChips.map((chip) => <button key={chip.key} type="button" className="tsh-chip" aria-label={`清除筛选：${chip.text}`} onClick={chip.clear}>{chip.text}<StoreIcon name="x" size={13} /></button>)}
          </div>}
          <StoreFeed<LocalSkill> key={`${catalogKey}:${catalogRefresh}`} resetKey={`${catalogKey}:${catalogRefresh}`} fetchPage={fetchCatalogPage} keyOf={(skill) => skill.id} view={catalogView}
            renderItem={(skill, view) => view === 'card' ? <StoreSkillCard {...storeItemProps(skill)} /> : <StoreSkillRow {...storeItemProps(skill)} />}
            onSnapshot={(snapshot) => { if (snapshot.total !== null) setTotal(snapshot.total) }}
            onClearFilters={activeCatalogChips.length > 0 ? clearCatalogFilters : undefined} />
        </div>
      </>}

      {mode === 'mine' && privilegedStateIsCurrent && currentUser && <section className="marketplace-account-panel" aria-label="我的 Marketplace 提交">
        <div className="section-head marketplace-results-head"><div><h2>我的提交</h2><p>审核申请与当前上架版本会分别显示，互不覆盖</p></div><button type="button" className="btn btn-ghost btn-sm" disabled={mineLoading} onClick={() => void loadMine()}><Icon name="refresh" size={12} />刷新</button></div>
        {mineError && <LoadError message={loadFailedMessage('我的提交', mineError)} retrying={mineLoading} onRetry={() => void loadMine()} />}
        {mineLoading && mineItems.length === 0 ? <SkeletonBlock layout="rows" count={3} label={LOADING_COPY.storeMine} /> : mineItems.length === 0 ? <EmptyState copy={EMPTY_COPY.storeMineNone} icon="send" className="marketplace-empty"><button type="button" className="btn btn-primary" onClick={() => setView('skills')}>前往我的 Skills</button></EmptyState> : <div className="marketplace-submission-list">{mineItems.map((item) => {
          const submission = item.latestSubmission
          const canWithdraw = submission?.status === 'submitted' || submission?.status === 'under_review'
          const unpublished = !item.listing && submission?.status === 'approved'
          const title = skillListText(item.skill, skillTitlePreference)
          return <article className="marketplace-submission-row" key={item.skillId}><div className="marketplace-submission-main">{title.secondary && <span className={`marketplace-submission-kicker${skillTitlePreference === 'ai-title' ? ' mono' : ''}`}>{title.secondary}</span>}<h3 className={skillTitlePreference === 'skill-name' ? 'skill-primary-name' : undefined}>{title.primary}</h3><div className="marketplace-submission-states">{item.listing ? <span className="chip chip-ok">已上架 {item.listing.version}</span> : <span className="chip">{unpublished ? '已下架' : '未上架'}</span>}{submission && <SubmissionStatus status={submission.status} />}</div>{submission?.reviewNote && <p className={submission.status === 'rejected' ? 'review-note rejected' : 'review-note'}>{submission.reviewNote}</p>}</div><div className="marketplace-submission-meta"><span>当前版本 <b className="mono">{item.skill.currentVersion}</b></span>{submission && <span>提交于 {formatDate(submission.submittedAt)}</span>}{item.listing && <span>{item.listing.downloadCount.toLocaleString()} 次下载</span>}</div><div className="marketplace-submission-actions">{canWithdraw && submission && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setMineAction({ kind: 'withdraw', item, submissionId: submission.id })}>撤回申请</button>}{item.listing && <button type="button" className="btn btn-danger-soft btn-sm" onClick={() => setMineAction({ kind: 'unpublish', item })}>下架</button>}</div></article>
        })}</div>}
      </section>}

      {mode === 'review' && privilegedStateIsCurrent && isMarketplaceAdmin && <section className="marketplace-account-panel" aria-label="Marketplace 审核队列">
        <div className="section-head marketplace-results-head"><div><h2>审核队列</h2><p>审核固定版本快照，通过后才会切换商店中的公开版本</p></div><span className="count">{reviewTotal}</span><button type="button" className="btn btn-ghost btn-sm" disabled={reviewLoading} onClick={() => void loadReviewQueue()}><Icon name="refresh" size={12} />刷新</button></div>
        <div className="category-scroll marketplace-review-filters" role="tablist" aria-label="审核状态">{REVIEW_STATUSES.map((status) => <button type="button" role="tab" aria-selected={reviewStatus === status} key={status} className={`filter-btn${reviewStatus === status ? ' active' : ''}`} onClick={() => { setReviewPage(1); setReviewStatus(status) }}>{STATUS_LABELS[status]}</button>)}</div>
        {reviewError && <LoadError message={loadFailedMessage('审核队列', reviewError)} retrying={reviewLoading} onRetry={() => void loadReviewQueue()} />}
        {reviewLoading && reviewItems.length === 0 ? <SkeletonBlock layout="rows" count={3} label={LOADING_COPY.storeReview} /> : reviewItems.length === 0 ? <EmptyState copy={EMPTY_COPY.storeReviewNone} icon="check" compact className="marketplace-empty" /> : <div className="marketplace-review-list">{reviewItems.map((item) => {
          const title = skillListText(item.skill, skillTitlePreference)
          return <article className="marketplace-review-row" key={item.id}><div className="marketplace-review-copy"><div><SubmissionStatus status={item.status} /><span className="mono">{item.version.version}</span></div><h3 className={skillTitlePreference === 'skill-name' ? 'skill-primary-name' : undefined}>{title.primary}</h3><p>{title.secondary ?? item.skill.description}</p><span>作者 {item.author.displayName} · 提交于 {formatDate(item.submittedAt)}</span>{item.reviewNote && <p className="review-note">{item.reviewNote}</p>}</div><div className="marketplace-review-actions"><button type="button" className="btn btn-primary btn-sm" disabled={reviewDetailLoading && reviewDetailId === item.id} onClick={() => void openReviewDetail(item.id)}><Icon name="doc" size={12} />{reviewDetailLoading && reviewDetailId === item.id ? '读取中…' : '查看内容'}</button></div></article>
        })}</div>}
        {reviewTotalPages > 1 && <nav className="marketplace-pagination" aria-label="审核队列分页"><button type="button" className="btn btn-ghost btn-sm" disabled={reviewPage <= 1 || reviewLoading} onClick={() => setReviewPage((value) => Math.max(1, value - 1))}><Icon name="left" size={12} />上一页</button><span>第 {reviewPage} / {reviewTotalPages} 页</span><button type="button" className="btn btn-ghost btn-sm" disabled={reviewPage >= reviewTotalPages || reviewLoading} onClick={() => setReviewPage((value) => Math.min(reviewTotalPages, value + 1))}>下一页<Icon name="left" size={12} className="marketplace-next-icon" /></button></nav>}
      </section>}
    </div>

    {mineAction && privilegedStateIsCurrent && currentUser && <ConfirmModal eyebrow={mineAction.kind === 'withdraw' ? '撤回审核申请' : '下架 Skill'} title={mineAction.kind === 'withdraw' ? `撤回「${mineAction.item.skill.displayName}」的审核申请？` : `将「${mineAction.item.skill.displayName}」从商店下架？`} description={mineAction.kind === 'withdraw' ? '只撤回最新审核申请。若已有旧版本上架，它会继续公开并可下载。' : '商店将停止公开下载，本机资产、版本历史和团队共享都不会被删除。'} confirmLabel={mineAction.kind === 'withdraw' ? '确认撤回' : '确认下架'} destructive={mineAction.kind === 'unpublish'} busy={mineBusy} onCancel={() => setMineAction(null)} onConfirm={() => void executeMineAction()} />}

    {reviewDetailId && privilegedStateIsCurrent && isMarketplaceAdmin && <FocusTrapDialog className="modal-layer" label="查看 Marketplace 固定版本" onEscape={() => !reviewBusyId && closeReviewDetail()} escapeDisabled={Boolean(reviewBusyId)}><div className="modal-card marketplace-review-detail"><div className="modal-head"><div><span className="eyebrow">Marketplace 固定版本审核</span><h2>{reviewDetail?.snapshot.displayName ?? '正在读取提交内容'}</h2></div><button type="button" className="ico-btn" disabled={Boolean(reviewBusyId)} aria-label="关闭审核内容" onClick={closeReviewDetail}><Icon name="x" size={16} /></button></div>
      {reviewDetailLoading && <SkeletonBlock layout="detail" label={LOADING_COPY.storeReviewDetail} />}
      {reviewDetailError && <LoadError message={loadFailedMessage('审核内容', reviewDetailError)} retrying={reviewDetailLoading} onRetry={() => void openReviewDetail(reviewDetailId)} />}
      {reviewDetail && reviewPackage && <div className="marketplace-review-detail-body">
        <div className="marketplace-review-detail-meta"><SubmissionStatus status={reviewDetail.status} /><span className="mono">{reviewDetail.version.version}</span><span><Icon name="user" size={12} />{reviewDetail.author.displayName}</span><span>提交于 {formatDate(reviewDetail.submittedAt)}</span></div>
        <section className="marketplace-review-note"><h3>作者备注</h3><p>{reviewDetail.submitterNote || '作者未填写提交备注。'}</p></section>
        <section className="marketplace-review-profile"><div className="marketplace-review-section-head"><div><h3>公开 Profile</h3><p>审核通过后，以下固定内容会显示在 Skill 商店。</p></div><span className="chip">{reviewDetail.snapshot.category || '其他'}</span></div><p className="marketplace-review-description">{reviewDetail.snapshot.description || '未填写简介'}</p><dl><div><dt>名称</dt><dd>{reviewDetail.snapshot.name}</dd></div><div><dt>标签</dt><dd>{reviewDetail.snapshot.labels.length > 0 ? reviewDetail.snapshot.labels.join('、') : '无'}</dd></div><div><dt>什么时候会用</dt><dd>{reviewDetail.snapshot.triggerScenarios.length > 0 ? reviewDetail.snapshot.triggerScenarios.join('；') : '未填写'}</dd></div><div><dt>兼容 Agent</dt><dd>{visibleReviewCompatibleAgents.length > 0 ? visibleReviewCompatibleAgents.map(agentDisplayName).join('、') : '未声明'}</dd></div></dl></section>
        <section className="marketplace-review-env"><div className="marketplace-review-section-head"><div><h3>Skill 配置名</h3><p>只审核变量名和用途，不展示任何凭据值。</p></div><span className="count">{reviewDetail.snapshot.envDependencies.length}</span></div>{reviewDetail.snapshot.envDependencies.length === 0 ? <p className="marketplace-review-muted">这个版本不声明Skill 配置。</p> : <ul>{reviewDetail.snapshot.envDependencies.map((dependency) => <li key={dependency.key}><code>{dependency.key}</code><span>{dependency.description || '未填写用途'}</span><i>{dependency.required ? '必需' : '可选'}</i></li>)}</ul>}</section>
        <section className="marketplace-review-package">
          <div className="marketplace-review-section-head"><div><h3>固定安装包</h3><p>下列文件来自提交时锁定的版本，二进制只显示路径和大小。</p></div><span className="chip">{reviewPackage.files.length} 个路径</span></div>
          <dl className="marketplace-review-integrity"><div><dt>版本</dt><dd className="mono">{reviewPackage.version}</dd></div><div><dt>ZIP 大小</dt><dd>{formatBytes(reviewPackage.packageSize)}</dd></div><div className="hash"><dt>SHA-256</dt><dd className="mono">{reviewPackage.packageSha256}</dd></div></dl>
          <div className="marketplace-review-workbench">
            <ul className="marketplace-review-file-tree" aria-label="固定安装包文件树">{reviewPackage.files.map((file) => <li key={file.path}><button type="button" className={selectedReviewFilePath === file.path ? 'active' : ''} onClick={() => setSelectedReviewFilePath(file.path)}><Icon name={file.kind === 'directory' ? 'folder' : 'doc'} size={12} /><span>{file.path}</span><i>{file.kind === 'directory' ? '目录' : file.kind === 'binary' ? `二进制 · ${formatBytes(file.size)}` : formatBytes(file.size)}</i></button></li>)}</ul>
            <div className="marketplace-review-file-preview">{!selectedReviewFile ? <p>选择一个文件查看。</p> : selectedReviewFile.kind === 'text' ? <><div><span className="mono">{selectedReviewFile.path}</span><button type="button" className="link-button" onClick={() => void navigator.clipboard.writeText(selectedReviewFile.content ?? '').then(() => toast('文件内容已复制')).catch((error: unknown) => toast(messageOf(error), 'error'))}>复制</button></div><pre>{selectedReviewFile.content}</pre></> : <div className="marketplace-review-no-preview"><Icon name={selectedReviewFile.kind === 'directory' ? 'folder' : 'doc'} size={18} /><strong>{selectedReviewFile.kind === 'directory' ? '这是一个目录' : '二进制文件不回传内容'}</strong><span>{selectedReviewFile.path}</span></div>}</div>
          </div>
        </section>
        <section className="marketplace-review-source"><div className="marketplace-review-section-head"><div><h3>公开 SKILL.md 快照</h3><p>用于核对商店 Profile 与安装包内容是否一致。</p></div><button type="button" className="btn btn-ghost btn-sm" onClick={() => void navigator.clipboard.writeText(reviewDetail.snapshot.skillMd).then(() => toast('SKILL.md 已复制')).catch((error: unknown) => toast(messageOf(error), 'error'))}><Icon name="doc" size={12} />复制</button></div><pre>{reviewDetail.snapshot.skillMd}</pre></section>
        {reviewDetail.status === 'under_review' && <label className="marketplace-review-confirm"><input type="checkbox" checked={reviewPackageChecked} onChange={(event) => setReviewPackageChecked(event.target.checked)} /><span>我已检查 SHA-256 为 <b className="mono">{reviewPackage.packageSha256}</b> 的固定安装包及全部可读文件。</span></label>}
      </div>}
      <div className="modal-actions marketplace-review-detail-actions"><button type="button" className="btn btn-ghost" disabled={Boolean(reviewBusyId)} onClick={closeReviewDetail}>关闭</button>{reviewDetail?.status === 'submitted' && <button type="button" className="btn btn-primary" disabled={Boolean(reviewBusyId) || !reviewPackage} onClick={() => void reviewAction(reviewDetail, 'start')}>{reviewBusyId ? '处理中…' : '开始审核'}</button>}{reviewDetail?.status === 'under_review' && <><button type="button" className="btn btn-danger-soft" disabled={Boolean(reviewBusyId)} onClick={() => { setRejecting(reviewDetail); setRejectReason(''); closeReviewDetail() }}>退回修改</button><button type="button" className="btn btn-primary" disabled={Boolean(reviewBusyId) || !reviewPackage || !reviewPackageChecked} onClick={() => void reviewAction(reviewDetail, 'approve')}>{reviewBusyId ? '处理中…' : '通过并上架'}</button></>}</div>
    </div></FocusTrapDialog>}

    {rejecting && privilegedStateIsCurrent && isMarketplaceAdmin && <FocusTrapDialog className="modal-layer" label="退回 Marketplace 提交" onEscape={() => !reviewBusyId && setRejecting(null)} escapeDisabled={Boolean(reviewBusyId)}><div className="modal-card compact"><div className="modal-head"><div><span className="eyebrow">Marketplace 审核</span><h2>退回给作者修改</h2></div><button type="button" className="ico-btn" disabled={Boolean(reviewBusyId)} aria-label="关闭退回对话框" onClick={() => setRejecting(null)}><Icon name="x" size={16} /></button></div><p className="modal-copy">请说明未通过原因。作者会在“我的提交”和 Skill 共享区看到这段内容。</p><div className="form-stack"><label>审核意见<textarea autoFocus rows={4} maxLength={500} value={rejectReason} onChange={(event) => setRejectReason(event.target.value)} placeholder="例如：请补充支持的 Agent 和安装说明" /></label></div><div className="modal-actions"><button type="button" className="btn btn-ghost" disabled={Boolean(reviewBusyId)} onClick={() => setRejecting(null)}>取消</button><button type="button" className="btn btn-danger" disabled={Boolean(reviewBusyId) || !rejectReason.trim()} onClick={() => void rejectSubmission()}>{reviewBusyId ? '正在退回…' : '确认退回'}</button></div></div></FocusTrapDialog>}
  </>
}
import { useSpaceCapabilities } from '../lib/use-space-capabilities.js'
