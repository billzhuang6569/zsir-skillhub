export const AGENT_KEYS = ['claude', 'codex', 'workbuddy', 'workbuddy-ai', 'doubao', 'opencode', 'openclaw', 'gemini', 'trae'] as const

export const AGENT_NAMES: Record<string, string> = {
  claude: 'Claude Code',
  codex: 'ChatGPT',
  workbuddy: 'WorkBuddy',
  'workbuddy-ai': 'WorkBuddy AI',
  doubao: '豆包工作',
  // Kept for previously stored server metadata; native clients no longer
  // expose this historical pseudo-Agent as an install target.
  'agent-skills': '通用 Agent Skills',
  opencode: 'OpenCode',
  openclaw: 'OpenClaw',
  gemini: 'Gemini CLI',
  trae: 'Trae',
}

export function agentDisplayName(key: string): string {
  return AGENT_NAMES[key] ?? key
}

export function emptyAgentStates(): Record<string, 'on' | 'off' | 'broken' | null> {
  return Object.fromEntries(AGENT_KEYS.map((key) => [key, null]))
}

export function orderedAgentEntries<T>(states: Record<string, T>): [string, T][] {
  const order = new Map<string, number>(AGENT_KEYS.map((key, index) => [key, index]))
  return (Object.entries(states) as [string, T][])
    .sort(([left], [right]) => (order.get(left) ?? Number.MAX_SAFE_INTEGER) - (order.get(right) ?? Number.MAX_SAFE_INTEGER))
}

/** Reads the per-device list of detected Agents the user hid from Skill cards. */
export function parseHiddenCardAgents(raw: string | null): string[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return Array.from(new Set(parsed.filter((key): key is string => typeof key === 'string' && key.length > 0)))
  } catch {
    return []
  }
}

/**
 * Agents shown as quick toggles on a Skill card: every detected Agent the
 * user has not hidden. Hiding is only a display preference, so an Agent that
 * currently holds this Skill (installed or broken) always stays visible.
 */
export function cardAgentOptions<T extends { key: string; detected: boolean; skillsStatus?: string }>(
  agents: readonly T[],
  skillAgents: Record<string, 'on' | 'off' | 'broken' | null>,
  hiddenKeys: readonly string[],
): T[] {
  const hidden = new Set(hiddenKeys)
  return agents.filter((agent) => {
    if (!agent.detected) return false
    const status = skillAgents[agent.key]
    if (status === 'on' || status === 'broken') return true
    // 目录未确认时原生端拒绝写入，不提供新的快捷安装入口。
    return agentAcceptsSkillWrites(agent) && !hidden.has(agent.key)
  })
}

export function activeAgentEntries(
  states: Record<string, 'on' | 'off' | 'broken' | null>,
): [string, 'on' | 'broken'][] {
  return orderedAgentEntries(states)
    .filter((entry): entry is [string, 'on' | 'broken'] => (
      entry[1] === 'on' || entry[1] === 'broken'
    ))
}

type AgentDetectionView = {
  detected: boolean
  detectionSource: 'application' | 'cli' | 'none'
  detectionState?: 'detected' | 'notFound' | 'incomplete'
  detectionIssues?: string[]
  skillsStatus?: string
}

/** 设置页状态文案：只有原生检测给出的 `incomplete` 才显示「检测未完成」，不改变写入准入。 */
export function agentStateLabel(agent: AgentDetectionView): string {
  if (!agent.detected) return agent.detectionState === 'incomplete' ? '检测未完成' : '未检测'
  return agent.detectionSource === 'application' ? '已检测 APP' : '已检测 CLI'
}

/** 检测诊断只在本机悬停查看；没有问题时不加提示。 */
export function agentStateTitle(agent: AgentDetectionView): string | undefined {
  const issues = agent.detectionIssues ?? []
  if (issues.length === 0) return undefined
  const lead = !agent.detected
    ? '部分检测来源读取失败，无法确认是否已安装：'
    : agent.skillsStatus === 'unconfirmed' ? '已检测到，但需要注意：' : '已检测到，但部分来源读取失败：'
  return [lead, ...issues].join('\n')
}

/** 原生端标为 `unconfirmed` 时的统一说明（设置页、安装与交回选择器共用）。 */
export const UNCONFIRMED_SKILL_ROOT_HINT = 'Skill 目录未确认：设置了目录覆盖变量（如 CODEX_HOME），暂不写入默认目录'

/** 与原生 `admits_skill_writes` 一致：已检测且 Skill 目录未被覆盖变量置为未确认。 */
export function agentAcceptsSkillWrites(agent: { detected: boolean; skillsStatus?: string }): boolean {
  return agent.detected && agent.skillsStatus !== 'unconfirmed'
}
