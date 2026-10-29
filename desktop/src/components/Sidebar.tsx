import { useSpaceCapabilities } from '../lib/use-space-capabilities.js'
import WindowControls from './WindowControls.js'
import { useMediaUrl } from '../lib/media.js'
import { useStore } from '../store/index.js'
import { Icon } from './Icon.js'
import { BrandMark } from './BrandMark.js'
import { userInitials } from '../lib/auth.js'
import type { View } from '../store/index.js'
import './Sidebar.css'
import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react'
import SidebarResizer from './SidebarResizer.js'
import SidebarQuickAccess from './SidebarQuickAccess.js'
import { clampSidebarWidth, sidebarBounds } from '../lib/sidebar-width.js'
import NotificationCenter, { useNotificationEntries, useRunFailurePolling } from './NotificationCenter.js'
import { bellAriaLabel, notificationBadgeText, unreadNotificationCount } from '../lib/notification-center.js'

type NavItem = { view: View; icon: Parameters<typeof Icon>[0]['name']; label: string; badge?: number }

const NAV_ITEMS: NavItem[] = [
  { view: 'skills',      icon: 'skills',  label: '我的 Skills' },
  { view: 'team-skills', icon: 'shared-skills', label: '团队共享' },
  { view: 'teams',       icon: 'team',    label: 'My Team' },
  { view: 'marketplace', icon: 'market',  label: 'Skill 商店' },
  { view: 'keys',        icon: 'key-round', label: '钥匙' },
  { view: 'settings',    icon: 'gear',    label: '设置' },
]

function subscribeWindowWidth(onChange: () => void): () => void {
  window.addEventListener('resize', onChange)
  return () => window.removeEventListener('resize', onChange)
}

function windowWidth(): number {
  return window.innerWidth
}

export default function Sidebar({ onFeedback, onDonate }: { onFeedback: () => void; onDonate: () => void }) {
  const {
    view, setView, closeSheet,
    currentUser, authStatus, promptForAuth,
    sidebarWidth, setSidebarWidth,
  } = useStore()
  const capabilities = useSpaceCapabilities()
  const imageUrl = useMediaUrl(currentUser?.avatarUrl)
  const sidebarRef = useRef<HTMLElement>(null)
  // The preference survives page switches and restarts; the rendered width is
  // clamped to the current window so the workspace never collapses.
  const currentWindowWidth = useSyncExternalStore(subscribeWindowWidth, windowWidth, () => Number.NaN)
  const renderedWidth = clampSidebarWidth(sidebarWidth, currentWindowWidth)
  const bounds = sidebarBounds(currentWindowWidth)
  const [showNotifications, setShowNotifications] = useState(false)
  const [avatarFailed, setAvatarFailed] = useState(false)
  const notificationAnchorRef = useRef<HTMLDivElement>(null)
  const bellRef = useRef<HTMLButtonElement>(null)
  // #295: one badge for unread server notices plus local run failures and key consent requests.
  useRunFailurePolling()
  const notificationEntries = useNotificationEntries()
  const unreadCount = unreadNotificationCount(notificationEntries)

  useEffect(() => setAvatarFailed(false), [imageUrl])
  useEffect(() => {
    if (!showNotifications) return
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      setShowNotifications(false)
      bellRef.current?.focus()
    }
    const closeOutside = (event: PointerEvent): void => {
      if (!notificationAnchorRef.current?.contains(event.target as Node)) setShowNotifications(false)
    }
    window.addEventListener('keydown', closeOnEscape)
    document.addEventListener('pointerdown', closeOutside)
    return () => {
      window.removeEventListener('keydown', closeOnEscape)
      document.removeEventListener('pointerdown', closeOutside)
    }
  }, [showNotifications])

  useEffect(() => {
    if (authStatus !== 'authenticated') setShowNotifications(false)
  }, [authStatus])

  const navigate = (item: NavItem): void => {
    setShowNotifications(false)
    if ((item.view === 'team-skills' || item.view === 'teams') && authStatus !== 'authenticated') {
      promptForAuth({
        reason: item.view === 'team-skills' ? '登录后查看团队共享的 Skills' : '登录后管理您的团队',
        intent: { kind: 'view', view: item.view },
      })
      return
    }
    closeSheet()
    setView(item.view)
    if (item.view === 'team-skills') window.dispatchEvent(new CustomEvent('skillhub:refresh-team-shares', { detail: { reason: 'navigation' } }))
    if (item.view === 'marketplace') window.dispatchEvent(new Event('skillhub:refresh-marketplace'))
  }

  const openAccount = (): void => {
    setShowNotifications(false)
    if (capabilities.profile === 'local') { setView('settings'); return }
    if (authStatus !== 'authenticated') {
      promptForAuth({ reason: '登录后查看和修改个人资料', intent: { kind: 'account' } })
      return
    }
    closeSheet()
    setView('settings')
  }

  return (
    <aside className="sidebar" ref={sidebarRef} style={{ '--sidebar-width': `${renderedWidth}px` } as CSSProperties}>
      <WindowControls />
      <div className="sidebar-brand" data-tauri-drag-region>
        <BrandMark size={34} className="brand-mark" />
        <div className="sidebar-wordmark">
          <b>一探 SkillHub</b>
          <span>SKILL MANAGER</span>
        </div>
      </div>

      <nav className="sidebar-nav" aria-label="主导航">
        {NAV_ITEMS.filter(item => capabilities.teams || (item.view !== 'teams' && item.view !== 'team-skills')).map((item) => (
          <button
            key={item.view}
            data-tour={item.view}
            className={`sidebar-nav-btn${view === item.view ? ' active' : ''}`}
            aria-current={view === item.view ? 'page' : undefined}
            onClick={() => navigate(item)}
          >
            <Icon name={item.icon} size={16} />
            <span className="sidebar-nav-label">{item.label}</span>
            {item.badge != null && item.badge > 0 && (
              <span className="sidebar-nav-badge">{item.badge}</span>
            )}
          </button>
        ))}
      </nav>

      <SidebarQuickAccess />

      <div className="sidebar-footer">
        <div className="sidebar-support-actions">{capabilities.account && <button type="button" className="sidebar-feedback" onClick={onFeedback}><Icon name="msg" size={15} />反馈</button>}<button type="button" className="sidebar-tokens" onClick={onDonate}>Buy me Tokens</button></div>
        <div className="sidebar-user-row">
          <button className="sidebar-account" onClick={openAccount} aria-label={capabilities.profile === 'local' ? '打开设置' : currentUser ? '打开个人设置' : '登录账号'}>
            <span className="user-avatar" aria-hidden="true">
              {capabilities.profile === 'local' ? <Icon name="laptop" size={20} /> : imageUrl && !avatarFailed
                ? <img src={imageUrl} alt="" onError={() => setAvatarFailed(true)} />
                : currentUser ? userInitials(currentUser) : '游'}
            </span>
            <span className="user-info">
              <b>{capabilities.profile === 'local' ? '仅本机' : currentUser?.displayName ?? (authStatus === 'restoring' ? '正在恢复账号' : '未登录')}</b>
              <span>{capabilities.profile === 'local' ? '不连接服务器' : currentUser?.email ?? '本机 Skill 可直接使用'}</span>
            </span>
          </button>
          {authStatus === 'authenticated' && <div className="notification-anchor" ref={notificationAnchorRef}>
            <button ref={bellRef} className={`bell-btn${showNotifications ? ' open' : ''}`} onClick={() => setShowNotifications((value) => !value)} aria-label={bellAriaLabel(unreadCount)} aria-expanded={showNotifications} aria-controls="notification-popover">
              <Icon name="bell" size={15} />
              {unreadCount > 0 && <span className="bell-badge" aria-hidden="true">{notificationBadgeText(unreadCount)}</span>}
            </button>
            {showNotifications && <div id="notification-popover" className="notification-popover" role="region" aria-label="通知列表">
              <NotificationCenter entries={notificationEntries} onClose={() => setShowNotifications(false)} />
            </div>}
          </div>}
        </div>
      </div>
      <SidebarResizer targetRef={sidebarRef} width={renderedWidth} bounds={bounds} onCommit={setSidebarWidth} />
    </aside>
  )
}
