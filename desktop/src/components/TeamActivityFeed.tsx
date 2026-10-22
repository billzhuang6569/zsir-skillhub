import { useCallback, useEffect, useRef, useState } from 'react'
import { useStore } from '../store/index.js'
import { Icon } from './Icon.js'
import { UserChip } from './UserChip.js'
import { LoadError, SkeletonBlock } from './StateViews.js'
import { apiGetTeamActivity } from '../lib/api.js'
import { teamErrorMessage } from '../lib/ui-helpers.js'
import { loadFailedMessage } from '../lib/state-copy.js'
import { notificationTimeLabel } from '../lib/notification-center.js'
import {
  activitySentence, appendActivityPage, TEAM_ACTIVITY_PAGE_SIZE, type TeamActivityItem,
} from '../lib/team-activity.js'

const ACTIVITY_ICONS: Record<string, 'user-plus' | 'log-out' | 'shared-skills' | 'refresh' | 'key-round' | 'activity'> = {
  member_joined: 'user-plus',
  member_left: 'log-out',
  member_removed: 'log-out',
  skill_shared: 'shared-skills',
  skill_unshared: 'shared-skills',
  skill_version_published: 'refresh',
  key_put: 'key-round',
  key_rotated: 'key-round',
  key_revoked: 'key-round',
}

/** 团队动态 (#295 board 8): newest first, 「加载更多」 pages with `nextBefore`. */
export default function TeamActivityFeed({ teamId }: { teamId: string }) {
  const currentUserId = useStore((state) => state.currentUser?.id ?? null)
  const [items, setItems] = useState<TeamActivityItem[]>([])
  const [nextBefore, setNextBefore] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const generation = useRef(0)

  const load = useCallback(async (): Promise<void> => {
    const current = ++generation.current
    setLoading(true)
    setError(null)
    try {
      const page = await apiGetTeamActivity(teamId, { limit: TEAM_ACTIVITY_PAGE_SIZE })
      if (current !== generation.current) return
      setItems(page.items)
      setNextBefore(page.nextBefore)
    } catch (reason: unknown) {
      if (current === generation.current) setError(teamErrorMessage(reason))
    } finally {
      if (current === generation.current) setLoading(false)
    }
  }, [teamId])

  useEffect(() => {
    setItems([])
    setNextBefore(null)
    void load()
    return () => { generation.current += 1 }
  }, [load])

  const loadMore = async (): Promise<void> => {
    if (!nextBefore || loadingMore) return
    const current = generation.current
    setLoadingMore(true)
    try {
      const page = await apiGetTeamActivity(teamId, { limit: TEAM_ACTIVITY_PAGE_SIZE, before: nextBefore })
      if (current !== generation.current) return
      setItems((existing) => appendActivityPage(existing, page.items))
      setNextBefore(page.nextBefore)
    } catch (reason: unknown) {
      if (current === generation.current) setError(teamErrorMessage(reason))
    } finally {
      if (current === generation.current) setLoadingMore(false)
    }
  }

  if (loading && items.length === 0) return <SkeletonBlock layout="rows" count={3} compact label="正在读取团队动态…" />
  if (error && items.length === 0) return <LoadError message={loadFailedMessage('团队动态', error)} retrying={loading} onRetry={() => void load()} />
  if (items.length === 0) return <div className="team-detail-empty"><Icon name="activity" size={20} /><div><b>还没有动态</b><span>成员加入、共享 Skill 和放钥匙都会记在这里。</span></div></div>

  return <div className="team-activity">
    <ol className="team-activity-list">
      {items.map((item) => <li key={item.id} className="team-activity-row">
        <span className="team-activity-icon" aria-hidden="true"><Icon name={ACTIVITY_ICONS[item.type] ?? 'activity'} size={14} /></span>
        <span className="team-activity-text">{activitySentence(item, currentUserId).map((part, index) => part.kind === 'user'
          ? <UserChip key={index} name={part.name} me={part.me} avatarUrl={part.avatarUrl} />
          : part.kind === 'key'
            ? <code key={index} className="team-activity-key">{part.text}</code>
            : part.kind === 'skill'
              ? <b key={index}>{part.text}</b>
              : <span key={index}>{part.text}</span>)}</span>
        <time className="team-activity-time" dateTime={item.createdAt}>{notificationTimeLabel(Date.parse(item.createdAt))}</time>
      </li>)}
    </ol>
    {error && <p className="team-activity-error" role="status">{loadFailedMessage('更多动态', error)}</p>}
    {nextBefore && <button type="button" className="btn btn-ghost btn-sm team-activity-more" disabled={loadingMore} onClick={() => void loadMore()}>{loadingMore ? '加载中…' : '加载更多'}</button>}
  </div>
}
