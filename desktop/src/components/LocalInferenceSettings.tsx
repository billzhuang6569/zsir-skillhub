import { useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { sameSpace } from '../lib/api.js'
import { localInferenceCancel, localInferenceProbe, localInferenceRun, type LocalInferenceAgent, type LocalInferenceProbe, type LocalInferenceProfile, type SpaceHandle } from '../lib/tauri.js'
import { canTestLocalInference, localInferenceError, localInferenceStatus, localWorkerCounts, localWorkerSnapshot, localWorkerText, subscribeLocalWorker } from '../lib/local-inference.js'
import { useStore } from '../store/index.js'

export default function LocalInferenceSettings({ space, agent, onAgent, autoAnalyze = true, onAutoAnalyze = () => {} }: { space: SpaceHandle; agent: LocalInferenceAgent; onAgent: (agent: LocalInferenceAgent) => void; autoAnalyze?: boolean; onAutoAnalyze?: (enabled: boolean) => void }) {
  const userId = useStore(state => state.currentUser?.id) ?? ''
  const worker = useSyncExternalStore(subscribeLocalWorker, () => localWorkerSnapshot(space, userId), () => null)
  const canResume = !autoAnalyze || (worker?.state === 'paused' && worker.pausedReason === 'INTERRUPTED')
  const [probes, setProbes] = useState<LocalInferenceProbe[]>([])
  const [busy, setBusy] = useState<'probe' | 'test' | null>(null)
  const [error, setError] = useState('')
  const [result, setResult] = useState<{ result: LocalInferenceProfile; elapsedMs: number } | null>(null)
  const active = useRef<string | null>(null)
  const mounted = useRef(true)
  const owner = useRef(useStore.getState().currentUser?.id)
  const current = (id: string): boolean => mounted.current && active.current === id
    && sameSpace(useStore.getState().activeSpace, space) && useStore.getState().currentUser?.id === owner.current
  // Establish ownership before the first click, including StrictMode's mount
  // replay. A passive mount cleanup must not cancel an already-started probe.
  useLayoutEffect(() => {
    mounted.current = true
    owner.current = userId
    setBusy(null); setProbes([]); setResult(null); setError('')
    return () => {
      mounted.current = false
      const id = active.current
      active.current = null
      if (id) void localInferenceCancel(space, id).catch(() => {})
    }
  }, [space.spaceId, space.generation, userId])
  const run = async (kind: 'probe' | 'test'): Promise<void> => {
    if (active.current || (kind === 'test' && !canTestLocalInference(probes, agent, Boolean(busy)))) return
    const id = crypto.randomUUID()
    active.current = id; setBusy(kind); setError(''); setResult(null)
    try {
      if (kind === 'probe') {
        setProbes([])
        const response = await localInferenceProbe(space, id)
        if (!current(id) || !sameSpace(response.space, space)) return
        setProbes(response.probes)
        const usable = response.probes.find(probe => probe.available)
        if (usable && !response.probes.some(probe => probe.agent === agent && probe.available)) onAgent(usable.agent)
      } else {
        const response = await localInferenceRun(space, id, agent)
        if (current(id) && sameSpace(response.space, space)) setResult(response)
      }
    } catch (failure: unknown) { if (current(id)) setError(localInferenceError(failure)) }
    finally { if (mounted.current && active.current === id) { active.current = null; setBusy(null) } }
  }
  return <div className="instance-form" aria-label="本机 Agent 检测">
    <div className="settings-row">
      <div className="settings-row-info"><b>自动分析</b><span role="status">{localWorkerText(worker, autoAnalyze)}</span><span>{localWorkerCounts(worker)}</span></div>
      <button type="button" className="btn btn-ghost" onClick={() => onAutoAnalyze(canResume)}>{canResume ? '继续' : '暂停自动分析'}</button>
    </div>
    <p className="connection-caption">自动分析会消耗你自己的 Claude 订阅额度，脱敏后的 SKILL.md 会发送到 Anthropic 云端；只在 APP 打开时进行。</p>
    <p className="connection-caption">头像由实例使用 fal.ai 生成，费用由实例承担；本机只编写提示词。编写提示词也会消耗你的 Claude 订阅额度，脱敏后的名称、描述、场景与风格数据会发送到 Anthropic 云端。</p>
    <p className="connection-caption">检测会执行一次最小分析请求。测试使用固定示例 Skill，不读取你的 Skill 文件。CLI 不提供模型列表，使用订阅默认模型。</p>
    {(['claude', 'codex'] as const).map(key => {
      const probe = probes.find(item => item.agent === key)
      return <div className="settings-row" key={key}>
        <div className="settings-row-info"><b>{key === 'claude' ? 'Claude Code' : 'Codex'}{probe?.version ? ` · ${probe.version}` : ''}</b>
          <span>{probe ? probe.available ? '版本、登录、最小调用与隔离能力检查通过。' : localInferenceError(probe.reason) : '等待检测'}</span>
        </div>
        <span className={`inline-status ${probe?.available ? 'online' : 'checking'}`}>{probe ? localInferenceStatus(probe) : busy === 'probe' ? '检测中…' : '未检测'}</span>
      </div>
    })}
    {probes.some(probe => probe.available) && <label>使用的 CLI<select className="form-input" value={agent} disabled={Boolean(busy)} onChange={event => onAgent(event.target.value as LocalInferenceAgent)}>
      {probes.filter(probe => probe.available).map(probe => <option key={probe.agent} value={probe.agent}>{probe.agent === 'claude' ? 'Claude Code' : 'Codex'}</option>)}
    </select></label>}
    <div className="instance-actions">
      <button type="button" className="btn btn-ghost" disabled={Boolean(busy)} onClick={() => void run('probe')}>{busy === 'probe' ? '检测中…' : '重新检测'}</button>
      <button type="button" className="btn btn-ghost" disabled={!canTestLocalInference(probes, agent, Boolean(busy))} onClick={() => void run('test')}>{busy === 'test' ? '测试中…' : '测试'}</button>
      {busy && <button type="button" className="btn btn-ghost" onClick={() => { if (active.current) void localInferenceCancel(space, active.current).catch(failure => { if (mounted.current) setError(localInferenceError(failure)) }) }}>取消</button>}
    </div>
    {error && <p role="alert" className="inline-status offline">{error}</p>}
    {result && <div role="status"><b>测试成功 · 用时 {(result.elapsedMs / 1000).toFixed(2)} 秒 · {result.result.displayName}</b><p>{result.result.description}</p><p className="connection-caption">{result.result.category} · {result.result.labels.join('、')}</p></div>}
  </div>
}
