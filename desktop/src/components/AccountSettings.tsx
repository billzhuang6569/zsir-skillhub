import { useEffect, useRef, useState } from 'react'
import { apiLogout, apiLogoutAll, apiUpdateProfile, sameSpace, ApiError } from '../lib/api.js'
import {
  cancelYitanPortalAuth,
  authState,
  openYitanAccountPortal,
  startYitanPortalAuth,
} from '../lib/tauri.js'
import { useStore } from '../store/index.js'
import AvatarUploader from './AvatarUploader.js'
import { toast } from './Toast.js'
import './AccountSettings.css'
import { useSpaceCapabilities } from '../lib/use-space-capabilities.js'

type Editor = 'profile' | null

function messageOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (message === 'Invalid profile data') return '个人资料不符合要求，请检查后重试'
  if (message === 'Too many attempts. Try again later.') return '尝试次数过多，请稍后再试'
  if (message === 'Unauthorized') return '登录状态已失效，请重新登录'
  return message || '操作失败，请稍后再试'
}

export default function AccountSettings() {
  const capabilities = useSpaceCapabilities()
  const currentUser = useStore((state) => state.currentUser)
  const updateCurrentUser = useStore((state) => state.updateCurrentUser)
  const setAuthSession = useStore((state) => state.setAuthSession)
  const clearAuthSession = useStore((state) => state.clearAuthSession)
  const authStatus = useStore((state) => state.authStatus)
  const promptForAuth = useStore((state) => state.promptForAuth)
  const [editor, setEditor] = useState<Editor>(null)
  const [displayName, setDisplayName] = useState(currentUser?.displayName ?? '')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [linking, setLinking] = useState(false)
  const [signingOut, setSigningOut] = useState(false)
  const linkCommandActive = useRef(false)

  useEffect(() => {
    setDisplayName(currentUser?.displayName ?? '')
  }, [currentUser])

  useEffect(() => () => {
    if (linkCommandActive.current) void cancelYitanPortalAuth().catch(() => undefined)
  }, [])

  if (!currentUser) return <div className="account-settings">
    <div className="settings-row account-summary account-summary-guest">
      <span className="account-guest-avatar" aria-hidden="true">游</span>
      <div className="settings-row-info">
        <b>{authStatus === 'restoring' ? '正在恢复账号' : '未登录'}</b>
        <span>本机 Skill 无需登录即可管理和使用；团队共享与个人资料需要登录。</span>
      </div>
      <button
        type="button"
        className="btn btn-primary btn-sm"
        disabled={authStatus === 'restoring'}
        onClick={() => promptForAuth({ reason: '登录后查看和修改个人资料', intent: { kind: 'account' } })}
      >{authStatus === 'restoring' ? '正在恢复…' : '登录账号'}</button>
    </div>
  </div>

  const busy = saving || linking || signingOut

  const switchEditor = (next: Editor): void => {
    setEditor(next)
    setError(null)
    setDisplayName(currentUser.displayName)
  }

  const saveProfile = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    const name = displayName.trim()
    if (!name) { setError('显示名称不能为空'); return }
    if (name.length > 50) { setError('显示名称不能超过 50 个字符'); return }
    setSaving(true)
    setError(null)
    try {
      const { user } = await apiUpdateProfile({ displayName: name })
      updateCurrentUser(user)
      setEditor(null)
      toast('个人资料已更新')
    } catch (requestError: unknown) {
      setError(messageOf(requestError))
    } finally {
      setSaving(false)
    }
  }

  const persistAvatar = async (avatarUrl: string | null): Promise<void> => {
    setSaving(true)
    setError(null)
    try {
      const { user } = await apiUpdateProfile({ avatarUrl })
      updateCurrentUser(user)
      toast(avatarUrl ? '头像已更新' : '头像已移除')
    } finally {
      setSaving(false)
    }
  }

  const openAccountPortal = async (): Promise<void> => {
    setError(null)
    try {
      await openYitanAccountPortal()
    } catch (requestError: unknown) {
      const message = messageOf(requestError)
      setError(message)
      toast(`无法打开一探账号门户：${message}`, 'error')
    }
  }

  const linkYitanAccount = async (): Promise<void> => {
    const previousSpace = useStore.getState().authSpace
    setLinking(true)
    linkCommandActive.current = true
    setError(null)
    try {
      const session = await startYitanPortalAuth('link', currentUser.id)
      const state = await authState()
      if (!sameSpace(state, session.space) || state.userId !== session.user.id) {
        throw new Error('绑定期间 SkillHub 账号已切换，请重新操作')
      }
      setAuthSession(session.user, session.space)
      toast('已绑定一探统一账号')
    } catch (requestError: unknown) {
      const message = messageOf(requestError)
      if (message.startsWith('本机 skillhub 命令同步失败：') && sameSpace(useStore.getState().authSpace, previousSpace)) {
        clearAuthSession()
        promptForAuth({ reason: '账号已绑定，但本机账号同步失败，请重新登录', intent: { kind: 'account' } })
        toast('账号已绑定，但本机账号同步失败，已退出登录', 'warn')
      }
      setError(message)
    } finally {
      linkCommandActive.current = false
      setLinking(false)
    }
  }

  const signOut = async (): Promise<void> => {
    const previousSpace = useStore.getState().authSpace
    setSigningOut(true)
    try {
      if (capabilities.profile === 'official') await apiLogoutAll()
      else await apiLogout()
      const state = await authState()
      if (!state.userId && !state.pending) clearAuthSession()
      toast('已退出所有设备，服务端旧会话已全部撤销')
    } catch (requestError: unknown) {
      if (requestError instanceof ApiError && requestError.status === 401) {
        const state = await authState()
        if (!state.userId && !state.pending) clearAuthSession()
        toast('登录状态已失效，已清理本机账号', 'warn')
      } else if (messageOf(requestError).startsWith('本机 skillhub 命令同步失败：') && sameSpace(useStore.getState().authSpace, previousSpace)) {
        clearAuthSession()
        promptForAuth({ reason: '服务端已退出，但本机账号同步失败，请重新登录', intent: { kind: 'account' } })
        toast('服务端已退出，但本机账号同步失败', 'warn')
      } else {
        toast(`退出失败：${messageOf(requestError)}`, 'error')
      }
    } finally {
      setSigningOut(false)
    }
  }

  return (
    <div className={`account-settings${capabilities.profile === 'selfhost' ? ' account-settings-selfhost' : ''}`}>
      <div className="settings-row account-summary">
        <AvatarUploader
          avatarUrl={currentUser.avatarUrl}
          fallbackText={currentUser.displayName || currentUser.email}
          label="个人头像"
          className="account-avatar-uploader"
          disabled={busy || !capabilities.avatarUpload}
          onPersist={persistAvatar}
          onError={(message) => { setError(message); toast(`头像更新失败：${message}`, 'error') }}
        />
        <div className="settings-row-info">
          <b>{capabilities.profile === 'selfhost' ? '当前账号' : currentUser.displayName} <span className="inline-status online">已登录</span></b>
          <span>{currentUser.email} · {capabilities.profile === 'selfhost' ? currentUser.marketplaceRole === 'admin' ? '实例管理员' : '成员' : currentUser.yitanAccountLinked ? '已绑定一探统一账号' : 'SkillHub 原账号'}</span>
          {capabilities.profile === 'selfhost' && <span>{currentUser.marketplaceRole === 'admin' ? '密码可在服务器上用 CLI 重置' : '密码重置请联系实例管理员'}</span>}
          {capabilities.profile === 'official' && <span>退出所有设备会让所有设备上的一探 SkillHub 登录与商店登录失效。</span>}
        </div>
        <div className="account-actions">
          {capabilities.profile === 'official' && currentUser.yitanAccountLinked !== true && <button type="button" className="btn btn-primary btn-sm" disabled={saving || signingOut} onClick={() => linking ? void cancelYitanPortalAuth().catch(() => undefined) : void linkYitanAccount()}>{linking ? '取消本次绑定' : '绑定一探账号'}</button>}
          <button type="button" className="btn btn-ghost btn-sm" disabled={busy} aria-expanded={editor === 'profile'} aria-controls="account-profile-editor" onClick={() => switchEditor(editor === 'profile' ? null : 'profile')}>编辑资料</button>
          {capabilities.profile === 'official' && <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void openAccountPortal()}>账号、密码与找回</button>}
          <button type="button" className="btn btn-danger-soft btn-sm" title="撤销此账号在所有设备上的现有登录凭证" disabled={busy} onClick={() => void signOut()}>{signingOut ? '正在退出所有设备…' : '退出所有设备'}</button>
        </div>
      </div>

      {error && editor === null && <p className="account-error account-error-standalone" role="alert">{error}</p>}
      {editor === 'profile' && (
        <form id="account-profile-editor" className="account-editor account-editor-profile" onSubmit={(event) => void saveProfile(event)}>
          <label><span>显示名称</span><input value={displayName} onChange={(event) => { setDisplayName(event.target.value); setError(null) }} maxLength={50} autoComplete="name" /></label>
          {error && <p className="account-error" role="alert">{error}</p>}
          <div className="account-editor-actions"><button type="button" className="btn btn-ghost btn-sm" disabled={saving} onClick={() => switchEditor(null)}>取消</button><button type="submit" className="btn btn-primary btn-sm" disabled={saving}>{saving ? '保存中…' : '保存资料'}</button></div>
        </form>
      )}
    </div>
  )
}
