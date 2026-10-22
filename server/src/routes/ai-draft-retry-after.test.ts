/**
 * Adapter-level coverage: the real `requestConfiguredAiDraft` (one protocol at
 * a time) against a mocked HTTP `Response`, then the avatar worker's
 * classifier/scheduler on the error it actually throws. Reverting the two
 * `throw aiProviderHttpError(...)` lines in routes/skills.ts to a plain Error
 * makes these fail.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockConfig = vi.hoisted(() => ({
  AI_API_BASE_URL: 'https://provider.example' as string | undefined,
  AI_API_KEY: 'fixture-key-not-real' as string | undefined,
  AI_MODEL: 'fixture-model',
  AI_PROTOCOL: 'anthropic' as 'openai' | 'anthropic' | 'openai-responses',
  AI_MAX_TOKENS: 256,
  AI_RATE_LIMIT_PER_MINUTE: 60,
  AI_GLOBAL_DAILY_LIMIT: 1_000,
  AI_MAX_CONCURRENT: 4,
  AI_TIMEOUT_MS: 5_000,
  SKILL_AVATARS_ENABLED: true,
  SKILL_AVATAR_DAILY_LIMIT: 200,
  SKILL_MAX_PER_USER: 50,
}))
vi.mock('../db.js', () => ({ db: {} }))
vi.mock('../config.js', () => ({ config: mockConfig }))
vi.mock('../lib/mutation-lock.js', () => ({ lockSkillMutation: vi.fn(), lockSkillTeamMutation: vi.fn(), lockUserMutation: vi.fn() }))
vi.mock('../middleware/auth.js', () => ({ authMiddleware: vi.fn() }))

import { requestConfiguredAiDraft } from './skills.js'
import { AiProviderHttpError } from '../utils/retry-after.js'
import { classifyAvatarFailure, nextAvatarAttemptAt } from '../lib/skill-avatars.js'

const fetchMock = vi.fn()
beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock) })
afterEach(() => { vi.unstubAllGlobals() })

async function thrown(): Promise<unknown> {
  return requestConfiguredAiDraft('avatar:test-owner', 'system', '{"name":"x"}', 'text').then(() => null, (error: unknown) => error)
}

describe('real AI adapters surface status and Retry-After to the avatar worker', () => {
  it('anthropic: a 429 with delta-seconds becomes AiProviderHttpError and a ≥ Retry-After schedule', async () => {
    mockConfig.AI_PROTOCOL = 'anthropic'
    fetchMock.mockResolvedValue(new Response('{"error":{"message":"private body"}}', { status: 429, headers: { 'retry-after': '300' } }))
    const error = await thrown()
    expect(error).toBeInstanceOf(AiProviderHttpError)
    expect(error).toMatchObject({ provider: 'anthropic', status: 429, retryAfterMs: 300_000, message: 'AI provider returned HTTP 429' })
    expect(JSON.stringify(error)).not.toContain('private body')
    expect(fetchMock.mock.calls[0][0]).toBe('https://provider.example/v1/messages')
    const failure = classifyAvatarFailure(error, 'prompting')
    expect(failure).toMatchObject({ code: 'prompt_http_429', kind: 'transient', retryAfterMs: 300_000 })
    const now = new Date()
    expect(nextAvatarAttemptAt(now, failure, 1).getTime() - now.getTime()).toBe(300_000)
  })
  it('openai-responses: an HTTP-date Retry-After on 503 is honoured; a malformed one falls back to backoff', async () => {
    mockConfig.AI_PROTOCOL = 'openai-responses'
    const at = new Date(Date.now() + 240_000).toUTCString()
    fetchMock.mockResolvedValue(new Response(null, { status: 503, headers: { 'retry-after': at } }))
    const error = await thrown()
    expect(error).toBeInstanceOf(AiProviderHttpError)
    expect(error).toMatchObject({ provider: 'openai-responses', status: 503 })
    expect((error as AiProviderHttpError).retryAfterMs).toBeGreaterThanOrEqual(236_000)
    expect(fetchMock.mock.calls[0][0]).toBe('https://provider.example/v1/responses')
    const failure = classifyAvatarFailure(error, 'prompting')
    expect(failure.code).toBe('prompt_http_503')
    const now = new Date()
    expect(nextAvatarAttemptAt(now, failure, 1).getTime() - now.getTime()).toBeGreaterThanOrEqual(236_000)

    fetchMock.mockResolvedValue(new Response(null, { status: 503, headers: { 'retry-after': 'soon' } }))
    const malformed = await thrown()
    expect(malformed).toMatchObject({ status: 503, retryAfterMs: null })
    expect(nextAvatarAttemptAt(now, classifyAvatarFailure(malformed, 'prompting'), 1).getTime() - now.getTime()).toBe(15_000)
  })
  it('a 2xx answer still returns the draft text through the same path', async () => {
    mockConfig.AI_PROTOCOL = 'anthropic'
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ content: [{ type: 'text', text: 'draft text' }] }), { status: 200, headers: { 'content-type': 'application/json' } }))
    await expect(requestConfiguredAiDraft('avatar:test-owner', 'system', 'input', 'text')).resolves.toBe('draft text')
  })
  it('stops retries on a confirmed depleted upstream account without retaining its private error text', async () => {
    mockConfig.AI_PROTOCOL = 'openai-responses'
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: {
      code: 'insufficient_user_quota', message: 'private balance and credential details',
    } }), { status: 403 }))
    const error = await thrown()
    expect(classifyAvatarFailure(error, 'prompting')).toMatchObject({
      code: 'prompt_insufficient_user_quota', kind: 'terminal',
    })
    expect(JSON.stringify(error)).not.toContain('private')
  })
})
