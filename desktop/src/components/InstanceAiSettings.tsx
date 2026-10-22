import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import {
  apiInstanceAi, apiInstanceAiStatus, apiInstanceAiModels, apiInstanceAiPolicy, apiInstanceAiTest, apiInstanceAiSave, apiInstanceAiDelete,
  apiGetMySkills, apiAnalysisPreview,
  type InstanceAiSettings as AiSettings, type AnalysisPreview,
} from '../lib/api.js'
import type { SpaceHandle } from '../lib/tauri.js'
import { AI_PROTOCOLS, aiForm, changeAiForm, aiDraft, canSaveAi, maskedAiKey, instanceError, analysisConfirmation, type AiForm } from '../lib/instance-settings.js'
import { useStore } from '../store/index.js'
import { SegmentedControl } from './SegmentedControl.js'
import ConfirmModal from './ConfirmModal.js'
import { toast } from './Toast.js'
import './InstanceSettings.css'
import { instanceAnalysisTask, startInstanceAnalysis, subscribeInstanceAnalysis } from '../lib/instance-analysis-batch.js'
import { readLocalInferencePreference, saveLocalInferencePreference, setLocalAutoAnalyze, type LocalInferencePreference } from '../lib/local-inference.js'
import LocalInferenceSettings from './LocalInferenceSettings.js'
import DocHelp from './DocHelp.js'

export default function InstanceAiSettings({ space, admin }: { space: SpaceHandle; admin: boolean }) {
  const userId = useStore(state => state.currentUser?.id) ?? ''
  const [local, setLocal] = useState(() => readLocalInferencePreference(space, userId))
  const [settings, setSettings] = useState<AiSettings | null>(null)
  const [configured, setConfigured] = useState<boolean | null>(null)
  const [form, setForm] = useState<AiForm | null>(null)
  const [mode, setMode] = useState<'none' | 'api' | 'local'>(local.enabled ? 'local' : 'none')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [models, setModels] = useState<string[]>([])
  const [privateHosts, setPrivateHosts] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; latencyMs: number } | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [preview, setPreview] = useState<{ groups: string[][]; value: AnalysisPreview } | null>(null)
  const batch = useSyncExternalStore(subscribeInstanceAnalysis, () => instanceAnalysisTask(space), () => null)
  const mounted = useRef(true)
  const revision = useRef(0)
  const install = (value: AiSettings): void => {
    setSettings(value); setForm(aiForm(value)); setConfigured(value.source !== 'none')
    setMode(value.source === 'none' ? readLocalInferencePreference(space, userId).enabled ? 'local' : 'none' : 'api'); setTestResult(value.lastTest)
    setPrivateHosts(value.allowedPrivateHosts.length > 0)
    useStore.setState(state => ({ serverInfo: state.serverInfo?.features && state.serverInfo.features.ai !== (value.source !== 'none') ? { ...state.serverInfo,
      features: { ...state.serverInfo.features, ai: value.source !== 'none' } } : state.serverInfo }))
  }
  const fail = (failure: unknown): void => {
    if (!mounted.current) return
    setError(instanceError(failure))
    if ((failure as { code?: string })?.code === 'SSRF_BLOCKED') setPrivateHosts(true)
    if ((failure as { code?: string })?.code === 'ENV_OVERRIDE' && admin) {
      void apiInstanceAi(space).then(value => { if (mounted.current) install(value) }).catch(() => {})
    }
  }
  const load = async (): Promise<void> => {
    setError('')
    try {
      if (admin) { const value = await apiInstanceAi(space); if (mounted.current) install(value) }
      else { const value = await apiInstanceAiStatus(space); if (mounted.current) { setConfigured(value.configured); setMode(value.configured ? 'api' : readLocalInferencePreference(space, userId).enabled ? 'local' : 'none') } }
    } catch (failure: unknown) { fail(failure) }
  }
  useEffect(() => { mounted.current = true; void load(); return () => { mounted.current = false; revision.current += 1 } }, [])
  useEffect(() => {
    if (!form?.draftToken) return
    const timer = window.setTimeout(() => {
      setForm(previous => previous ? { ...previous, draftToken: null } : previous)
      setError(instanceError({ code: 'TEST_REQUIRED' }))
    }, 600_000)
    return () => window.clearTimeout(timer)
  }, [form?.draftToken])
  const change = (value: Partial<AiForm>): void => {
    revision.current += 1
    setForm(previous => previous ? changeAiForm(previous, value) : previous)
    setTestResult(null); setError('')
  }
  const saveLocal = (value: LocalInferencePreference): boolean => {
    try { saveLocalInferencePreference(space, userId, value); setLocal(value); return true }
    catch { setError('无法保存本机偏好，请检查本机存储权限。'); return false }
  }
  const run = async (action: () => Promise<void>): Promise<void> => {
    if (busy) return
    setBusy(true); setError('')
    try { await action() } catch (failure: unknown) { fail(failure) }
    finally { if (mounted.current) setBusy(false) }
  }
  const test = async (): Promise<void> => {
    if (!form) return
    const current = ++revision.current
    setForm({ ...form, draftToken: null }); setTestResult(null)
    await apiInstanceAiPolicy({ limits: form.limits, allowedPrivateHosts: form.allowedPrivateHosts }, space)
    if (!mounted.current || current !== revision.current) return
    const result = await apiInstanceAiTest(aiDraft(form), space)
    if (!mounted.current || current !== revision.current) return
    setForm(previous => previous ? { ...previous, draftToken: result.draftToken } : previous); setTestResult(result)
  }
  const save = async (): Promise<void> => {
    if (!form || !canSaveAi(form, false)) return
    const draftToken = form.draftToken!
    setForm({ ...form, draftToken: null })
    const value = await apiInstanceAiSave({ ...aiDraft(form), draftToken }, space)
    if (mounted.current) { install(value); toast('AI 配置已保存') }
  }
  const prepare = async (): Promise<void> => {
    const skills = await apiGetMySkills(space)
    if (!mounted.current) return
    if (!skills.length) { toast('还没有可重新分析的 Skill'); return }
    const groups: string[][] = []
    for (let index = 0; index < skills.length; index += 200) groups.push(skills.slice(index, index + 200).map(skill => skill.id))
    const value: AnalysisPreview = { total: 0, eligible: 0, coverable: 0, remaining: { instance: Infinity, user: Infinity } }
    for (const group of groups) {
      const result = await apiAnalysisPreview(group, space)
      if (!mounted.current) return
      value.total += result.total; value.eligible += result.eligible
      value.coverable += result.coverable
      value.remaining.instance = Math.min(value.remaining.instance, result.remaining.instance)
      value.remaining.user = Math.min(value.remaining.user, result.remaining.user)
    }
    value.coverable = Math.min(value.coverable, value.remaining.instance, value.remaining.user)
    setPreview({ groups, value })
  }

  return <>
    <div className="settings-row settings-row-stack instance-ai">
      <div className="settings-row-info"><b>AI 服务</b><span>AI 用于分析 Skill 的用途、生成摘要和标签，也会为头像编写绘图提示词。不配置也能正常导入、编辑和同步 Skill，只是不会被自动分析。</span></div>
      {configured === null && <span className="inline-status checking">正在读取配置…</span>}
      {!admin && configured !== null && <span className={`inline-status ${configured ? 'online' : 'checking'}`}>{configured ? '已配置' : '未配置'}（由实例管理员配置）</span>}
      {admin && settings?.source === 'env' && <>
        <p className="connection-caption">由服务器环境变量配置，修改请编辑服务器配置</p>
        <div className="settings-row"><b>协议</b><span>{AI_PROTOCOLS.find(item => item.value === settings.protocol)?.label}</span></div>
        <div className="settings-row"><b>Base URL</b><span>{settings.baseUrl}</span></div>
        <div className="settings-row"><b>模型</b><span>{settings.model}</span></div>
      </>}
      {configured !== null && <>
        <SegmentedControl className="instance-ai-modes" mode="radiogroup" aria-label="AI 方式" value={mode} options={[
          { value: 'none', label: <><span className="instance-ai-dot" aria-hidden="true" /><span className="settings-row-info"><b>不配置</b><span>Skill 显示“未分析”，保留 SKILL.md 原有信息和你的手动编辑。</span></span><span className="chip">默认</span></>, disabled: busy || (configured && (!admin || settings?.source === 'env')) },
          { value: 'api', label: <><span className="instance-ai-dot" aria-hidden="true" /><span className="settings-row-info"><b>接入 AI 接口</b><span>由你的服务器调用 AI，所有成员共用。</span></span><span className="chip">管理员配置</span></>, disabled: busy || !admin || settings?.source === 'env' },
          { value: 'local', label: <><span className="instance-ai-dot" aria-hidden="true" /><span className="settings-row-info"><b>使用本机 Agent</b><span>用这台电脑上已登录的 Claude Code 分析。</span></span><span className="chip">仅对你生效</span></>, disabled: busy || configured || !userId },
        ]} onChange={value => {
          if (value === 'local' && configured) return
          if (value === 'none' && configured) setDeleting(true)
          else if (value === 'api' || saveLocal({ ...local, enabled: value === 'local' })) { change({}); setMode(value) }
        }} />
        {configured && <p className="connection-caption">实例已配置 AI 接口，由服务器分析</p>}
        {mode === 'local' && <p className="connection-caption"><strong>使用本机 Agent 会消耗你自己的 Claude 订阅额度，并访问供应商云端。</strong><DocHelp topic="claude" variant="inline" label="本机 Claude Code 说明" /></p>}
      </>}
      {/* Keep the runner outside configuration/loading fragments: only mode or identity owns its lifetime. */}
      {mode === 'local' && configured !== true && <LocalInferenceSettings key={`${space.spaceId}:${space.generation}:${userId}`} space={space} agent={local.agent} onAgent={agent => { saveLocal({ ...local, agent }) }} autoAnalyze={local.autoAnalyze} onAutoAnalyze={enabled => {
        try { setLocal(setLocalAutoAnalyze(space, userId, enabled)) }
        catch { setError('无法保存本机偏好，请检查本机存储权限。') }
      }} />}
      {admin && settings && settings.source !== 'env' && form && <>
        {mode === 'api' && <fieldset className="instance-form" disabled={busy}>
          <span className="instance-field-label">协议</span>
          <SegmentedControl mode="radiogroup" aria-label="协议" options={AI_PROTOCOLS.map(item => ({ ...item, disabled: busy }))} value={form.protocol} onChange={protocol => change({ protocol })} />
          <label>Base URL<input className="form-input" value={form.baseUrl} onChange={event => change({ baseUrl: event.target.value })} /></label>
          <p className="connection-caption">这个地址由你的服务器去访问。</p>
          <label>API Key{form.replacingKey ? <input className="form-input" type="password" autoComplete="new-password" value={form.apiKey} onChange={event => change({ apiKey: event.target.value })} />
            : <span className="instance-actions"><span>{maskedAiKey(settings.keyLast4)}</span><button type="button" className="btn btn-ghost btn-sm" onClick={() => change({ replacingKey: true, apiKey: '' })}>更换</button></span>}</label>
          <p className="connection-caption">加密保存在你的服务器上，保存后只显示末 4 位。</p>
          <label htmlFor="instance-ai-model">模型</label><div className="connection-address"><input id="instance-ai-model" className="form-input" list="instance-ai-models" value={form.model} onChange={event => change({ model: event.target.value })} />
            <button type="button" className="btn btn-ghost" onClick={() => void run(async () => {
              const { model: _model, ...draft } = aiDraft(form)
              const result = await apiInstanceAiModels(draft, space)
              if (mounted.current) setModels(result.models)
            })}>获取模型列表</button></div>
          <datalist id="instance-ai-models">{models.map(model => <option key={model} value={model} />)}</datalist>
          <p className="connection-caption">供应商不提供模型列表时，可以直接手填。</p>
          <div className="connection-fields-pair">{(['instanceDaily', 'perUserDaily'] as const).map(key => <label key={key}>{key === 'instanceDaily' ? '实例每日上限' : '每位成员每日上限'}<input className="form-input" type="number" min={0} max={100000} step={1} value={Number.isNaN(form.limits[key]) ? '' : form.limits[key]} onChange={event => change({ limits: { ...form.limits, [key]: event.target.valueAsNumber } })} /></label>)}</div>
          {(privateHosts || form.allowedPrivateHosts.length > 0) && <div className="instance-form"><b>内网允许列表</b><p className="connection-caption">只有在这里列出的内网地址才能被服务器访问</p>
            {form.allowedPrivateHosts.map((host, index) => <div className="connection-address" key={index}><input className="form-input" aria-label={`允许地址 ${index + 1}`} value={host} onChange={event => change({ allowedPrivateHosts: form.allowedPrivateHosts.map((value, i) => i === index ? event.target.value : value) })} /><button type="button" className="btn btn-ghost" onClick={() => change({ allowedPrivateHosts: form.allowedPrivateHosts.filter((_, i) => i !== index) })}>删除</button></div>)}
            <button type="button" className="btn btn-ghost" disabled={form.allowedPrivateHosts.length >= 100} onClick={() => change({ allowedPrivateHosts: [...form.allowedPrivateHosts, ''] })}>添加地址</button></div>}
          <div className="instance-actions"><button type="button" className="btn btn-ghost" onClick={() => void run(test)}>测试</button><button type="button" className="btn btn-primary" disabled={!canSaveAi(form, busy)} onClick={() => void run(save)}>保存</button></div>
          <p className="connection-caption">测试会发一次最小请求，可能产生少量费用。测试通过的配置才会替换当前配置。</p>
          <p className="connection-caption">点「测试」时会先保存每日上限和内网允许列表，并立即生效。</p>
        </fieldset>}
        {testResult?.ok && <span role="status" className="inline-status online">上次测试成功 · 用时 {(testResult.latencyMs / 1000).toFixed(2)} 秒</span>}
      </>}
      {busy && <span role="status" className="inline-status checking">处理中…</span>}
      {error && <div role="alert" className="inline-status offline">{error}</div>}
      {configured === null && error && <button className="btn btn-ghost" onClick={() => void load()}>重试</button>}
      {configured && <div className="instance-form"><button type="button" className="btn btn-ghost" disabled={busy || Boolean(batch?.running)} onClick={() => void run(prepare)}>重新分析我的 Skill</button><p className="connection-caption">不会覆盖你手动修改过的标签</p></div>}
      {batch && <span role="status" className={`inline-status ${batch.error ? 'offline' : batch.running ? 'checking' : 'online'}`}>{batch.error ?? `${batch.running ? '分析中' : '分析完成'}：已排队 ${batch.queued} · 跳过 ${batch.skipped} · 成功 ${batch.completed} · 失败 ${batch.failed}`}</span>}
    </div>
    {deleting && <ConfirmModal title="不配置 AI 服务？" description="确认后将删除服务器保存的 AI 配置与密钥。已有 Skill 保留，新导入的 Skill 不会自动分析。" confirmLabel="删除配置" destructive busy={busy} onCancel={() => setDeleting(false)} onConfirm={() => void run(async () => { await apiInstanceAiDelete(space); if (!mounted.current) return; setDeleting(false); await load() })} />}
    {preview && <ConfirmModal title="重新分析我的 Skill" description={analysisConfirmation(preview.value)} confirmLabel="确认并开始分析" busy={busy} onCancel={() => setPreview(null)} onConfirm={() => void run(async () => {
      const groups = preview.groups
      setPreview(null)
      void startInstanceAnalysis(groups, space, message => { toast(message) })
    })} />}
  </>
}
