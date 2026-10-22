import { useEffect, useState } from 'react'
import { cancelCatalogLogin, catalogLogout, catalogSessionStatus, startCatalogLogin, type CatalogSessionStatus } from '../lib/tauri.js'
import { catalogSettingsMode } from '../lib/catalog-login.js'
import { useSpaceCapabilities } from '../lib/use-space-capabilities.js'
import { useStore } from '../store/index.js'

export function useCatalogSession() {
  const [session, setSession] = useState<CatalogSessionStatus>({ signedIn: false })
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let active = true
    const refresh = (): void => { void catalogSessionStatus().then(value => { if (active) setSession(value) }).catch(() => { if (active) setSession({ signedIn: false }) }) }
    refresh()
    window.addEventListener('skillhub-catalog-session', refresh)
    return () => { active = false; window.removeEventListener('skillhub-catalog-session', refresh) }
  }, [])
  const login = async (): Promise<boolean> => {
    setBusy(true); setError(null)
    try { setSession(await startCatalogLogin()); window.dispatchEvent(new Event('skillhub-catalog-session')); return true }
    catch (e: unknown) { setError(String(e)); return false }
    finally { setBusy(false) }
  }
  const logout = async (): Promise<void> => {
    setBusy(true); setError(null)
    try { await catalogLogout(); setSession({ signedIn: false }); window.dispatchEvent(new Event('skillhub-catalog-session')) }
    catch (e: unknown) { setError(String(e)) }
    finally { setBusy(false) }
  }
  return { session, error, busy, login, logout }
}
export default function CatalogLogin() {
  const caps = useSpaceCapabilities()
  const { session, error, busy, login, logout } = useCatalogSession()
  const mode = catalogSettingsMode(caps.profile, session.signedIn)
  if (caps.profile === 'official') return null
  return <>
    <div className="settings-row">
      <div className="settings-row-info">
        <b>一探官方商店</b>
        <span>{mode === 'official' ? '商店使用当前一探账号，浏览和安装无需登录。' : caps.profile === 'local' ? '浏览和安装无需一探账号；发布需要连接自部署或一探官方服务器。' : '浏览和安装无需一探账号；发布 Skill 需要登录一探账号，这个登录只用于商店。'}</span>
        {mode === 'signedIn' && session.user && <span>已登录：{session.user.displayName}</span>}
      </div>
      <div className="settings-row-actions">
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => useStore.getState().setView('marketplace')}>打开商店</button>
        {(mode === 'signedIn' || mode === 'signedOut') && <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void (session.signedIn ? logout() : login())}>{busy ? session.signedIn ? '正在退出…' : '等待浏览器登录…' : session.signedIn ? '退出商店登录' : '登录一探账号以发布'}</button>}
        {busy && !session.signedIn && <button type="button" className="btn btn-ghost btn-sm" onClick={() => void cancelCatalogLogin()}>取消登录</button>}
      </div>
    </div>
    {error && <p className="auth-dialog-alert" role="alert">{error}</p>}
  </>
}
