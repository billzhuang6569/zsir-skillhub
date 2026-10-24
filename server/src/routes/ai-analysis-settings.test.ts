import { beforeEach, describe, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({ value: null as null | { protocol: string; baseUrl: string; model: string }, provider: vi.fn(), reserve: vi.fn() }))
vi.mock('../db.js', () => ({ db: {} }))
vi.mock('../config.js', async () => {
  const { configSchema } = await import('../config-schema.js')
  return { config: configSchema.parse({ ...process.env, SKILLHUB_PROFILE: 'selfhost', AI_RATE_LIMIT_PER_MINUTE: 60 }) }
})
vi.mock('../lib/server-settings.js', () => ({
  getSettingValue: (key: string) => key === 'ai' ? state.value : null,
  hasSettingSecret: () => state.value !== null,
  effectiveSource: () => state.value ? 'setting' : 'none',
  getSettingSecret: async () => state.value ? 'stored-secret' : null,
}))
vi.mock('../lib/ai-budget.js', () => ({ aiBudget: { reserve: state.reserve, available: async () => ({ instance: 50, user: 50 }) } }))
vi.mock('../lib/ai-http.js', async importOriginal => ({ ...await importOriginal<typeof import('../lib/ai-http.js')>(), aiJsonRequest: state.provider }))
import { analyzeSkillWithAI, requestConfiguredAiDraft } from './skills.js'
beforeEach(() => {
  state.value = null
  state.provider.mockReset(); state.reserve.mockReset()
  state.reserve.mockImplementation(async (userId: string) => ({ userId, day: new Date().toISOString().slice(0, 10), remaining: 1 }))
})
describe('selfhost analysis configuration', () => {
  it('returns unanalysed raw metadata without rule-generated labels or spending quota', async () => {
    const result = await analyzeSkillWithAI('code-review', '---\nname: My name\ndescription: Original description\ncategory: My category\ntags: [manual]\n---\n# Code review\nTest and deploy code with git', 'owner:ip')
    expect(result).toMatchObject({ source: 'unanalysed', profile: { description: 'Original description', category: 'My category', labels: ['manual'], triggerScenarios: [] } })
    expect((await analyzeSkillWithAI('code-review', '# Code review\nTest and deploy code with git', 'owner:ip')).profile.labels).toEqual([])
    expect(await requestConfiguredAiDraft('avatar:owner', 'system', 'input', 'text', 'background')).toBeNull()
    expect(state.provider).not.toHaveBeenCalled(); expect(state.reserve).not.toHaveBeenCalled()
  })
  it('uses setting credentials/model for runtime analysis and avatar prompts through the safe transport', async () => {
    state.value = { protocol: 'openai', baseUrl: 'https://saved.example/v1', model: 'saved-model' }
    const profile = { displayName: '审查', description: '审查代码', category: '开发与工程', labels: ['代码审查', '测试验证'], triggerScenarios: [] }
    state.provider.mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify(profile) } }] })
    expect(await analyzeSkillWithAI('review', 'source', 'owner:ip')).toMatchObject({ source: 'ai', profile })
    expect(state.provider.mock.calls[0]).toEqual([new URL('https://saved.example/v1/chat/completions'),
      { authorization: 'Bearer stored-secret' }, expect.objectContaining({ model: 'saved-model' }), [], expect.any(Number)])
    state.provider.mockResolvedValueOnce({ choices: [{ message: { content: 'drawing prompt' } }] })
    expect(await requestConfiguredAiDraft('avatar:owner', 'system', 'input', 'text', 'background')).toBe('drawing prompt')
    expect(state.reserve).toHaveBeenLastCalledWith('owner', 1, 'background')
  })
  it('provider errors and invalid profiles remain unanalysed without heuristic fallback', async () => {
    state.value = { protocol: 'openai', baseUrl: 'https://saved.example', model: 'model' }
    for (const response of [{ choices: [{ message: { content: 'invalid JSON' } }] }, { choices: [] }]) {
      state.provider.mockResolvedValueOnce(response)
      expect(await analyzeSkillWithAI('code-review', 'test deploy git', 'owner:ip')).toMatchObject({ source: 'unanalysed', profile: { labels: [] } })
    }
    state.provider.mockRejectedValueOnce(new Error('stored-secret'))
    expect(await analyzeSkillWithAI('code-review', 'test deploy git', 'owner:ip')).toMatchObject({ source: 'unanalysed' })
  })
})
