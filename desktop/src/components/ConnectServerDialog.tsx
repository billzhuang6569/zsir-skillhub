import { useEffect, useRef, useState, type ReactNode } from 'react'
import { openUrl } from '@tauri-apps/plugin-opener'
import { ApiError, sameSpace } from '../lib/api.js'
import { authErrorMessage } from '../lib/auth.js'
import { authState, cancelYitanPortalAuth, startYitanPortalAuth, migrationRun } from '../lib/tauri.js'
import { useMigrationFlow } from './MigrationDialog.js'
import { useStore } from '../store/index.js'
import {
  authenticateSelfhost, connectionChecks, CONNECTION_ITEMS, displayServerAddress,
  SELF_HOST_DOCS, SETUP_CODE_DOCS, SPACE_SWITCH_VIEW_KEY, setupErrorMessage,
  rebindOutcome, switchSpace, testSpaceConnection, verifyReboundLogin, type ConnectionReport,
} from '../lib/spaces.js'
import FocusTrapDialog from './FocusTrapDialog.js'
import DocHelp from './DocHelp.js'
import { connectionHelpTopic } from '../lib/docs.js'
import type { SpaceHandle } from '../lib/tauri.js'
import { Icon } from './Icon.js'
import { toast } from './Toast.js'
import './AuthDialog.css'
import './ConnectServerDialog.css'
import { cancelCatalogLogin, catalogSessionStatus, startCatalogLogin, type CatalogSessionStatus } from '../lib/tauri.js'
import { catalogSwitchChoice } from '../lib/catalog-login.js'

export function ConnectionStatus({ children, success = false }: { children: ReactNode; success?: boolean }) {
  return <div className={`connection-alert connection-status${success ? ' success' : ''}`} role="status">{children}</div>
}

export function ConnectionChecklist({ report, testing = false }: { report: ConnectionReport | null; testing?: boolean }) {
  if (testing) return (
    <ConnectionStatus>
      <span className="spin-icon" aria-hidden="true" />正在检查服务器连接…
    </ConnectionStatus>
  )
  if (!report) return null
  return (
    <ul className="connection-checklist" aria-label="连接检查" aria-live="polite">
      {connectionChecks(report).map((check, index) => (
        <li key={check.item} data-state={check.state}>
          <span className="connection-check-icon" aria-label={check.state === 'pass' ? '通过' : check.state === 'blocked' ? '已阻止' : check.state === 'unavailable' ? '尚未验证' : '需要处理'}>
            <Icon name={check.state === 'pass' ? 'check' : check.state === 'blocked' ? 'circle-x' : check.state === 'unavailable' ? 'info' : 'circle-alert'} size={16} />
          </span>
          <b>{CONNECTION_ITEMS[index][1]}</b>
          <span>{check.message}</span>
        </li>
      ))}
    </ul>
  )
}

export function DeploymentHelp({ setup = false }: { setup?: boolean }) {
  const [error, setError] = useState<string | null>(null)
  return (
    <span className={setup ? 'connection-help connection-caption' : 'connection-help'}>
      <button
        type="button"
        className="connection-link"
        onClick={() => {
          void openUrl(setup ? SETUP_CODE_DOCS : SELF_HOST_DOCS)
            .catch(() => setError('无法打开系统浏览器，请稍后重试'))
        }}
      >
        {setup ? '找不到初始化码？查看部署文档' : '查看自部署教程'}
        <Icon name="external-link" size={12} />
      </button>
      {error && <span role="alert">{error}</span>}
    </span>
  )
}

type Props = {
  target: string
  initialReport?: ConnectionReport | null
  onClose: () => void
  onConnected?: (space: SpaceHandle) => void
  lockAddress?: boolean
  teamInvite?: boolean
  migrationSource?: boolean
}

export default function ConnectServerDialog({ target, initialReport = null, onClose, onConnected, lockAddress = false, teamInvite = false, migrationSource = false }: Props) {
  const migration = useMigrationFlow()
  const selfhost = target !== 'official' && target !== 'local'
  const [address, setAddress] = useState(displayServerAddress(target))
  const [report, setReport] = useState(initialReport)
  const [asNew, setAsNew] = useState(false)
  const [catalog, setCatalog] = useState<CatalogSessionStatus>({ signedIn: false })
  const [retainCatalog, setRetainCatalog] = useState(true)
  const [otherAccount, setOtherAccount] = useState(false)
  const sourceProfile = useStore(s => s.activeSpace?.spaceId === 'official' ? 'official' : s.activeSpace?.spaceId === 'local' ? 'local' : 'selfhost')
  const choice = catalogSwitchChoice(sourceProfile, target === 'official' || report?.deployment?.profile === 'official' ? 'official' : selfhost ? 'selfhost' : 'local', catalog.signedIn, migrationSource)
  useEffect(() => { let active = true; void catalogSessionStatus().then(value => { if (active) setCatalog(value) }).catch(() => {}); return () => { active = false } }, [])
  const [testing, setTesting] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [email, setEmail] = useState('')
  const [rebindMessage, setRebindMessage] = useState<string | null>(null)
  const [password, setPassword] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [code, setCode] = useState('')
  const [inviteCode, setInviteCode] = useState('')
  const [register, setRegister] = useState(false)
  const [initialized, setInitialized] = useState(false)
  const initializedRef = useRef(false)
  const attempt = useRef(0)
  const closed = useRef(false)
  const busyRef = useRef(false)
  const retaining = useRef(false)
  const returnToSettings = useRef(useStore.getState().view === 'settings')
  const setup = selfhost && report?.checks.some(check => check.item === 'instance' && check.state === 'actionRequired') === true
  const registration = report?.info?.auth?.registration ?? 'closed'
  const allowed = !selfhost || Boolean(report?.deployment && !report.error)
  const rebind = !asNew && !migrationSource ? report?.rebind : null

  useEffect(() => {
    closed.current = false
    if (selfhost && target.trim() && !initialReport) void test()
    return () => {
      closed.current = true
      attempt.current += 1
      void cancelYitanPortalAuth().catch(() => {})
      if (retaining.current) void cancelCatalogLogin().catch(() => {})
    }
  }, [])

  const close = (): void => {
    closed.current = true
    attempt.current += 1
    void cancelYitanPortalAuth().catch(() => {})
    if (retaining.current) void cancelCatalogLogin().catch(() => {})
    if (!busyRef.current) onClose()
  }
  const test = async (): Promise<void> => {
    const id = ++attempt.current
    setTesting(true)
    setError(null)
    setRebindMessage(null)
    setReport(null)
    setAsNew(false)
    try {
      const result = await testSpaceConnection(address)
      if (id === attempt.current) {
        setReport(result)
        setRegister(false)
      }
    } catch (failure: unknown) {
      if (id === attempt.current) setError(setupErrorMessage(failure))
    } finally {
      if (id === attempt.current) setTesting(false)
    }
  }
  const submit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (busyRef.current || testing || !allowed) return
    busyRef.current = true
    setBusy(true)
    setError(null)
    const fields = {
      email: email.trim().toLowerCase(),
      password,
      ...(setup || register ? { displayName: displayName.trim() } : {}),
      ...(setup ? { code } : {}),
      ...(register && registration === 'invite' ? { inviteCode } : {}),
    }
    setPassword('')
    setCode('')
    setInviteCode('')
    try {
      const source = await authState()
      if (source.pending || closed.current) return
      const result = await switchSpace(source, selfhost ? address : target, async candidate => {
        if (closed.current) throw new Error('已取消连接')
        if (target === 'official' || report?.deployment?.profile === 'official') {
          const product = await startYitanPortalAuth('login', null, candidate, otherAccount)
          if (!migrationSource && catalog.user && product.user.id !== catalog.user.id) toast('商店登录与当前官方账号不同', 'warn')
        } else {
          await authenticateSelfhost(candidate, setup ? 'setup' : register ? 'register' : 'login', fields, () => {
            initializedRef.current = true
            setInitialized(true)
            setReport(current => current ? {
              ...current,
              checks: current.checks.map(check => check.item === 'instance'
                ? { ...check, state: 'pass', message: '已初始化' }
                : check),
            } : current)
          })
        }
        if (closed.current) throw new Error('已取消连接')
      }, async (from, candidate) => {
        if (closed.current) return '取消'
        if (rebind) return '只切换'
        return migration.begin(from, candidate, migrationSource)
      }, Boolean(rebind))
      if (migration.migrationId.current) {
        await migrationRun(migration.migrationId.current).catch(() => {
          toast('迁移尚未开始，可在“账号与数据”中继续', 'warn')
        })
        window.dispatchEvent(new Event('skillhub-migration-refresh'))
      }
      if (result) {
        if (!migrationSource && !rebind && choice === 'retain' && retainCatalog && source.userId) {
          retaining.current = true
          await startCatalogLogin(source.userId).catch((failure: unknown) => { toast(`已切换，商店尚未登录：${String(failure)}`, 'warn') }).finally(() => { retaining.current = false })
        }
        if (rebind) {
          const state = await authState()
          if (state.pending || (!sameSpace(state, result) && (state.spaceId !== result.spaceId || state.userId))) {
            throw new ApiError('aborted', '空间已切换')
          }
          const verification = rebind.active && source.userId && state.userId === source.userId
            ? await verifyReboundLogin(result, source.userId) : undefined
          const outcome = rebindOutcome({ active: rebind.active, beforeUserId: source.userId,
            afterUserId: state.userId, origin: report?.origin ?? address, verification })
          if (closed.current) return
          setReport(current => current ? { ...current, rebind: null } : current)
          if (outcome.action === 'login') {
            setRegister(false)
            setRebindMessage(outcome.message)
            useStore.getState().dismissAuthPrompt()
            window.dispatchEvent(new Event('skillhub-space-refresh'))
          } else {
            onConnected?.(result)
            toast(outcome.message)
            closed.current = true
          }
          return
        }
        if (returnToSettings.current) sessionStorage.setItem(SPACE_SWITCH_VIEW_KEY, 'settings')
        onConnected?.(result)
        window.location.reload()
      } else {
        onClose()
      }
    } catch (failure: unknown) {
      if (!closed.current) {
        setError(setup && !initializedRef.current ? setupErrorMessage(failure) : authErrorMessage(failure))
        if (failure instanceof ApiError && failure.status === 409) {
          setReport(await testSpaceConnection(address).catch(() => null))
          setRegister(false)
        }
      }
    } finally {
      fields.password = ''
      if ('code' in fields) fields.code = ''
      if ('inviteCode' in fields) fields.inviteCode = ''
      busyRef.current = false
      setBusy(false)
      if (closed.current) onClose()
    }
  }
  const title = migrationSource ? '连接迁移来源' : rebind ? '这是你之前的实例' : selfhost ? '连接自部署服务器' : target === 'local' ? '切换到仅本机？' : '切换到一探官方'
  return (
    <>
    <FocusTrapDialog className="modal-layer auth-dialog-layer" label={title} onEscape={close} closeOnBackdrop>
      <div className="modal-card connect-server-dialog" onPointerDown={event => event.stopPropagation()}>
        <div className="modal-head">
          <div><span className="eyebrow">服务与账号</span><h2>{title}</h2></div>
          <button type="button" className="ico-btn" onClick={close} aria-label="关闭连接窗口"><Icon name="x" size={16} /></button>
        </div>
        <form className="connection-form" onSubmit={event => void submit(event)}>
          <div className="connection-dialog-body">
            {teamInvite && <p className="connection-caption">登录后将继续加入团队。</p>}
            {!selfhost && (
              <p className="modal-copy">
                {migrationSource ? '读取来源中的 Skill 后恢复当前账号，不切换服务。' : target === 'local'
                  ? '当前空间的数据会保留在这台电脑上，随时可以切回。仅本机保留导入、版本、安装和个人钥匙；同步、团队、AI 分析和生成头像需要服务器。'
                  : '需要用一探账号登录。当前空间的数据会保留，随时可以切回。'}
              </p>
            )}
            {selfhost && !rebind && <p className="connection-caption">{migrationSource ? '只读取来源数据，完成后恢复当前账号。' : '原空间数据保留，登录后可选择迁移 Skill。'}</p>}
            {choice === 'reuse' && <div className="connection-field"><p className="connection-caption">将继续使用已登录的一探账号 {catalog.user?.displayName}。</p><label className="connection-check"><input type="checkbox" checked={otherAccount} disabled={busy} onChange={e => setOtherAccount(e.target.checked)} />改用其他一探账号</label></div>}
            {choice === 'retain' && <label className="connection-check"><input type="checkbox" checked={retainCatalog} disabled={busy} onChange={e => setRetainCatalog(e.target.checked)} />保留此一探账号用于商店发布</label>}
            {selfhost && (
              <>
                <div className="connection-field">
                  <div className="connection-label-row">
                    <label htmlFor="connect-server-address">服务器地址</label>
                    <DeploymentHelp />
                  </div>
                  <div className="connection-address">
                    <input
                      id="connect-server-address"
                      className="form-input"
                      autoFocus
                      value={address}
                      readOnly={lockAddress}
                      disabled={busy}
                      onChange={event => {
                        attempt.current += 1
                        setAddress(event.target.value)
                        setInitialized(false)
                        initializedRef.current = false
                        setReport(null)
                        setAsNew(false)
                        setTesting(false)
                        setError(null)
                        setRebindMessage(null)
                        setPassword('')
                        setCode('')
                        setInviteCode('')
                      }}
                    />
                    <button type="button" className="btn btn-ghost" disabled={busy || testing || !address.trim()} onClick={() => void test()}>
                      {testing ? '测试中…' : '重新测试'}
                    </button>
                  </div>
                </div>
                <ConnectionChecklist report={report} testing={testing} />
                {report?.error && <div role="alert" className="auth-dialog-alert connection-alert">{report.error.message}<DocHelp topic={connectionHelpTopic(report.error.code)} label="查看解决办法" /></div>}
              </>
            )}
            {initialized && (
              <ConnectionStatus success>
                实例已初始化。取消连接不会撤销服务器端已完成的初始化；可使用管理员账号登录。
              </ConnectionStatus>
            )}
            {rebindMessage && <ConnectionStatus>{rebindMessage}</ConnectionStatus>}
            {error && <div className="auth-dialog-alert connection-alert" role="alert">{error}<DocHelp topic={setup ? 'setupError' : 'connectionError'} label="查看解决办法" /></div>}
            {rebind && <p className="modal-copy">{report?.origin ?? address} 证明自己就是你之前在 {rebind.previousOrigin} 使用的实例。{rebind.active ? '改用新地址后，数据和登录状态保持不变。' : '改用新地址后，数据保持不变，需要重新登录。'}</p>}
            {selfhost && allowed && !rebind && report?.deployment?.profile !== 'official' && (
              <>
                {setup && (
                  <div className="connection-field">
                    <label htmlFor="connect-setup-code">初始化码</label>
                    <input id="connect-setup-code" className="form-input" required value={code} disabled={busy} autoComplete="off" onChange={event => setCode(event.target.value)} />
                    <p className="connection-caption">初始化码显示在启动服务器的终端里，30 分钟内有效。重启服务器会换一个新码。</p>
                    <DeploymentHelp setup />
                  </div>
                )}
                <div className={setup || register ? 'connection-fields-pair' : 'connection-field'}>
                  <label className="connection-field">
                    {setup ? '管理员邮箱' : '邮箱'}
                    <input className="form-input" required type="email" autoComplete="email" disabled={busy} value={email} onChange={event => setEmail(event.target.value)} />
                  </label>
                  {(setup || register) && (
                    <label className="connection-field">
                      显示名称
                      <input className="form-input" required maxLength={50} autoComplete="name" disabled={busy} value={displayName} onChange={event => setDisplayName(event.target.value)} />
                    </label>
                  )}
                </div>
                <label className="connection-field">
                  密码
                  <input
                    className="form-input"
                    required type="password" minLength={6} maxLength={128}
                    autoComplete={setup || register ? 'new-password' : 'current-password'}
                    disabled={busy} value={password} onChange={event => setPassword(event.target.value)}
                  />
                </label>
                {!setup && register && registration === 'invite' && (
                  <label className="connection-field">
                    注册邀请码
                    <input className="form-input" required disabled={busy} autoComplete="off" value={inviteCode} onChange={event => setInviteCode(event.target.value)} />
                  </label>
                )}
                {!setup && (
                  <div className="connection-field">
                    <p className="connection-caption">忘记密码？请联系实例管理员通过服务器 CLI 重置。</p>
                    {!migrationSource && registration !== 'closed' && (
                      <button
                        type="button"
                        className="connection-link"
                        disabled={busy}
                        onClick={() => {
                          setRegister(!register)
                          setPassword('')
                          setError(null)
                        }}
                      >{register ? '已有账号？登录' : '注册账号'}</button>
                    )}
                  </div>
                )}
              </>
            )}
            {busy && (
              <ConnectionStatus>
                <span className="spin-icon" aria-hidden="true" />
                {closed.current ? '正在取消并恢复原空间…' : '正在连接，请稍候…'}
              </ConnectionStatus>
            )}
          </div>
          <div className="modal-actions">
            {rebind ? <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setAsNew(true)}>作为新实例</button> : <button type="button" className="btn btn-ghost" onClick={close}>取消</button>}
            <button type="submit" className="btn btn-primary" disabled={busy || testing || !allowed}>
              {rebind ? '改用新地址' : target === 'local' ? migrationSource ? '读取本机 Skill' : '切换'
                : target === 'official' || report?.deployment?.profile === 'official' ? '使用一探账号登录'
                : setup ? '创建管理员并连接' : register ? '注册并连接' : '登录并连接'}
            </button>
          </div>
        </form>
      </div>
    </FocusTrapDialog>
    {migration.dialog}
    </>
  )
}
