import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useStore } from '../store/index.js'
import { Icon } from './Icon.js'
import { SegmentedControl } from './SegmentedControl.js'
import { UserChip } from './UserChip.js'
import { toast } from './Toast.js'
import {
  apiApproveJoinRequest, apiGetNotifications, apiGetTeams, apiMarkAllRead, apiMarkNotificationRead, apiRejectJoinRequest, sameSpace,
} from '../lib/api.js'
import {
  dismissKeyConsentRequest, grantKeyAccess, listLastRunFailures, setKeyAutoAllow,
} from '../lib/tauri.js'
import { applyConsentChoice, type ConsentChoice } from '../lib/keys.js'
import {
  buildNotificationEntries, filterNotificationEntries, notificationTabCount, notificationTimeLabel,
  payloadText, runFailureAction, unreadNotificationCount,
  type NotificationEntry, type NotificationFilter, type RichSegment,
} from '../lib/notification-center.js'
import { EMPTY_COPY } from '../lib/state-copy.js'

/** `skillhub run` happens outside the APP; the bell re-reads failed runs on this cadence and on focus. */
const RUN_FAILURE_POLL_MS = 30_000

/**
 * Keeps `lastRunFailures` fresh on every page (#295): the 我的 Skills page
 * polls too, but the bell must count failures wherever the user is.
 */
export function useRunFailurePolling(): void {
  const space = useStore(state => state.activeSpace)
  const pending = useStore(state => state.spacePending)
  const authStatus = useStore((state) => state.authStatus)
  const accountUserId = useStore((state) => state.currentUser?.id ?? null)
  const setLastRunFailures = useStore((state) => state.setLastRunFailures)
  useEffect(() => {
    if (pending || authStatus === 'restoring') return
    let active = true
    const refresh = (): void => {
      if (document.visibilityState === 'hidden') return
      void listLastRunFailures(accountUserId).then((records) => {
        if (active && useStore.getState().activeSpace === space && (useStore.getState().currentUser?.id ?? null) === accountUserId) setLastRunFailures(records)
      }).catch(() => { /* Mid-switch or unreadable records: try again on the next tick. */ })
    }
    refresh()
    const timer = window.setInterval(refresh, RUN_FAILURE_POLL_MS)
    window.addEventListener('focus', refresh)
    return () => {
      active = false
      window.clearInterval(timer)
      window.removeEventListener('focus', refresh)
    }
  }, [accountUserId, authStatus, space, pending, setLastRunFailures])
}

/** Server notifications (last 30 days) plus local run failures and consent requests. */
export function useNotificationEntries(): NotificationEntry[] {
  const notifications = useStore((state) => state.notifications)
  const lastRunFailures = useStore((state) => state.lastRunFailures)
  const consentRequests = useStore((state) => state.keyConsentRequests)
  const skills = useStore((state) => state.skills)
  const currentUserId = useStore((state) => state.currentUser?.id ?? null)
  const vaultKeys = useStore((state) => state.keyVault.keys)
  return useMemo(() => {
    const names = new Map(skills.map((skill) => [skill.id, skill.name]))
    return buildNotificationEntries({
      notifications,
      runFailures: Object.values(lastRunFailures),
      consentRequests,
      skillName: (skillId) => names.get(skillId) ?? skillId,
      currentUserId,
      vaultKeys,
    })
  }, [consentRequests, currentUserId, lastRunFailures, notifications, skills, vaultKeys])
}

function Rich({ segments }: { segments: readonly RichSegment[] }) {
  return <>{segments.map((segment, index) => typeof segment === 'string'
    ? <span key={index}>{segment}</span>
    : 'code' in segment
      ? <code key={index} className="notification-code">{segment.code}</code>
      : <UserChip key={index} name={segment.user.name} me={segment.user.me} />)}</>
}

type NotificationCenterProps = {
  entries: NotificationEntry[]
  onClose: () => void
}

/** Popover body of the sidebar bell (#295 board 3). */
export default function NotificationCenter({ entries, onClose }: NotificationCenterProps) {
  const {
    setNotifications, closeSheet, setView, openSkillSheet, setActiveTeam, setPendingCommentNavigation,
    setKeysPageIntent, setKeyConsentRequests,
  } = useStore()
  const [filter, setFilter] = useState<NotificationFilter>('all')
  const [busyId, setBusyId] = useState<string | null>(null)
  const unread = unreadNotificationCount(entries)
  const visible = filterNotificationEntries(entries, filter)
  const serverUnread = entries.some((entry) => entry.origin === 'server' && entry.unread)

  const markReadLocally = (notificationId: string): void => {
    setNotifications(useStore.getState().notifications.map((item) => item.id === notificationId ? { ...item, read: true } : item))
  }

  const markRead = async (notificationId: string): Promise<void> => {
    const space = useStore.getState().activeSpace
    if (!space || useStore.getState().spacePending) return
    try {
      await apiMarkNotificationRead(notificationId, space)
      if (!sameSpace(space, useStore.getState().activeSpace)) return
      markReadLocally(notificationId)
    } catch {
      toast('标记通知失败', 'error')
    }
  }

  const markAllRead = async (): Promise<void> => {
    const space = useStore.getState().activeSpace
    if (!space || useStore.getState().spacePending) return
    try {
      await apiMarkAllRead(space)
      if (!sameSpace(space, useStore.getState().activeSpace)) return
      setNotifications(useStore.getState().notifications.map((item) => ({ ...item, read: true })))
      toast('通知已全部标记为已读')
    } catch {
      toast('标记失败', 'error')
    }
  }

  const openServerEntry = (entry: NotificationEntry): void => {
    const notification = entry.notification
    if (!notification) return
    if (notification.type === 'team_key_scope_added') {
      onClose()
      closeSheet()
      setKeysPageIntent({ tab: 'team' })
      setView('keys')
      if (!notification.read) void markRead(notification.id)
      return
    }
    if (notification.type === 'skill_update' || notification.type === 'skill_unshared') {
      const teamId = payloadText(notification.payload, 'teamId')
      const skillId = payloadText(notification.payload, 'skillId')
      if (teamId && skillId) {
        onClose()
        useStore.getState().openTeamSkill(teamId, skillId)
      } else toast('这条提醒缺少跳转信息', 'error')
      if (!notification.read) void markRead(notification.id)
      return
    }
    if (notification.type !== 'comment_mention') {
      if (!notification.read) void markRead(notification.id)
      return
    }
    const teamId = payloadText(notification.payload, 'teamId')
    const serverSkillId = payloadText(notification.payload, 'skillId')
    const commentId = payloadText(notification.payload, 'commentId')
    if (!teamId || !serverSkillId || !commentId) {
      toast('这条提醒缺少跳转信息', 'error')
      if (!notification.read) void markRead(notification.id)
      return
    }
    onClose()
    closeSheet()
    setActiveTeam(teamId)
    setPendingCommentNavigation({ teamId, serverSkillId, commentId })
    setView('team-skills')
    markReadLocally(notification.id)
    const space = useStore.getState().activeSpace
    if (!notification.read && space) void apiMarkNotificationRead(notification.id, space).catch(() => {
      toast('通知已打开，但已读状态暂未同步', 'warn')
    })
  }

  const respondToJoinRequest = async (entry: NotificationEntry, approve: boolean): Promise<void> => {
    const notification = entry.notification
    if (!notification || busyId) return
    const teamId = payloadText(notification.payload, 'teamId')
    const requestId = payloadText(notification.payload, 'requestId')
    if (!teamId || !requestId) return toast('申请信息不完整，请到团队详情处理', 'error')
    const space = useStore.getState().activeSpace
    if (!space || useStore.getState().spacePending) return
    setBusyId(entry.id)
    try {
      if (approve) await apiApproveJoinRequest(teamId, requestId, space)
      else await apiRejectJoinRequest(teamId, requestId, space)
      if (!sameSpace(space, useStore.getState().activeSpace)) return
      await apiMarkNotificationRead(notification.id, space).catch(() => undefined)
      if (!sameSpace(space, useStore.getState().activeSpace)) return
      const [freshNotifications, freshTeams] = await Promise.all([apiGetNotifications(space), apiGetTeams(space)])
      if (!sameSpace(space, useStore.getState().activeSpace)) return
      setNotifications(freshNotifications)
      useStore.getState().setTeams(freshTeams)
      toast(approve ? '已通过加入申请' : '已拒绝加入申请')
    } catch {
      if (!sameSpace(space, useStore.getState().activeSpace)) return
      toast('处理申请失败，请到团队详情检查当前状态', 'error')
      try {
        const fresh = await apiGetNotifications(space)
        if (sameSpace(space, useStore.getState().activeSpace)) setNotifications(fresh)
      } catch { /* Keep the current notification visible for retry. */ }
    } finally { setBusyId(null) }
  }

  const openRunFailure = (entry: NotificationEntry): void => {
    const record = entry.runFailure
    if (!record) return
    onClose()
    setView('skills')
    if (runFailureAction(record) === 'fill-keys') openSkillSheet(record.skillId, 'environment', 'env')
    else openSkillSheet(record.skillId, 'profile')
  }

  const answerConsent = async (entry: NotificationEntry, choice: ConsentChoice): Promise<void> => {
    const request = entry.consent
    if (!request || busyId) return
    const accountUserId = useStore.getState().currentUser?.id ?? null
    const space = useStore.getState().activeSpace
    if (!space || useStore.getState().spacePending) return
    setBusyId(entry.id)
    try {
      await applyConsentChoice(request, choice, false, accountUserId, {
        grantKeyAccess: (skillId, key, once, account, variant) => grantKeyAccess(skillId, key, once, account, variant, space),
        dismissKeyConsentRequest: (skillId, account) => dismissKeyConsentRequest(skillId, account, space),
        setKeyAutoAllow: (enabled, key, account) => setKeyAutoAllow(enabled, key, account, null, space),
      }, useStore.getState().keyVault.keys)
      if (!sameSpace(space, useStore.getState().activeSpace)) return
      setKeyConsentRequests(useStore.getState().keyConsentRequests.filter((item) => item.skillId !== request.skillId))
      if (choice !== 'deny') toast(`已${choice === 'once' ? '允许这一次' : '允许'}，请让 Agent 重试`)
    } catch (error: unknown) {
      toast(error instanceof Error ? error.message : String(error), 'error')
    } finally { setBusyId(null) }
  }

  const actionsFor = (entry: NotificationEntry): ReactNode => {
    const busy = busyId === entry.id
    if (entry.origin === 'run-failure' && entry.runFailure) {
      return <button type="button" className="btn btn-primary btn-sm" onClick={() => openRunFailure(entry)}>{runFailureAction(entry.runFailure) === 'fill-keys' ? '去填写' : '查看详情'}</button>
    }
    if (entry.origin === 'consent') {
      return <>
        <button type="button" className="btn btn-primary btn-sm" disabled={Boolean(busyId)} onClick={() => void answerConsent(entry, 'allow')}>{busy ? '处理中…' : '允许'}</button>
        <button type="button" className="btn btn-ghost btn-sm" disabled={Boolean(busyId)} onClick={() => void answerConsent(entry, 'once')}>仅这次</button>
        <button type="button" className="btn btn-ghost btn-sm" disabled={Boolean(busyId)} onClick={() => void answerConsent(entry, 'deny')}>拒绝</button>
      </>
    }
    if (entry.type === 'join_request' && entry.actionable) {
      return <>
        <button type="button" className="btn btn-primary btn-sm" disabled={Boolean(busyId)} onClick={() => void respondToJoinRequest(entry, true)}>{busy ? '处理中…' : '通过'}</button>
        <button type="button" className="btn btn-ghost btn-sm" disabled={Boolean(busyId)} onClick={() => void respondToJoinRequest(entry, false)}>拒绝</button>
      </>
    }
    return null
  }

  return <>
    <div className="notification-head">
      <h2>通知</h2>
      {unread > 0 && <span className="notification-unread">{unread} 条未读</span>}
      {/* Local items (run failures, consent) stay unread until handled, so only server items get the bulk action. */}
      {serverUnread
        ? <button type="button" onClick={() => void markAllRead()}>全部已读</button>
        : unread === 0 && <span>全部已读</span>}
    </div>
    <SegmentedControl
      className="notification-filter"
      aria-label="通知分类"
      size="sm"
      value={filter}
      onChange={setFilter}
      options={[
        { value: 'all', label: '全部', icon: 'inbox', count: notificationTabCount(entries, 'all') },
        { value: 'action', label: '需要处理', icon: 'circle-alert', count: notificationTabCount(entries, 'action') },
        { value: 'team', label: '团队', icon: 'users-round', count: notificationTabCount(entries, 'team') },
        { value: 'store', label: '商店', icon: 'market', count: notificationTabCount(entries, 'store') },
      ]}
    />
    <div className="notification-list">
      {visible.length === 0
        ? <div className="notification-empty"><b>{filter === 'action' ? '没有需要处理的事' : EMPTY_COPY.notificationsNone.title}</b><span>{filter === 'action' ? '运行失败、钥匙授权和加入申请会出现在这里。' : EMPTY_COPY.notificationsNone.hint}</span></div>
        : visible.map((entry) => {
          const actions = actionsFor(entry)
          const body = <>
            <span className={`notification-icon tone-${entry.tone}`} aria-hidden="true"><Icon name={entry.icon} size={16} /></span>
            <span className="notification-copy">
              <span className="notification-title"><Rich segments={entry.title} /></span>
              <span className="notification-desc"><Rich segments={entry.description} /></span>
              {actions && <span className="notification-actions">{actions}</span>}
            </span>
            <small className="notification-time">{notificationTimeLabel(entry.at)}</small>
            {entry.unread && <span className="notification-dot" aria-label="未读" />}
          </>
          // Actionable rows hold their own buttons; plain server rows are one button (mark read / navigate).
          if (actions) return <article key={entry.id} className={`notification-item${entry.unread ? ' unread' : ' read'}`}>{body}</article>
          const clickable = entry.origin === 'server' && (entry.type === 'comment_mention' || entry.type === 'team_key_scope_added' || entry.unread)
          return clickable
            ? <button key={entry.id} type="button" className={`notification-item${entry.unread ? ' unread' : ' read'}`} onClick={() => openServerEntry(entry)}>{body}</button>
            : <article key={entry.id} className="notification-item read">{body}</article>
        })}
    </div>
    <footer className="notification-foot">只显示最近 30 天的通知</footer>
  </>
}
