import { useCallback, useEffect, useRef, useState } from 'react'
import { useStore } from '../store/index.js'
import { currentMediaSpace } from '../lib/tauri.js'
import { sameSpace, apiInstanceOverview } from '../lib/api.js'
import { instanceSummary } from '../lib/instance-settings.js'
import { useSpaceCapabilities } from '../lib/use-space-capabilities.js'
import {
  displayServerAddress, selectedServiceProfile, setupErrorMessage,
  testSpaceConnection, type ConnectionReport,
} from '../lib/spaces.js'
import { ConnectionChecklist, DeploymentHelp } from './ConnectServerDialog.js'
import AccountSettings from './AccountSettings.js'
import DocHelp from './DocHelp.js'
import { connectionHelpTopic } from '../lib/docs.js'

export const SERVICE_CARDS = [
  { profile: 'official', title: '一探官方', tags: ['省心', '推荐'], description: '用一探账号登录，AI、头像和图床由官方提供。' },
  { profile: 'local', title: '仅本机', tags: [], description: '不连接服务器，只管理这台电脑上的 Skill。' },
  { profile: 'selfhost', title: '自部署服务器', tags: ['高级'], description: '连接你自己的 SkillHub Server，可以在这台电脑或云服务器上。' },
] as const

export default function ServiceSettings({ onOpenInstance }: { onOpenInstance?: () => void }) {
  const caps = useSpaceCapabilities()
  const space = useStore(state => state.activeSpace)
  const admin = useStore(state => state.currentUser?.marketplaceRole === 'admin')
  const userId = useStore(state => state.currentUser?.id)
  const [selected, setSelected] = useState(() => selectedServiceProfile(space))
  const [address, setAddress] = useState('')
  const [currentAddress, setCurrentAddress] = useState('')
  const [report, setReport] = useState<ConnectionReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)
  const [summary, setSummary] = useState<string | null>(null)
  const attempt = useRef(0)
  const currentServer = caps.profile === 'selfhost' && Boolean(currentAddress)
    && displayServerAddress(address) === currentAddress
  const showCurrent = selected === caps.profile && (selected !== 'selfhost' || currentServer)
  const showConnectButton = !currentServer && Boolean(report?.deployment) && !report?.error

  useEffect(() => {
    setSummary(null)
    if (!showCurrent || caps.profile !== 'selfhost' || !admin || !space || !userId) return
    let active = true
    void apiInstanceOverview(space).then(value => {
      if (active) setSummary(instanceSummary(value))
    }).catch(() => { if (active) setSummary(null) })
    return () => { active = false }
  }, [showCurrent, caps.profile, admin, space, userId])

  const setTarget = (target: string): void => {
    window.dispatchEvent(new CustomEvent('skillhub-connect-server', { detail: { target, report } }))
  }
  const test = useCallback(async (target: string): Promise<void> => {
    const id = ++attempt.current
    setTesting(true)
    setReport(null)
    setError(null)
    try {
      const next = await testSpaceConnection(target)
      if (id === attempt.current) setReport(next)
    } catch (failure: unknown) {
      if (id === attempt.current) setError(setupErrorMessage(failure))
    } finally {
      if (id === attempt.current) setTesting(false)
    }
  }, [])

  useEffect(() => {
    const resetSelection = (): void => setSelected(selectedServiceProfile(useStore.getState().activeSpace))
    resetSelection()
    window.addEventListener('skillhub-connect-closed', resetSelection)
    return () => window.removeEventListener('skillhub-connect-closed', resetSelection)
  }, [space])

  useEffect(() => {
    if (caps.profile !== 'selfhost') return
    let active = true
    const id = attempt.current
    void currentMediaSpace().then(context => {
      if (!active || !sameSpace(context.space, space)) return
      const origin = displayServerAddress(context.serverBase)
      setCurrentAddress(origin)
      // Do not overwrite an address typed while the current context was loading.
      if (attempt.current !== id) return
      setAddress(origin)
      void test(origin)
    }).catch(failure => {
      if (active && attempt.current === id) setError(setupErrorMessage(failure))
    })
    return () => {
      active = false
      attempt.current += 1
    }
  }, [caps.profile, space, test])
  useEffect(() => () => { attempt.current += 1 }, [])

  return (
    <>
      <p className="settings-label">服务与账号 <DocHelp topic="modes" variant="section" label="三种方式的区别" /></p>
      <section className="settings-group service-settings">
        <div className="service-cards" aria-label="服务选择">
          {SERVICE_CARDS.map(card => (
            <button
              key={card.profile}
              type="button"
              className="service-card"
              aria-pressed={selected === card.profile}
              onClick={() => {
                setSelected(selectedServiceProfile(space, card.profile))
                if (card.profile !== 'selfhost' && card.profile !== caps.profile) setTarget(card.profile)
              }}
            >
              <span className="service-card-heading">
                <b>{card.title}</b>
                <span className="service-card-tags">
                  {card.tags.map(tag => (
                    <span className={`chip${card.profile === 'official' ? ' chip-accent' : ''}`} key={tag}>{tag}</span>
                  ))}
                </span>
              </span>
              <span className="service-card-description">{card.description}</span>
            </button>
          ))}
        </div>
        {selected === 'selfhost' && (
          <div className="service-connection">
            <div className="connection-label-row">
              <label htmlFor="settings-server-address">服务器地址</label><DocHelp topic="connect" variant="inline" label="连接说明" />
              <DeploymentHelp />
            </div>
            <div className="connection-address">
              <input
                id="settings-server-address"
                className="form-input"
                value={address}
                placeholder="http://127.0.0.1:3001"
                onChange={event => {
                  attempt.current += 1
                  setAddress(event.target.value)
                  setReport(null)
                  setTesting(false)
                  setError(null)
                }}
              />
              <button type="button" className={`btn ${showConnectButton ? 'btn-ghost' : 'btn-primary'}`} disabled={testing || !address.trim()} onClick={() => void test(address)}>
                {testing ? '测试中…' : '测试连接'}
              </button>
            </div>
            <p className="connection-caption">可以是这台电脑上的 http://127.0.0.1:端口，也可以是云服务器的 HTTPS 域名。</p>
            <ConnectionChecklist report={report} testing={testing} />
            {(report?.error || error) && <div className="auth-dialog-alert connection-alert" role="alert">{error ?? report?.error?.message}<DocHelp topic={connectionHelpTopic(report?.error?.code)} label="查看解决办法" /></div>}
            {showConnectButton && (
              <div className="settings-row-actions">
                <button type="button" className="btn btn-primary" onClick={() => setTarget(address)}>连接到这台服务器</button>
              </div>
            )}
          </div>
        )}
        {showCurrent && caps.profile !== 'local' && <AccountSettings />}
        {showCurrent && caps.profile === 'selfhost' && admin && <div className="settings-row">
          <div className="settings-row-info"><b>本实例</b><span>{summary ?? '查看成员、注册与邀请、地址与证书、存储和用量。'}</span></div>
          <button type="button" className="btn btn-primary" onClick={onOpenInstance}>打开实例管理</button>
        </div>}
      </section>
    </>
  )
}
