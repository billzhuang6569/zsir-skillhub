import type { ApiSkillVersion, apiCreateSkillVersion } from './api.js'
import type { FrozenVersionPackage, SpaceHandle } from './tauri.js'

export type VersionTaskIdentity = { accountId: string | null; space: SpaceHandle | null; managedSkillId: string }
export function versionTaskKey(identity: VersionTaskIdentity): string {
  return JSON.stringify([identity.space?.spaceId, identity.space?.generation, identity.accountId, identity.managedSkillId])
}
export type VersionTaskInput = VersionTaskIdentity & {
  version: string
  changelog: string
  allocation: 'auto' | 'manual'
  serverId?: string
  repair?: ApiSkillVersion
}
export type VersionTask = VersionTaskInput & {
  key: string
  phase: 'freezing' | 'packaging' | 'publishing' | 'recording' | 'refreshing' | 'succeeded' | 'failed' | 'rejected' | 'cancelled'
  token?: string
  request?: Parameters<typeof apiCreateSkillVersion>[1]
  result?: ApiSkillVersion
  recorded?: boolean
  error?: string
}
export function versionTaskBlocks(task: VersionTask | undefined): boolean {
  return Boolean(task && !['succeeded', 'rejected', 'cancelled'].includes(task.phase))
}
export type VersionTaskEnvironment = {
  matches: (identity: VersionTaskIdentity) => boolean
  freeze: (input: VersionTaskInput) => Promise<string>
  package: (task: VersionTask, token: string) => Promise<FrozenVersionPackage>
  publish: (task: VersionTask, request: NonNullable<VersionTask['request']>) => Promise<ApiSkillVersion>
  record: (task: VersionTask, token: string) => Promise<void>
  refresh: (task: VersionTask) => Promise<void>
  release: (token: string) => Promise<void>
  status: (error: unknown) => number | null
  message: (error: unknown) => string
  notify: (message: string, error?: boolean) => void
}

/** Only version creation/repair lives here. A failed task owns its original request. */
export class VersionCreateTasks {
  private tasks = new Map<string, VersionTask>()
  private listeners = new Set<() => void>()
  private running = new Set<string>()
  private env: VersionTaskEnvironment
  constructor(env: VersionTaskEnvironment) { this.env = env }
  get = (key: string): VersionTask | undefined => this.tasks.get(key)
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  private update(task: VersionTask, changes: Partial<VersionTask>): VersionTask {
    const next = { ...task, ...changes }
    this.tasks.set(task.key, next)
    this.listeners.forEach(listener => listener())
    return next
  }
  cancelStale = (): void => {
    for (const task of this.tasks.values()) {
      if (this.env.matches(task) || task.phase === 'cancelled') continue
      this.update(task, { phase: 'cancelled', token: undefined, request: undefined, result: undefined })
      if (task.token) void this.env.release(task.token).catch(() => {})
    }
  }
  private current(task: VersionTask): boolean {
    return this.env.matches(task) && this.tasks.get(task.key)?.phase !== 'cancelled'
  }
  async start(input: VersionTaskInput): Promise<void> {
    const key = versionTaskKey(input)
    if (!this.env.matches(input)) throw new Error('账号或空间已切换，请重新打开版本窗口')
    if (versionTaskBlocks(this.get(key))) throw new Error('这个 Skill 已有版本任务，请先重试或补全记录')
    let task = this.update({ ...input, key, phase: 'freezing' }, {})
    try {
      const token = await this.env.freeze(input)
      if (!this.current(task)) {
        await this.env.release(token)
        throw new Error('账号或空间已切换，请通过同步核对版本')
      }
      task = this.update(task, { token, result: input.repair, phase: input.serverId && !input.repair ? 'packaging' : 'recording' })
      void this.run(task)
    } catch (error: unknown) {
      if (this.current(task)) this.update(task, { phase: 'rejected', error: undefined })
      throw error
    }
  }
  retry = (key: string): void => {
    const task = this.get(key)
    if (task?.phase === 'failed' && this.current(task)) void this.run(task)
  }
  deferRecord = (key: string): void => {
    const task = this.get(key)
    if (task?.phase !== 'failed' || task.serverId && !task.result || !this.current(task)) return
    this.update(task, { phase: 'rejected', token: undefined, request: undefined })
    if (task.token) void this.env.release(task.token).catch(() => {})
    void this.env.refresh(task).catch(() => {})
  }
  abandonUnknown = (key: string): void => {
    const task = this.get(key)
    if (task?.phase !== 'failed' || !task.serverId || task.result || !this.current(task)) return
    this.update(task, { phase: 'cancelled', token: undefined, request: undefined, error: undefined })
    if (task.token) void this.env.release(task.token).catch(() => {})
    this.env.notify('已放弃本次本机任务，远端结果仍未知，未回滚。请到版本历史核对，并补全或修复本机记录')
    void this.env.refresh(task).catch(() => {})
  }
  private async run(initial: VersionTask): Promise<void> {
    if (this.running.has(initial.key) || !initial.token || !this.current(initial)) return
    this.running.add(initial.key)
    let task = this.update(initial, { error: undefined, phase: initial.recorded ? 'refreshing' : initial.result || !initial.serverId ? 'recording' : initial.request ? 'publishing' : 'packaging' })
    try {
      if (task.serverId && !task.result) {
        if (!task.request) {
          const frozen = await this.env.package(task, initial.token)
          if (!this.current(task)) return
          task = this.update(task, { request: {
            version: task.version, changelog: task.changelog, skillMd: frozen.skillMd,
            envDependencies: frozen.envDependencies, packageBase64: frozen.package.base64,
            packageSha256: frozen.package.sha256,
          }, phase: 'publishing' })
        }
        const result = await this.env.publish(task, task.request!)
        if (!this.current(task)) return
        task = this.update(task, { result, phase: 'recording' })
      }
      if (!this.current(task)) return
      if (!task.recorded) {
        await this.env.record(task, initial.token)
        if (!this.current(task)) return
        task = this.update(task, { recorded: true, phase: 'refreshing' })
      }
      await this.env.refresh(task)
      if (!this.current(task)) return
      this.update(task, { phase: 'succeeded', request: undefined, token: undefined })
      this.env.notify(task.result ? '正式版本已记录，账号状态等待同步确认' : '版本已保存在本机')
      await this.env.release(initial.token).catch(() => {})
    } catch (error: unknown) {
      if (!this.current(task)) return
      const status = this.env.status(error)
      const rejected = !task.result && (task.phase === 'packaging' && !task.request || task.phase === 'publishing' && status !== null && status >= 400 && status < 500)
      const message = task.result ? `云端版本已保留，内容已变化或记录未完成，请补全本机记录：${this.env.message(error)}` : this.env.message(error)
      this.update(task, { phase: rejected ? 'rejected' : 'failed', error: message,
        ...(rejected ? { request: undefined, token: undefined } : {}) })
      this.env.notify(message, true)
      if (rejected) await this.env.release(initial.token).catch(() => {})
    } finally { this.running.delete(initial.key) }
  }
}
