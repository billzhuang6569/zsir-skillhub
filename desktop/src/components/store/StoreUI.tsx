import { useCatalogOffline } from '../../lib/use-catalog-offline.js'
import { CATALOG_INSTALL_OFFLINE } from '../../lib/catalog-cache.js'
// Store-only components for the desktop Skill store, built to the Tan Skillhub
// Design System specs (SkillAvatar / StoreBadges / Tag / SkillCard / SkillRow /
// StatTile / TrendingList / TopicCard / TopicCarousel / SearchBar). They mirror
// the shipped web store (landing-page/src/marketplace/ui/skill.tsx) but act on the
// desktop's merged LocalSkill, and the primary 安装 button goes straight into the
// existing desktop join/update flow passed in by the page.
import { Children, useEffect, useRef, useState, type ReactNode } from 'react'
import { Icon, type IconName } from '../Icon.js'
import { SkillAvatarIcon } from '../SkillAvatarIcon.js'
import { Skeleton } from '../StateViews.js'
import { marketplaceAction } from '../../lib/marketplace-state.js'
import { skillListText } from '../../lib/skill-title.js'
import {
  STORE_BADGE_VIEW, carouselEdges, formatStoreCount, needsApiKey, runInstallClick, storeInstallState,
  type RankedItem, type StatTileData, type TopicTone,
} from '../../lib/store-home.js'
import type { ApiMarketplaceTopic, MarketplaceBadge } from '../../lib/api.js'
import { useStore, type LocalSkill } from '../../store/index.js'
import './StoreUI.css'

const STROKE = 1.75

export function StoreIcon({ name, size = 16 }: { name: IconName; size?: number }) {
  return <Icon name={name} size={size} strokeWidth={STROKE} className="tsh-icon" />
}

export type TagTone = 'neutral' | 'brand' | 'warning' | 'success' | 'outline'

/** 24px pill: category (neutral), a store badge, or 需配置 API Key (warning + key-round). */
export function StoreTag({ tone = 'neutral', icon, children, title }: { tone?: TagTone; icon?: IconName; children: ReactNode; title?: string }) {
  return <span className={`tsh-tag${tone === 'neutral' ? '' : ` tsh-tag-${tone}`}`} title={title}>{icon && <StoreIcon name={icon} size={13} />}{children}</span>
}

/** The four store badges in the server's (normalised) order; each with icon and word, wrapping, never "+N". */
export function StoreBadges({ badges }: { badges?: readonly MarketplaceBadge[] }) {
  if (!badges?.length) return null
  return <span className="tsh-badges" aria-label="商店标签">
    {badges.map((badge) => <StoreTag key={badge} tone={STORE_BADGE_VIEW[badge].tone} icon={STORE_BADGE_VIEW[badge].icon}>{STORE_BADGE_VIEW[badge].label}</StoreTag>)}
  </span>
}

const avatarRadius = (size: number): string => size >= 72 ? 'lg' : size > 36 ? 'md' : 'sm'

/** Server avatar at a design-system size (112 / 52 / 48 / 36 / 32) with a hairline ring. */
export function StoreAvatar({ skill, size }: { skill: Pick<LocalSkill, 'avatarUrl' | 'avatarStatus'>; size: number }) {
  return <SkillAvatarIcon avatarUrl={skill.avatarUrl} status={skill.avatarStatus} size={size} className={`tsh-avatar tsh-avatar-${avatarRadius(size)}`} />
}

function Metric({ icon, title, children }: { icon: IconName; title: string; children: ReactNode }) {
  return <span className="tsh-metric tsh-num" title={title}><StoreIcon name={icon} size={14} /><span className="tsh-sr-only">{title}</span>{children}</span>
}

function useSkillTitle(skill: Pick<LocalSkill, 'name' | 'displayName'>): { primary: string; secondary: string | null } {
  const preference = useStore((state) => state.skillTitlePreference)
  return skillListText(skill, preference)
}

/** 「安装」/「更新」 go into the page's existing join flow; a joined Skill shows 已加入. */
export function StoreInstallButton({ skill, busy, onInstall, title }: { skill: LocalSkill; busy: boolean; onInstall: () => void; title: string }) {
  const offlineAt = useCatalogOffline()
  const state = storeInstallState(marketplaceAction(skill), busy)
  return <button type="button"
    className={`tsh-btn tsh-btn-sm tsh-install is-${state.kind}`}
    disabled={state.disabled || Boolean(offlineAt)} title={offlineAt ? CATALOG_INSTALL_OFFLINE : undefined}
    aria-label={state.kind === 'joined' ? `${title} 已加入我的 Skills` : `${state.label} ${title}`}
    onClick={(event) => runInstallClick(event, onInstall)}>
    <StoreIcon name={state.kind === 'joined' ? 'check' : 'download'} size={14} />{state.label}
  </button>
}

type SkillItemProps = { skill: LocalSkill; busy: boolean; onOpen: () => void; onInstall: () => void }

const uploader = (skill: LocalSkill): string => skill.authorName || 'SkillHub'

/** Card for 精选 Skills: avatar 48, name + subtitle + badges, two-line description, meta, metrics and 安装. */
export function StoreSkillCard({ skill, busy, onOpen, onInstall }: SkillItemProps) {
  const title = useSkillTitle(skill)
  const meta = [skill.category, uploader(skill)].filter(Boolean).join(' · ')
  return <article className={`tsh-card${busy ? ' is-busy' : ''}`}>
    <button type="button" className="tsh-open" aria-label={`查看 ${title.primary} 详情`} disabled={busy} onClick={onOpen} />
    <span className="tsh-card-head">
      <StoreAvatar skill={skill} size={48} />
      <span className="tsh-card-id">
        <span className="tsh-card-name" title={title.primary}>{title.primary}</span>
        {title.secondary && <span className="tsh-skill-subtitle" title={title.secondary}>{title.secondary}</span>}
        <StoreBadges badges={skill.marketplaceBadges} />
      </span>
    </span>
    <span className="tsh-card-desc">{skill.description || '暂无简介'}</span>
    <span className="tsh-card-meta" title={meta}>{meta}{needsApiKey(skill.envDeps) && <StoreTag tone="warning" icon="key-round">需配置 API Key</StoreTag>}</span>
    <span className="tsh-card-foot">
      <Metric icon="download" title="安装次数">{formatStoreCount(skill.installCount)}</Metric>
      <Metric icon="users-round" title="在用用户">{formatStoreCount(skill.marketplaceUserCount)}</Metric>
      <StoreInstallButton skill={skill} busy={busy} onInstall={onInstall} title={title.primary} />
    </span>
  </article>
}

/** Row for 最近上新: avatar 52, name + category + badges + API Key, subtitle, one-line description, metrics, 安装. */
export function StoreSkillRow({ skill, busy, onOpen, onInstall }: SkillItemProps) {
  const title = useSkillTitle(skill)
  return <article className={`tsh-row${busy ? ' is-busy' : ''}`}>
    <button type="button" className="tsh-open" aria-label={`查看 ${title.primary} 详情`} disabled={busy} onClick={onOpen} />
    <StoreAvatar skill={skill} size={52} />
    <span className="tsh-row-main">
      <span className="tsh-row-title">
        <span className="tsh-row-name" title={title.primary}>{title.primary}</span>
        {skill.category && <StoreTag>{skill.category}</StoreTag>}
        <StoreBadges badges={skill.marketplaceBadges} />
        {needsApiKey(skill.envDeps) && <StoreTag tone="warning" icon="key-round">需配置 API Key</StoreTag>}
      </span>
      {title.secondary && <span className="tsh-skill-subtitle tsh-row-sub" title={title.secondary}>{title.secondary}</span>}
      <span className="tsh-row-desc" title={skill.description}>{skill.description || '暂无简介'}</span>
    </span>
    <span className="tsh-row-meta">
      <Metric icon="download" title="安装次数">{formatStoreCount(skill.installCount)}</Metric>
      <Metric icon="users-round" title="在用用户">{formatStoreCount(skill.marketplaceUserCount)}</Metric>
      <span className="tsh-row-source" title={uploader(skill)}>{uploader(skill)}</span>
      <StoreInstallButton skill={skill} busy={busy} onInstall={onInstall} title={title.primary} />
    </span>
  </article>
}

export function StoreSkeleton({ variant }: { variant: 'card' | 'row' }) {
  return <div className={variant === 'card' ? 'tsh-card tsh-skel-card' : 'tsh-row tsh-skel-row'} aria-hidden="true">
    <Skeleton width={variant === 'card' ? 48 : 52} height={variant === 'card' ? 48 : 52} radius={13} />
    <span style={{ flex: 1, minWidth: 0 }}><Skeleton width="60%" height={16} /><Skeleton width="85%" height={13} style={{ marginTop: 10 }} /></span>
  </div>
}

function Sparkline({ values, width = 64, height = 28 }: { values: number[]; width?: number; height?: number }) {
  if (values.length < 2) return null
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  const points = values.map((value, index) => `${(index * width / (values.length - 1)).toFixed(1)},${(height - 2 - (value - min) / span * (height - 4)).toFixed(1)}`).join(' ')
  return <svg className="tsh-spark" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
    <polyline points={points} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
  </svg>
}

/** One 商店动态 metric: label, large tabular number, brand sparkline, optional growth. */
export function StatTile({ label, value, trend, delta }: StatTileData) {
  return <div className="tsh-stat">
    <span className="tsh-stat-label">{label}</span>
    <span className="tsh-stat-row"><span className="tsh-stat-value">{value}</span>{trend && <Sparkline values={trend} />}</span>
    {delta && <span className="tsh-delta"><StoreIcon name="trending-up" size={14} />{delta}</span>}
  </div>
}

export type RankRange = { id: string; label: string }

/** 飙升榜 / 热门榜: rank (top 3 in brand), avatar 36, name, subtitle · category, growth or metric. */
export function TrendingList({ title, items, ranges, range, onRangeChange, loading, onOpen }: {
  title: string
  items: RankedItem<LocalSkill>[]
  ranges?: RankRange[]
  range?: string
  onRangeChange?: (id: string) => void
  loading: boolean
  onOpen: (skill: LocalSkill) => void
}) {
  const preference = useStore((state) => state.skillTitlePreference)
  return <section className="tsh-panel" aria-label={title} aria-busy={loading}>
    <div className="tsh-panel-head">
      <h3 className="tsh-panel-title"><StoreIcon name="flame" size={18} />{title}</h3>
      {ranges && ranges.length > 1 && <div className="tsh-tabs tsh-tabs-sm" role="tablist" aria-label="时间范围">
        {ranges.map((item) => <button key={item.id} type="button" role="tab" className="tsh-tab" aria-selected={range === item.id} onClick={() => onRangeChange?.(item.id)}>{item.label}</button>)}
      </div>}
    </div>
    <ol className="tsh-trend">
      {loading && !items.length
        ? Array.from({ length: 5 }, (_, index) => <li key={index} aria-hidden="true"><Skeleton width={22} height={16} /><Skeleton width={36} height={36} radius={10} /><span className="tsh-trend-main"><Skeleton width="70%" height={14} /></span></li>)
        : items.map((item, index) => {
          const text = skillListText(item.skill, preference)
          return <li key={item.skill.id}>
            <span className={index < 3 ? 'tsh-rank tsh-rank-top' : 'tsh-rank'}>{index + 1}</span>
            <StoreAvatar skill={item.skill} size={36} />
            <span className="tsh-trend-main">
              <button type="button" className="tsh-trend-name" title={text.primary} onClick={() => onOpen(item.skill)}>{text.primary}</button>
              <span className="tsh-trend-cat">{[text.secondary, item.skill.category].filter(Boolean).join(' · ')}</span>
            </span>
            {item.growth
              ? <span className="tsh-delta"><StoreIcon name="trending-up" size={14} /><span className="tsh-sr-only">增长</span>{item.growth}</span>
              : item.metric && <span className="tsh-metric tsh-num">{item.metric}</span>}
          </li>
        })}
    </ol>
  </section>
}

/** 精选专题 card on a logo-palette tile: kicker, title, description, avatar stack and 「N 个 Skill →」. */
export function TopicCard({ topic, tone, kicker, onOpen }: { topic: ApiMarketplaceTopic; tone: TopicTone; kicker?: string; onOpen: () => void }) {
  return <button type="button" className={`tsh-topic tsh-topic-${tone}`} onClick={onOpen}>
    {kicker && <span className="tsh-topic-kicker">{kicker}</span>}
    <span className="tsh-topic-title">{topic.title}</span>
    {topic.description && <span className="tsh-topic-desc">{topic.description}</span>}
    <span className="tsh-topic-foot">
      <span className="tsh-stack">{topic.items.slice(0, 4).map((item) => <SkillAvatarIcon key={item.id} avatarUrl={item.avatarUrl} status={item.avatarStatus} size={36} className="tsh-avatar tsh-avatar-sm" />)}</span>
      <span className="tsh-topic-count">{topic.items.length} 个 Skill<StoreIcon name="arrow-right" size={15} /></span>
    </span>
  </button>
}

/** Sideways row of 1/3-width cards; 上一个 / 下一个 only when it overflows, disabled at each end. */
export function StoreCarousel({ label, head, children }: { label: string; head: ReactNode; children: ReactNode }) {
  const track = useRef<HTMLDivElement>(null)
  const [edges, setEdges] = useState(() => carouselEdges(0, 0, 0))
  const count = Children.count(children)
  useEffect(() => {
    const element = track.current
    if (!element) return
    const update = (): void => setEdges(carouselEdges(element.scrollLeft, element.scrollWidth, element.clientWidth))
    update()
    element.addEventListener('scroll', update, { passive: true })
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update)
    observer?.observe(element)
    return () => { element.removeEventListener('scroll', update); observer?.disconnect() }
  }, [count])
  const scroll = (direction: 1 | -1): void => {
    const element = track.current
    if (!element) return
    const first = element.firstElementChild
    const card = first instanceof HTMLElement ? first.getBoundingClientRect().width : 0
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    element.scrollBy({ left: direction * (card > 0 ? card + 16 : element.clientWidth), behavior: reduceMotion ? 'auto' : 'smooth' })
  }
  return <div className="tsh-carousel">
    <div className="tsh-section-head">
      {head}
      {edges.overflow && <div className="tsh-carousel-nav">
        <button type="button" className="tsh-iconbtn" aria-label="上一个" disabled={edges.atStart} onClick={() => scroll(-1)}><StoreIcon name="left" size={18} /></button>
        <button type="button" className="tsh-iconbtn" aria-label="下一个" disabled={edges.atEnd} onClick={() => scroll(1)}><StoreIcon name="right" size={18} /></button>
      </div>}
    </div>
    <div ref={track} className="tsh-carousel-track" role="region" aria-label={label} tabIndex={0}>{children}</div>
  </div>
}

export function SectionHead({ id, title, sub, more, onMore }: { id?: string; title: string; sub?: string; more?: string; onMore?: () => void }) {
  return <div className="tsh-section-head">
    <h2 className="tsh-section-title" id={id}>{title}{sub && <span className="tsh-section-sub">{sub}</span>}</h2>
    {more && onMore && <button type="button" className="tsh-more" onClick={onMore}>{more}<StoreIcon name="right" size={15} /></button>}
  </div>
}

/** Large hero search: `/` focuses it, 「大家在搜」 chips submit directly. */
export function StoreSearchBar({ value, onChange, onSubmit, suggestions }: { value: string; onChange: (value: string) => void; onSubmit: (value: string) => void; suggestions: string[] }) {
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target
      if (target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) return
      event.preventDefault()
      input.current?.focus()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  return <div>
    <form className="tsh-search tsh-search-lg" role="search" onSubmit={(event) => { event.preventDefault(); onSubmit(value) }}>
      <StoreIcon name="search" size={20} />
      <input ref={input} type="search" aria-label="搜索 Skill 商店" placeholder="搜索技能名称、描述或关键词…" value={value} onChange={(event) => onChange(event.target.value)} />
      {value ? <button type="button" className="tsh-iconbtn tsh-search-clear" aria-label="清空搜索" onClick={() => { onChange(''); input.current?.focus() }}><StoreIcon name="x" size={16} /></button> : <kbd className="tsh-kbd" aria-hidden="true">/</kbd>}
      <button type="submit" className="tsh-btn tsh-btn-primary">搜索</button>
    </form>
    {suggestions.length > 0 && <div className="tsh-search-hints"><span>大家在搜</span>{suggestions.map((label) => <button key={label} type="button" className="tsh-chip" onClick={() => onSubmit(label)}>{label}</button>)}</div>}
  </div>
}
