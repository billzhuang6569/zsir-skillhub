import type { AgentInfo } from './tauri.js'

/**
 * Names of every detected Agent that reads the same projection folder as
 * `key` (including itself), or `[]` when that folder belongs to one Agent.
 * Disabling one of them removes the shared projection for all of them, so the
 * UI names the whole group before the click instead of behind a confirm.
 */
export function sharedProjectionAgents(key: string, agents: AgentInfo[]): string[] {
  const agent = agents.find((item) => item.key === key)
  if (!agent?.dir) return []
  const shared = agents.filter((item) => item.dir === agent.dir).map((item) => item.name)
  return shared.length > 1 ? shared : []
}

/** Accessible label and tooltip of an installed Agent button: the click disables directly. */
export function disableAgentLabel(name: string, sharedWith: string[]): string {
  return sharedWith.length > 1
    ? `${name} 已安装，点击停用（${sharedWith.join('、')} 共用同一文件夹，会一起停用）`
    : `${name} 已安装，点击停用`
}

/** Toast after a direct disable; the undo re-enables the same Agent. */
export function disabledToastMessage(name: string, sharedWith: string[]): string {
  return sharedWith.length > 1
    ? `已在 ${sharedWith.join('、')} 停用（共用同一文件夹），SkillHub 中仍保留`
    : `已在 ${name} 停用，SkillHub 中仍保留`
}

/** Inline note listing shared projection folders among the installed Agents. */
export function sharedProjectionNote(installedKeys: string[], agents: AgentInfo[]): string | null {
  const groups = new Set<string>()
  for (const key of installedKeys) {
    const shared = sharedProjectionAgents(key, agents)
    if (shared.length > 1) groups.add(shared.join('、'))
  }
  if (groups.size === 0) return null
  return `${Array.from(groups).join('；')} 共用同一文件夹，停用其中一个会一起停用。`
}
