import type { InstanceAiDraft, InstanceAiPolicy, InstanceAiSettings, AnalysisPreview, InstanceMember, InstanceOverview } from './api.js'

export const AI_PROTOCOLS = [
  { value: 'openai', label: 'OpenAI 兼容' }, { value: 'anthropic', label: 'Anthropic' }, { value: 'openai-responses', label: 'OpenAI Responses' },
] as const
export type AiForm = InstanceAiDraft & InstanceAiPolicy & { replacingKey: boolean; draftToken: string | null }
export function aiForm(settings: InstanceAiSettings): AiForm {
  return { protocol: settings.protocol ?? 'openai', baseUrl: settings.baseUrl ?? '', model: settings.model ?? '',
    apiKey: '', replacingKey: settings.source === 'none', limits: settings.limits, allowedPrivateHosts: settings.allowedPrivateHosts, draftToken: null }
}
export function changeAiForm(form: AiForm, change: Partial<AiForm>): AiForm {
  return { ...form, ...change, draftToken: null }
}
export function aiDraft(form: AiForm): InstanceAiDraft {
  return { protocol: form.protocol, baseUrl: form.baseUrl, model: form.model, ...(form.replacingKey && form.apiKey ? { apiKey: form.apiKey } : {}) }
}
export function canSaveAi(form: AiForm, busy: boolean): boolean { return !busy && Boolean(form.draftToken) }
export function maskedAiKey(last4: string | null): string { return last4 ? `•••• ${last4}（末 4 位）` : '•••• 已保存' }
export const INSTANCE_ERRORS: Record<string, string> = {
  INVALID_REQUEST: '请检查输入内容与每日上限（0–100000）。', INVALID_BASE_URL: '请输入有效的接口地址，不要包含账号、查询参数或片段。',
  INVALID_ALLOWED_HOST: '允许列表只接受 host 或 host:port，不支持网址、通配符或网段。', API_KEY_REQUIRED: '请填写 API Key',
  TEST_REQUIRED: '配置已变化或测试已过期，请重新测试后保存。', ENV_OVERRIDE: '由服务器环境变量配置，修改请编辑服务器配置。',
  SSRF_BLOCKED: '服务器阻止了这个地址。若为可信内网服务，请将 host 或 host:port 加入内网允许列表后重新测试。',
  AI_REDIRECT_BLOCKED: '接口发生重定向，请填写最终接口地址。', AI_PROVIDER_ERROR: 'AI 服务请求失败，请检查 Key、模型及供应商额度。',
  AI_INVALID_RESPONSE: 'AI 服务返回格式不符合要求，请检查协议与模型。', AI_RESPONSE_TOO_LARGE: 'AI 服务响应过大，请更换模型或接口。',
  AI_NETWORK_ERROR: '服务器无法连接 AI 服务，请检查地址与网络。', AI_TIMEOUT: 'AI 服务请求超时，请稍后重试。',
  AI_DRAFT_CAPACITY: '待保存的测试过多，请稍后重新测试。', INSTANCE_SETTINGS_UNAVAILABLE: '暂时无法读取或保存实例设置，请检查服务器配置后重试。',
  AI_INSTANCE_DAILY_LIMIT: '实例今日 AI 额度已用完。', AI_USER_DAILY_LIMIT: '你的今日 AI 额度已用完。', AI_RATE_LIMIT: '请求过于频繁，请稍后重试。', AI_BUSY: 'AI 服务正忙，请稍后重试。',
  CONFIRMATION_REQUIRED: '请先预览并确认分析范围与费用。', AI_NOT_CONFIGURED: '实例尚未配置 AI，请联系管理员。', BATCH_RUNNING: '你已有正在进行的分析批次，请等待完成。',
  BATCH_CAPACITY: '分析任务过多，请稍后重试。', BATCH_NOT_FOUND: '批次已不存在，服务器可能已重启；请先检查结果再重新分析。',
  LAST_ADMIN: '至少保留一名管理员，不能降级最后一名管理员。', ADMIN_REQUIRED: '只有实例管理员可以执行此操作。', MEMBER_NOT_FOUND: '成员已不存在，请刷新页面。',
  INVITE_CODE_REQUIRED: '请先点击“换一个”生成邀请码。', REGISTRATION_CLOSED: '实例已关闭注册。',
}
export function instanceError(error: unknown): string {
  const failure = error as { code?: string; status?: number; kind?: string } | null
  if (failure?.code && typeof INSTANCE_ERRORS[failure.code] === 'string') return INSTANCE_ERRORS[failure.code]
  if (failure?.status === 403) return '只有实例管理员可以执行此操作。'
  if (failure?.status === 401) return '登录已失效，请重新登录。'
  if (failure?.kind === 'aborted') return '空间或账号已切换，本次操作已停止。'
  return '操作失败，请检查连接后重试。'
}
export function analysisConfirmation(preview: AnalysisPreview): string {
  return `共 ${preview.total} 个 Skill，可分析 ${preview.eligible} 个，本次可覆盖 ${preview.coverable} 个。今日剩余额度：实例 ${preview.remaining.instance} 次，你 ${preview.remaining.user} 次。分析可能产生费用，不会覆盖你手动修改过的标签。`
}
export function lastAdministrator(member: InstanceMember, members: InstanceMember[]): boolean {
  return member.role === 'admin' && members.filter(item => item.role === 'admin').length <= 1
}
export function isServerUnanalysed(profile: string, status: string | undefined): boolean {
  return profile === 'selfhost' && status === 'unanalysed'
}
export function instanceIsLoopback(baseUrl: string): boolean {
  const host = new URL(baseUrl).hostname
  return host === 'localhost' || host === '[::1]' || /^127\./.test(host)
}
export function instanceSummary(overview: InstanceOverview): string {
  const address = overview.addresses.primary.baseUrl
  const deployment = instanceIsLoopback(address) ? '本机部署' : '服务器部署'
  const storage = overview.storage.provider === 'builtin' ? '本地目录存储' : `${overview.storage.provider} 存储`
  return `${overview.memberCount} 位成员 · ${deployment}（${address}） · ${storage} · Server ${overview.version.server}`
}
