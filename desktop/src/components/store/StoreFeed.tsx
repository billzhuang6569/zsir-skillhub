// 全部技能 lazy list (design-system InfiniteList): the sentinel prefetches 600px early,
// up to 5 pages load automatically, then 「加载更多」; skeletons while loading, never a
// spinner; a failed page keeps the loaded rows and offers 重试; the end says how many.
import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  CATALOG_PREFETCH_MARGIN, FeedController, feedAutoLoads,
  type FeedSnapshot, type FetchFeedPage,
} from '../../lib/store-catalog.js'
import { formatStoreCount } from '../../lib/store-home.js'
import { CLEAR_FILTERS_LABEL, EMPTY_COPY, LOAD_FAILED_TITLE, RETRY_LABEL } from '../../lib/state-copy.js'
import { StoreIcon, StoreSkeleton } from './StoreUI.js'

/** The element that actually scrolls (the app's main pane), so rootMargin prefetch works inside it. */
function scrollRoot(element: HTMLElement): HTMLElement | null {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY
    if (overflow === 'auto' || overflow === 'scroll') return node
  }
  return null
}

export type StoreFilterDef = { id: string; label: string; value: string; options: ReadonlyArray<{ value: string; label: string }> }

/** Sticky FilterBar: sort tabs, native selects, list / grid switch (design-system FilterBar). */
export function StoreFilterBar({ sorts, sort, onSortChange, filters, onFilterChange, view, onViewChange }: {
  sorts: ReadonlyArray<{ id: string; label: string }>
  sort: string
  onSortChange: (id: string) => void
  filters: StoreFilterDef[]
  onFilterChange: (id: string, value: string) => void
  view: 'card' | 'list'
  onViewChange: (view: 'card' | 'list') => void
}) {
  return <div className="tsh-filter">
    <div className="tsh-tabs tsh-sort-tabs" role="radiogroup" aria-label="Skill 商店排序">
      {sorts.map((item) => <button key={item.id} type="button" role="radio" className="tsh-tab" aria-checked={sort === item.id} onClick={() => onSortChange(item.id)}>{item.label}</button>)}
    </div>
    <div className="tsh-filter-right">
      {filters.map((filter) => <label key={filter.id} className="tsh-select">
        <span className="tsh-sr-only">{filter.label}</span>
        <select aria-label={filter.label} value={filter.value} onChange={(event) => onFilterChange(filter.id, event.target.value)}>
          {filter.options.map((option) => <option key={option.value || 'all'} value={option.value}>{option.label}</option>)}
        </select>
        <StoreIcon name="chev" size={14} />
      </label>)}
      <div className="tsh-seg" role="group" aria-label="Skill 显示方式">
        <button type="button" aria-pressed={view === 'list'} aria-label="列表视图" title="列表视图" onClick={() => onViewChange('list')}><StoreIcon name="list" size={16} /></button>
        <button type="button" aria-pressed={view === 'card'} aria-label="卡片视图" title="卡片视图" onClick={() => onViewChange('card')}><StoreIcon name="grid" size={16} /></button>
      </div>
    </div>
  </div>
}

type StoreFeedProps<T> = {
  /** Changes whenever sort / filters / query change: the list clears and in-flight pages are dropped. */
  resetKey: string
  fetchPage: FetchFeedPage<T>
  keyOf: (item: T) => string
  view: 'card' | 'list'
  renderItem: (item: T, view: 'card' | 'list') => ReactNode
  onSnapshot?: (snapshot: FeedSnapshot<T>) => void
  onClearFilters?: () => void
}

export function StoreFeed<T>({ resetKey, fetchPage, keyOf, view, renderItem, onSnapshot, onClearFilters }: StoreFeedProps<T>) {
  const [snapshot, setSnapshot] = useState<FeedSnapshot<T>>({ items: [], status: 'loading', pagesLoaded: 0, total: null })
  const fetchRef = useRef(fetchPage)
  fetchRef.current = fetchPage
  const snapshotRef = useRef(onSnapshot)
  snapshotRef.current = onSnapshot
  const controller = useRef<FeedController<T> | null>(null)
  if (!controller.current) controller.current = new FeedController<T>(keyOf, (next) => { setSnapshot(next); snapshotRef.current?.(next) })
  const sentinel = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const feed = controller.current
    if (!feed) return
    feed.reset((page) => fetchRef.current(page))
    return () => feed.dispose()
  }, [resetKey])

  const auto = feedAutoLoads(snapshot)
  useEffect(() => {
    const target = sentinel.current
    if (!target || !auto || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting) controller.current?.loadNext()
    }, { root: scrollRoot(target), rootMargin: `${CATALOG_PREFETCH_MARGIN}px 0px` })
    observer.observe(target)
    return () => observer.disconnect()
  }, [auto, snapshot.items.length])

  const loading = snapshot.status === 'loading'
  const empty = snapshot.status === 'done' && snapshot.items.length === 0
  const grid = view === 'card'
  const skeletons = loading
    ? Array.from({ length: grid ? 6 : 4 }, (_, index) => <StoreSkeleton key={`skeleton-${index}`} variant={grid ? 'card' : 'row'} />)
    : null
  return <div className="tsh-feed">
    {empty
      ? <div className="tsh-empty"><strong>{EMPTY_COPY.storeNoResults.title}</strong>{EMPTY_COPY.storeNoResults.hint}{onClearFilters && <div className="tsh-empty-actions"><button type="button" className="tsh-btn tsh-btn-sm tsh-btn-secondary" onClick={onClearFilters}>{CLEAR_FILTERS_LABEL}</button></div>}</div>
      : <div role="feed" aria-busy={loading} aria-label="技能列表" className={grid ? 'tsh-grid' : 'tsh-list'}>
        {/* Store cards and rows are <article> elements, as role="feed" expects. */}
        {snapshot.items.map((item) => <Fragment key={keyOf(item)}>{renderItem(item, view)}</Fragment>)}
        {skeletons}
      </div>}
    <div ref={sentinel} className="tsh-sentinel" aria-hidden="true" />
    {snapshot.status === 'error' && <div className="tsh-feed-error" role="alert">{LOAD_FAILED_TITLE}<button type="button" className="tsh-btn tsh-btn-sm tsh-btn-secondary" onClick={() => controller.current?.loadNext()}><StoreIcon name="refresh" size={14} />{RETRY_LABEL}</button></div>}
    {snapshot.status === 'idle' && !auto && <div className="tsh-feed-end tsh-feed-more"><button type="button" className="tsh-btn tsh-btn-secondary" onClick={() => controller.current?.loadNext()}>加载更多</button></div>}
    {snapshot.status === 'done' && !empty && <div className="tsh-feed-end">已显示全部 <span className="tsh-num">{formatStoreCount(snapshot.items.length)}</span> 个结果</div>}
    <span className="tsh-sr-only" aria-live="polite">{loading ? '正在加载' : snapshot.status === 'error' ? LOAD_FAILED_TITLE : ''}</span>
  </div>
}
