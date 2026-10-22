import type { LocalInferenceAgent, LocalInferenceProbe, LocalInferenceWorkerStatus, SpaceHandle } from './tauri.js'

export type LocalInferencePreference = { enabled: boolean; agent: LocalInferenceAgent; autoAnalyze: boolean }
const DEFAULT: LocalInferencePreference = { enabled: false, agent: 'claude', autoAnalyze: true }
export const LOCAL_INFERENCE_PREFERENCE_EVENT = 'skillhub-local-inference-preference'
function preferenceKey(space: SpaceHandle, userId: string): string {
  return `skillhub.local-inference.v1:${JSON.stringify([space.spaceId, userId])}`
}
export function readLocalInferencePreference(space: SpaceHandle, userId: string): LocalInferencePreference {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(preferenceKey(space, userId)) ?? 'null')
    if (value && typeof value === 'object' && 'enabled' in value && typeof value.enabled === 'boolean'
      && 'agent' in value && (value.agent === 'claude' || value.agent === 'codex')) return {
        enabled: value.enabled, agent: value.agent, autoAnalyze: !('autoAnalyze' in value) || value.autoAnalyze !== false,
      }
  } catch { /* A missing/corrupt preference leaves paid local inference disabled. */ }
  return { ...DEFAULT }
}
export function saveLocalInferencePreference(space: SpaceHandle, userId: string, value: LocalInferencePreference): void {
  localStorage.setItem(preferenceKey(space, userId), JSON.stringify(value))
  window.dispatchEvent(new Event(LOCAL_INFERENCE_PREFERENCE_EVENT))
}
export function setLocalAutoAnalyze(space: SpaceHandle, userId: string, autoAnalyze: boolean): LocalInferencePreference {
  const preference = { ...readLocalInferencePreference(space, userId), autoAnalyze }
  saveLocalInferencePreference(space, userId, preference)
  return preference
}

let worker: LocalInferenceWorkerStatus | null = null
let completionScope = ''
const completedEvents = new Set<number>()
const workerListeners = new Set<() => void>()
export function subscribeLocalWorker(listener: () => void): () => void {
  workerListeners.add(listener)
  return () => { workerListeners.delete(listener) }
}
export function isCurrentWorkerEvent(event: LocalInferenceWorkerStatus, space: SpaceHandle | null, userId: string | undefined): boolean {
  return Boolean(space && event.space.spaceId === space.spaceId && event.space.generation === space.generation && event.userId === userId)
}
export function acceptLocalWorkerStatus(event: LocalInferenceWorkerStatus, space: SpaceHandle | null, userId: string | undefined): boolean {
  if (!isCurrentWorkerEvent(event, space, userId)) return false
  if (!worker || !isCurrentWorkerEvent(worker, space, userId) || event.revision > worker.revision) {
    worker = event
    workerListeners.forEach(listener => listener())
  }
  // Status snapshots omit skillId. A completion can arrive after its snapshot
  // (or even a newer running status); refresh once without rolling status back.
  const scope = JSON.stringify([event.space.spaceId, event.space.generation, event.userId])
  if (scope !== completionScope) { completionScope = scope; completedEvents.clear() }
  if (!event.skillId || completedEvents.has(event.revision)) return false
  completedEvents.add(event.revision)
  return true
}
export function localWorkerSnapshot(space: SpaceHandle, userId: string): LocalInferenceWorkerStatus | null {
  return worker && isCurrentWorkerEvent(worker, space, userId) ? worker : null
}
export function canApplyLocalAnalysisRefresh<T extends { updatedAt?: string }>(current: T, captured: T | undefined, updatedAt: string): boolean {
  if (current !== captured) return false
  const incoming = Date.parse(updatedAt)
  const previous = current.updatedAt ? Date.parse(current.updatedAt) : 0
  return Number.isFinite(incoming) && (!Number.isFinite(previous) || incoming >= previous)
}
const WORKER_REASONS: Record<string, string> = {
  CHECKING: '正在检测 Claude Code', PROBE_REQUIRED: '请重新检测 Claude Code', BUSY: '检测或测试正在运行',
  CAPABILITY_MISSING: '实例不支持本机自动分析，请升级实例后重新打开 APP',
  INSTANCE_AI_CONFIGURED: '实例已配置 AI 接口，10 分钟后再检查',
  INSTANCE_MISMATCH: '实例身份不一致，请重新连接', INVALID_LEASE: '租约格式无效，请升级实例',
  SIGN_IN_REQUIRED: '请重新登录此空间', NETWORK: '连接失败，稍后自动重试',
  INTERRUPTED: '自动分析多次被中断，已暂停；点击继续重试',
  INTERRUPTION_BACKOFF: '自动分析被中断，至少 30 秒后重试',
}
export function localWorkerText(status: LocalInferenceWorkerStatus | null, autoAnalyze: boolean): string {
  if (!autoAnalyze) return '已暂停 · 你已暂停自动分析'
  if (!status) return '正在读取自动分析状态…'
  let reason = WORKER_REASONS[status.pausedReason ?? ''] ?? (status.lastError ? localInferenceError(status.lastError) : '等待检测')
  if (status.state === 'paused' && status.pausedReason === 'PROBE_REQUIRED' && status.lastError) {
    reason += `（${localInferenceError(status.lastError).replace(/。$/, '')}）`
  }
  switch (status.state) {
    case 'off': return '自动分析已关闭'
    case 'idle': return '空闲 · 没有待分析的 Skill 或头像提示词任务'
    case 'running': return '运行中'
    case 'paused': return `已暂停 · ${reason}`
    case 'unavailable': return `不可用 · ${reason}`
    case 'error': return `暂时失败 · ${reason}`
  }
}
export function localWorkerCounts(status: LocalInferenceWorkerStatus | null): string {
  return `本次已分析 ${status?.analyzed ?? 0} 个 Skill，编写 ${status?.drafted ?? 0} 个头像提示词，失败 ${status?.failed ?? 0} 个`
}
export const LOCAL_INFERENCE_ERRORS: Record<string, string> = {
  LOCAL_AGENT_MANAGED_MCP: '组织策略下发了托管 MCP，本机推理无法在隔离模式运行，请改用实例 AI 或联系管理员。',
  LOCAL_AGENT_SOCKS_PROXY: 'Claude Code 不支持 SOCKS 代理，请在终端使用 HTTP 代理后重启 APP。',
  NOT_INSTALLED: '未找到可运行的 CLI；仅安装桌面 App 不代表已安装 CLI。',
  EXECUTABLE: '无法确认 CLI 可执行文件或系统运行目录。',
  SHIM_UNSUPPORTED: '无法安全解析 npm 启动脚本，请安装原生 CLI 或标准 npm 安装版本。',
  VERSION_UNSUPPORTED: '当前支持 Claude Code 2.1.300 及以上的 2.1 版本',
  ISOLATION_UNSUPPORTED: '当前版本的 Codex 无法关闭用户指令和 MCP 连接器，暂不支持本机分析',
  NOT_LOGGED_IN: '请先在终端登录 Claude Code，然后重新检测。',
  SPAWN: '无法启动 CLI 或建立进程隔离。', IO: 'CLI 输入输出失败，请重新检测。',
  TIMEOUT: '本机任务超过 60 秒，已终止。', CANCELLED: '本次本机任务已取消。',
  TERMINATION_FAILED: '系统拒绝终止完整的 CLI 进程树，请在系统中检查残留进程。',
  OUTPUT_LIMIT: 'CLI 输出超过安全上限，已终止。', EXIT: 'CLI 异常退出，请检查终端登录状态。',
  INVALID_JSON: 'CLI 未返回有效 JSON。', MODEL_ERROR: 'CLI 报告任务失败，请稍后重试。',
  INVALID_RESULT: '结果不符合格式或安全要求，已丢弃。', INVALID_INPUT: '任务输入或格式不符合要求。',
  BUSY: '已有本机任务、检测或测试正在运行，请稍后重试。', STALE_SPACE: '空间或账号已切换，本次结果已丢弃。',
  UNAVAILABLE: '尚未满足前置条件，未执行此项检测。', MODELS_UNSUPPORTED: '此 CLI 不提供模型列表。',
}
export function localInferenceError(error: unknown): string {
  const code = typeof error === 'string' ? error : error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
  return LOCAL_INFERENCE_ERRORS[code] ?? '本机检测或分析失败，请重新检测。'
}
export function localInferenceStatus(probe: LocalInferenceProbe): string {
  if (probe.available) return '可用'
  switch (probe.reason) {
    case 'NOT_INSTALLED': return '未安装'
    case 'NOT_LOGGED_IN': return '未登录'
    case 'VERSION_UNSUPPORTED': return '版本不支持'
    case 'ISOLATION_UNSUPPORTED': return '不能关闭用户设置'
    default: return '不可用'
  }
}
export function canTestLocalInference(probes: LocalInferenceProbe[], agent: LocalInferenceAgent, busy: boolean): boolean {
  return !busy && probes.some(probe => probe.agent === agent && probe.available)
}
