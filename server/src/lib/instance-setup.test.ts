import type { InstanceSetup } from '@prisma/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockDb = vi.hoisted(() => ({
  $transaction: vi.fn(), $queryRaw: vi.fn(), instanceSetup: { update: vi.fn() },
}))
const mockConfig = vi.hoisted(() => ({ SKILLHUB_PROFILE: 'selfhost', PUBLIC_BASE_URL: 'https://skills.example.test' }))
vi.mock('../db.js', () => ({ db: mockDb }))
vi.mock('../config.js', () => ({ config: mockConfig }))
import { hashSetupCode, issueSetupCode } from './instance-setup.js'

describe('startup initialization code', () => {
  let state: InstanceSetup
  const logger = { warn: vi.fn() }
  const write = vi.fn<(message: string) => void>()
  beforeEach(() => {
    vi.resetAllMocks()
    mockConfig.SKILLHUB_PROFILE = 'selfhost'
    state = { id: 1, initializedAt: null, codeHash: 'old-hash', codeExpiresAt: new Date(0), codeAttempts: 5, updatedAt: new Date() }
    mockDb.$transaction.mockImplementation(async (callback: (client: typeof mockDb) => Promise<unknown>): Promise<unknown> => callback(mockDb))
    mockDb.$queryRaw.mockImplementation(async (): Promise<InstanceSetup[]> => [state])
    mockDb.instanceSetup.update.mockImplementation(async ({ data }: { data: Partial<InstanceSetup> }): Promise<InstanceSetup> => Object.assign(state, data))
  })

  it('rotates an 80-bit code, stores only its digest and prints the connection instructions once', async (): Promise<void> => {
    const before = Date.now()
    await issueSetupCode(logger, write)
    const message = write.mock.calls[0]![0]
    const code = message.match(/[A-HJ-NP-Z2-9]{4}(?:-[A-HJ-NP-Z2-9]{4}){3}/)?.[0]
    expect(code).toBeDefined()
    expect(Math.log2('ABCDEFGHJKLMNPQRSTUVWXYZ23456789'.length) * 16).toBe(80)
    expect(state.codeHash).toBe(hashSetupCode(code!))
    expect(JSON.stringify(mockDb.instanceSetup.update.mock.calls)).not.toContain(code)
    expect(state.codeExpiresAt!.getTime()).toBeGreaterThanOrEqual(before + 30 * 60 * 1000)
    expect(state.codeExpiresAt!.getTime()).toBeLessThanOrEqual(Date.now() + 30 * 60 * 1000)
    expect(state.codeAttempts).toBe(0)
    expect(message.split('\n')).toEqual([
      '----------------------------------------',
      `SkillHub 自部署初始化码：${code}`,
      `在 SkillHub APP 设置 → 自部署服务器 填写 ${mockConfig.PUBLIC_BASE_URL}，按提示输入初始化码`,
      '初始化码 30 分钟后过期；重启服务器会签发新码，旧码立即失效。',
      '----------------------------------------',
      '',
    ])
    expect(write).toHaveBeenCalledTimes(1)
    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(logger.warn).toHaveBeenCalledWith('Instance not initialized; a one-time setup code was printed to stdout')
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(code)
    await issueSetupCode(logger, write)
    expect(state.codeHash).not.toBe(hashSetupCode(code!))
    expect(write).toHaveBeenCalledTimes(2)
    expect(logger.warn).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(logger.warn.mock.calls)).not.toMatch(/[A-HJ-NP-Z2-9]{4}(?:-[A-HJ-NP-Z2-9]{4}){3}/)
    expect(mockDb.$queryRaw.mock.calls[0]?.[0].join('')).toContain('FOR UPDATE')
  })

  it('does not rotate or print after initialization', async (): Promise<void> => {
    state.initializedAt = new Date()
    await issueSetupCode(logger, write)
    expect(mockDb.instanceSetup.update).not.toHaveBeenCalled()
    expect(write).not.toHaveBeenCalled()
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('does not access setup state for official instances', async (): Promise<void> => {
    mockConfig.SKILLHUB_PROFILE = 'yitan-official'
    await issueSetupCode(logger, write)
    expect(mockDb.$transaction).not.toHaveBeenCalled()
    expect(write).not.toHaveBeenCalled()
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('requires the singleton migration before issuing a code', async (): Promise<void> => {
    mockDb.$queryRaw.mockResolvedValue([])
    await expect(issueSetupCode(logger, write)).rejects.toThrow('migration is required')
    expect(write).not.toHaveBeenCalled()
    expect(logger.warn).not.toHaveBeenCalled()
  })
})
