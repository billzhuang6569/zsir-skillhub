import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { readPreference, writePreference, useStore } from '../store/index.js'
import { completionKey, GUIDE_PROGRESS_KEY, GUIDE_STEPS, nextGuideStep, onboardingKind, restoreGuideProgress, type GuideStep } from '../lib/onboarding.js'
import { onboardingEvidence, getUnmanagedAgentSkills, localInferenceProbe, localInferenceCancel, type UnmanagedSkill } from '../lib/tauri.js'
import { localInferenceError } from '../lib/local-inference.js'
import { refreshAgentCapabilities } from '../lib/agent-detection.js'
import { hadLegacySession } from '../lib/auth.js'
import { useSpaceCapabilities } from '../lib/use-space-capabilities.js'
import ConnectServerDialog from './ConnectServerDialog.js'
import FocusTrapDialog from './FocusTrapDialog.js'
import DocHelp from './DocHelp.js'
import FeatureTour from './FeatureTour.js'
import './Onboarding.css'

const TITLES: Record<GuideStep, string> = { mode: '选择使用方式', agents: '发现本机 Agent', ai: 'AI 与头像', tour: '认识 SkillHub', done: '准备好了' }

export default function Onboarding() {
  const space = useStore(state => state.activeSpace)
  const pending = useStore(state => state.spacePending)
  const auth = useStore(state => state.authStatus)
  const user = useStore(state => state.currentUser)
  const agents = useStore(state => state.agentCapabilities)
  const caps = useSpaceCapabilities()
  const [step, setStep] = useState<GuideStep | null>(null)
  const [upgrade, setUpgrade] = useState(false)
  const [connection, setConnection] = useState<string | null>(null)
  const [selfhost, setSelfhost] = useState(false)
  const [noServer, setNoServer] = useState(false)
  const [paused, setPaused] = useState(false)
  const [unmanaged, setUnmanaged] = useState<UnmanagedSkill[] | null>(null)
  const [scanError, setScanError] = useState(false)
  const [probeMessage, setProbeMessage] = useState<string | null>(null)
  const [probing, setProbing] = useState(false)
  const probeId = useRef<string | null>(null)
  const initialized = useRef(false)
  const admin = caps.profile === 'selfhost' && user?.marketplaceRole === 'admin'
  const probeClaude = async (): Promise<void> => {
    if (!space || !admin || probeId.current) return
    const id = crypto.randomUUID()
    const owner = user?.id
    const current = (): boolean => {
      const state = useStore.getState()
      return probeId.current === id && state.activeSpace?.spaceId === space.spaceId
        && state.activeSpace.generation === space.generation && state.currentUser?.id === owner
        && state.currentUser?.marketplaceRole === 'admin'
    }
    probeId.current = id
    setProbing(true)
    setProbeMessage(null)
    try {
      const result = await localInferenceProbe(space, id)
      if (!current()) return
      const claude = result.probes.find(probe => probe.agent === 'claude')
      setProbeMessage(claude?.available ? 'Claude Code 可用，可在 AI 设置中启用本机分析。' : localInferenceError(claude?.reason ?? 'NOT_INSTALLED'))
    } catch { if (current()) setProbeMessage('检测失败，请稍后重试。') }
    finally { if (probeId.current === id) { probeId.current = null; setProbing(false) } }
  }
  useLayoutEffect(() => {
    setProbeMessage(null)
    setProbing(false)
    return () => {
      const id = probeId.current
      probeId.current = null
      if (id && space) void localInferenceCancel(space, id).catch(() => {})
    }
  }, [space?.spaceId, space?.generation, user?.id, admin, step, paused])
  const persist = (next: GuideStep | null, spaceId = space?.spaceId): void => {
    writePreference(GUIDE_PROGRESS_KEY, next ? JSON.stringify({ step: next, spaceId }) : '')
    setStep(next)
  }
  const advance = (): void => {
    if (!step || !space) return
    if (step !== 'ai' || admin) writePreference(completionKey(step, space.spaceId), '1')
    if (step === 'done') writePreference(completionKey('completed', space.spaceId), '1')
    persist(nextGuideStep(step, admin))
  }
  useEffect(() => {
    const replay = (): void => {
      setUpgrade(false); setPaused(false); setSelfhost(false); setNoServer(false)
      persist('mode', useStore.getState().activeSpace?.spaceId)
    }
    window.addEventListener('skillhub-show-onboarding', replay)
    return () => window.removeEventListener('skillhub-show-onboarding', replay)
  }, [])
  useEffect(() => {
    if (!space || pending || auth === 'restoring' || initialized.current) return
    let active = true
    void onboardingEvidence().then(evidence => {
      if (!active || initialized.current) return
      initialized.current = true
      const progress = restoreGuideProgress(readPreference(GUIDE_PROGRESS_KEY), space.spaceId, admin)
      if (progress) { setStep(progress); return }
      const kind = onboardingKind({ ...evidence, hasSession: evidence.hasSession || hadLegacySession() || Boolean(user),
        completed: readPreference(completionKey('completed', space.spaceId)) === '1', introSeen: readPreference(completionKey('intro', space.spaceId)) === '1' })
      if (kind === 'welcome') persist('mode')
      if (kind === 'upgrade') setUpgrade(true)
    }).catch(() => { /* Unreadable evidence must never classify an existing installation as new. */ })
    return () => { active = false }
  }, [space, pending, auth, user])
  useEffect(() => {
    if (!space || pending || auth === 'restoring' || step !== 'ai') return
    const normalized = restoreGuideProgress(readPreference(GUIDE_PROGRESS_KEY), space.spaceId, admin)
    if (normalized !== 'ai') persist('tour')
  }, [space, pending, auth, admin, step])
  useEffect(() => {
    if (step !== 'agents') return
    let active = true
    void refreshAgentCapabilities()
    void getUnmanagedAgentSkills().then(value => { if (active) setUnmanaged(value.filter(skill => skill.name !== 'yitan-skillhub-manager')) })
      .catch(() => { if (active) setScanError(true) })
    return () => { active = false }
  }, [step])
  if (!space) return null
  if (upgrade) return <FocusTrapDialog className="modal-layer" label="开源与自部署" onEscape={() => {
    writePreference(completionKey('intro', space.spaceId), '1'); setUpgrade(false)
  }}><div className="modal-card onboarding-card"><div className="modal-head"><h2>开源与自部署</h2></div>
    <p className="modal-copy">SkillHub 现在支持仅本机、一探官方和自部署。你的数据、登录和当前空间保持不变，随时可以在设置中了解和切换。</p>
    <div className="modal-actions"><DocHelp topic="local" label="了解自部署" className="btn btn-ghost" /><button autoFocus className="btn btn-primary" onClick={() => {
      writePreference(completionKey('intro', space.spaceId), '1'); setUpgrade(false)
    }}>知道了</button></div></div></FocusTrapDialog>
  if (!step) return null
  if (connection !== null) return <ConnectServerDialog target={connection} onClose={() => setConnection(null)} onConnected={destination => {
    // ConnectServerDialog reloads after committing; save the destination step first.
    writePreference(completionKey('mode', destination.spaceId), '1')
    persist('agents', destination.spaceId); setConnection(null)
  }} />
  if (paused) return <div className="onboarding-resume" role="status"><button className="btn btn-primary" onClick={() => setPaused(false)}>继续引导</button></div>
  if (step === 'tour') return <FeatureTour onDone={advance} />
  return <FocusTrapDialog className="modal-layer" label={TITLES[step]} onEscape={advance}>
    <div className="modal-card onboarding-card">
      <div className="modal-head"><div><span className="eyebrow">首次引导 · {GUIDE_STEPS.indexOf(step) + 1} / 5</span><h2>{TITLES[step]}</h2></div></div>
      <div className="onboarding-body">
        {step === 'mode' && <>
          <div className="settings-group">
            {([
              ['official', '一探官方', '登录后同步与团队共享，服务和备份由官方维护。'],
              ['local', '仅本机', '本机导入、版本、安装和个人钥匙；无需服务器。'],
              ['selfhost', '自部署', '使用自己的账号与存储，自行维护服务器、AI 和备份。'],
            ] as const).map(([mode, title, description]) => <div className="settings-row" key={mode}><div className="settings-row-info"><b>{title} {mode === 'official' && <span className="chip chip-accent">推荐</span>} {mode === caps.profile && <span className="chip">当前</span>}</b><span>{description}</span></div>
              <button className="btn btn-ghost btn-sm" disabled={mode === caps.profile} onClick={() => {
                if (mode === 'selfhost') { setSelfhost(true); return }
                setConnection(mode)
              }}>{mode === caps.profile ? '当前' : '选择'}</button></div>)}
          </div>
          <p className="connection-caption">不选择将继续使用一探官方；三种方式都可主动浏览官方商店。</p><DocHelp topic="modes" label="比较三种方式" />
          {selfhost && <div className="settings-group"><div className="settings-row"><b>已经有服务器了吗？</b><button className="btn btn-primary btn-sm" onClick={() => setConnection('')}>有，连接服务器</button><button className="btn btn-ghost btn-sm" onClick={() => setNoServer(true)}>还没有</button></div>
            {noServer && <div className="settings-row"><div className="settings-row-info"><b>可以先在这台电脑上部署一个</b><span>本机部署也需要数据库和备份；也可以先仅管理本机 Skill。</span></div><DocHelp topic="local" label="本机部署文档" /><button className="btn btn-ghost btn-sm" onClick={() => caps.profile === 'local' ? advance() : setConnection('local')}>改选仅本机</button></div>}</div>}
        </>}
        {step === 'agents' && <>
          <div className="settings-group">{agents.filter(agent => agent.detected).map(agent => <div className="settings-row" key={agent.key}><div className="settings-row-info"><b>{agent.name}</b><span>{agent.dir}</span></div><span className="chip">{unmanaged ? `${unmanaged.filter(skill => skill.sources.some(source => source.agentKey === agent.key)).length} 个非受管 Skill` : scanError ? '无法读取目录' : '正在读取…'}</span></div>)}</div>
          {!agents.some(agent => agent.detected) && <p className="connection-caption">暂未发现已安装的 Agent。安装后可在设置中重新检测。</p>}
          <button className="btn btn-ghost" onClick={() => { useStore.getState().setView('skills'); useStore.getState().setSkillTab('local'); setPaused(true) }}>导入已有 Skill</button>
          <p className="connection-caption">在“本地”选择已有 Skill，点击“加入 SkillHub”。</p>
        </>}
        {step === 'ai' && admin && <>
          <p className="connection-caption">默认暂不配置。已有内容和手动导入可以正常使用；AI 接口与 fal.ai 由实例管理员配置。</p>
          {agents.some(agent => agent.detected && agent.key === 'claude') && <><p className="connection-caption">检测到 Claude Code。检测可用性会检查版本、登录与隔离，并发起一次最小调用，消耗少量订阅额度。</p><button className="btn btn-ghost" disabled={probing} onClick={() => void probeClaude()}>{probing ? '正在检测…' : '检测可用性'}</button></>}
          {probeMessage && <p className="inline-status" role="status">{probeMessage}</p>}
          <button className="btn btn-ghost" onClick={() => { useStore.getState().setView('settings'); setPaused(true) }}>打开 AI 与头像设置</button><DocHelp topic="claude" label="本机 Claude Code 说明" className="connection-link" />
        </>}
        {step === 'done' && <><p className="connection-caption">导入第一个 Skill，或去商店找一个试试。所有配置都能稍后在设置中调整。</p>
          <button className="btn btn-ghost" onClick={() => { useStore.getState().setView('skills'); useStore.getState().setSkillTab('local'); advance() }}>导入已有 Skill</button>
          <button className="btn btn-ghost" onClick={() => { useStore.getState().setView('marketplace'); advance() }}>去商店看看</button><DocHelp topic="start" label="阅读使用文档" className="connection-link" /></>}
      </div>
      <div className="modal-actions"><button className="btn btn-ghost" onClick={advance}>{step === 'ai' ? '暂不配置' : '跳过'}</button><button className="btn btn-primary" onClick={advance}>{step === 'done' ? '开始使用' : '下一步'}</button></div>
    </div>
  </FocusTrapDialog>
}
