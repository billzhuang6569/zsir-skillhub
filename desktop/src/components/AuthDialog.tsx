import { useEffect, useRef, useState } from 'react'
import { apiLogin, type ApiAuthSession } from '../lib/api.js'
import {
  authErrorMessage,
  normalizeEmail,
  validateLoginFields,
  type AuthFieldErrors,
} from '../lib/auth.js'
import {
  cancelYitanPortalAuth,
  openYitanAccountPortal,
  startYitanPortalAuth,
} from '../lib/tauri.js'
import FocusTrapDialog from './FocusTrapDialog.js'
import { Icon } from './Icon.js'
import { toast } from './Toast.js'
import './AuthDialog.css'

type AuthView = 'portal' | 'legacy-migration'

const appIconUrl = new URL('../../src-tauri/icons/128x128.png', import.meta.url).href

type AuthDialogProps = {
  reason: string
  restoreError?: string | null
  restoring?: boolean
  onRetryRestore?: () => void
  onUseAnotherAccount?: () => void | Promise<void>
  onAuthenticated: (session: ApiAuthSession) => Promise<void>
  onClose: () => void
}

export default function AuthDialog({
  reason,
  restoreError = null,
  restoring = false,
  onRetryRestore,
  onUseAnotherAccount,
  onAuthenticated,
  onClose,
}: AuthDialogProps) {
  const [view, setView] = useState<AuthView>('portal')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [errors, setErrors] = useState<AuthFieldErrors>({})
  const [serverError, setServerError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [linkingLegacy, setLinkingLegacy] = useState(false)
  const attemptRef = useRef(0)
  const portalCommandActive = useRef(false)

  useEffect(() => () => {
    attemptRef.current += 1
    if (portalCommandActive.current) void cancelYitanPortalAuth().catch(() => undefined)
  }, [])

  const close = (): void => {
    attemptRef.current += 1
    if (portalCommandActive.current) void cancelYitanPortalAuth().catch(() => undefined)
    onClose()
  }

  const switchView = (next: AuthView): void => {
    if (submitting) return
    setView(next)
    setErrors({})
    setServerError(null)
    setPassword('')
  }

  const authenticate = async (): Promise<void> => {
    const attempt = ++attemptRef.current
    portalCommandActive.current = true
    setSubmitting(true)
    setServerError(null)
    try {
      const session = await startYitanPortalAuth('login')
      if (attempt !== attemptRef.current) return
      await onAuthenticated(session)
      if (attempt === attemptRef.current) window.setTimeout(() => toast('欢迎回来'), 0)
    } catch (error: unknown) {
      if (attempt === attemptRef.current) setServerError(authErrorMessage(error))
    } finally {
      if (attempt === attemptRef.current) {
        portalCommandActive.current = false
        setSubmitting(false)
      }
    }
  }

  const migrateLegacyAccount = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    const fieldErrors = validateLoginFields({ email, password })
    setErrors(fieldErrors)
    setServerError(null)
    if (Object.keys(fieldErrors).length > 0) return

    const attempt = ++attemptRef.current
    setSubmitting(true)
    setLinkingLegacy(false)
    portalCommandActive.current = true
    try {
      // Rust holds the migration credential in memory until a successful link.
      const legacySession = await apiLogin({ email: normalizeEmail(email), password })
      // The legacy password is no longer needed once the short-lived migration
      // session has been issued. Do not retain it in React state while the
      // system-browser portal flow is waiting for the user.
      setPassword('')
      if (attempt !== attemptRef.current) return
      setLinkingLegacy(true)
      portalCommandActive.current = true
      const linkedSession = await startYitanPortalAuth(
        'link',
        legacySession.user.id,
      )
      if (attempt !== attemptRef.current) return
      await onAuthenticated(linkedSession)
      if (attempt === attemptRef.current) {
        window.setTimeout(() => toast('旧 SkillHub 账号已迁移到一探统一账号'), 0)
      }
    } catch (error: unknown) {
      if (attempt === attemptRef.current) setServerError(authErrorMessage(error))
    } finally {
      if (attempt === attemptRef.current) {
        portalCommandActive.current = false
        setLinkingLegacy(false)
        setSubmitting(false)
        setPassword('')
      }
    }
  }

  const openAccountHelp = async (): Promise<void> => {
    setServerError(null)
    try {
      await openYitanAccountPortal()
    } catch (error: unknown) {
      setServerError(authErrorMessage(error))
    }
  }

  return <FocusTrapDialog
    className="modal-layer auth-dialog-layer"
    label="登录一探 SkillHub"
    onEscape={close}
    closeOnBackdrop
  >
    <div className="modal-card auth-dialog-card" onPointerDown={(event) => event.stopPropagation()}>
      <div className="auth-dialog-head">
        <img className="auth-dialog-mark" src={appIconUrl} alt="一探 SkillHub" />
        <div><b>登录一探 SkillHub</b><span>{reason}</span></div>
        <button className="ico-btn" type="button" onClick={close} aria-label="关闭登录窗口"><Icon name="x" size={15} /></button>
      </div>

      {restoring ? <div className="auth-dialog-restore" aria-busy={!restoreError}>
        {restoreError ? <>
          <div className="auth-dialog-alert" role="alert">{restoreError}</div>
          <p>原登录凭证仍保留在本机。可以重试连接，或改用其他账号。</p>
          <div className="modal-actions">
            {onUseAnotherAccount && <button type="button" className="btn btn-ghost" onClick={() => void onUseAnotherAccount()}>使用其他账号</button>}
            <button type="button" className="btn btn-primary" onClick={onRetryRestore}>重试连接</button>
          </div>
        </> : <><div className="spin-icon" /><p>正在恢复原账号，请稍候。</p></>}
      </div> : view === 'portal' ? <div className="auth-dialog-portal">
        <div className="auth-dialog-portal-copy">
          <b>使用一探统一账号</b>
          <p>登录、注册和找回密码都在一探账号门户完成。APP 会打开系统浏览器，完成后自动返回。</p>
          <small>一探门户凭证不会保存在 WebView、本机运行时会话或 CLI 中。</small>
        </div>
        {submitting && <div className="auth-dialog-browser-status" role="status" aria-live="polite">
          <span className="spin-icon" aria-hidden="true" />
          <span><b>等待浏览器完成登录</b><small>请保留此窗口；登录会在 3 分钟后自动超时。</small></span>
        </div>}
        {serverError && <div className="auth-dialog-alert" role="alert">{serverError}</div>}
        <button className="btn btn-primary auth-dialog-submit" type="button" disabled={submitting} autoFocus onClick={() => void authenticate()}>
          {submitting ? '浏览器登录进行中…' : '使用一探账号登录或注册'}
        </button>
        <div className="auth-dialog-portal-actions">
          {submitting
            ? <button type="button" onClick={close}>取消本次登录</button>
            : <>
              <button type="button" onClick={() => void openAccountHelp()}>忘记密码？前往一探账号门户</button>
              <button type="button" className="auth-dialog-legacy-entry" onClick={() => switchView('legacy-migration')}>已有旧 SkillHub 账号？迁移账号</button>
            </>}
        </div>
      </div> : <form className="auth-dialog-form auth-dialog-legacy" onSubmit={(event) => void migrateLegacyAccount(event)} noValidate>
        <div className="auth-dialog-portal-copy">
          <b>迁移旧 SkillHub 账号</b>
          <p>先验证原账号，再立即打开一探门户完成绑定。新账号注册仍只在一探门户进行。</p>
        </div>
        <label className={errors.email ? 'has-error' : ''}>
          <span>原账号邮箱</span>
          <input type="email" autoFocus value={email} onChange={(event) => { setEmail(event.target.value); setErrors((current) => ({ ...current, email: undefined })); setServerError(null) }} autoComplete="email" inputMode="email" placeholder="name@example.com" aria-invalid={Boolean(errors.email)} />
          {errors.email && <small role="alert">{errors.email}</small>}
        </label>
        <label className={errors.password ? 'has-error' : ''}>
          <span>原账号密码</span>
          <input type="password" value={password} onChange={(event) => { setPassword(event.target.value); setErrors((current) => ({ ...current, password: undefined })); setServerError(null) }} autoComplete="current-password" minLength={6} maxLength={128} aria-invalid={Boolean(errors.password)} />
          {errors.password ? <small role="alert">{errors.password}</small> : <em>只用于本次旧账号迁移验证，不会作为一探账号密码保存。</em>}
        </label>
        {linkingLegacy && <div className="auth-dialog-browser-status" role="status" aria-live="polite">
          <span className="spin-icon" aria-hidden="true" />
          <span><b>旧账号已验证，等待浏览器绑定</b><small>请选择要绑定的一探账号；完成前不会写入本机会话。</small></span>
        </div>}
        {serverError && <div className="auth-dialog-alert" role="alert">{serverError}</div>}
        <button className="btn btn-primary auth-dialog-submit" type="submit" disabled={submitting}>
          {linkingLegacy ? '浏览器绑定进行中…' : submitting ? '正在验证旧账号…' : '验证旧账号并迁移'}
        </button>
        <div className="auth-dialog-portal-actions">
          {linkingLegacy
            ? <button type="button" onClick={close}>取消本次迁移</button>
            : <button type="button" disabled={submitting} onClick={() => switchView('portal')}>返回一探账号登录</button>}
        </div>
      </form>}
    </div>
  </FocusTrapDialog>
}
