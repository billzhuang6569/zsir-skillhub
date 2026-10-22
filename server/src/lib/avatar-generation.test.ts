import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const mock = vi.hoisted(() => ({ config: { SKILLHUB_PROFILE: 'selfhost', SKILL_AVATARS_ENABLED: false, FAL_KEY: '' },
  get: vi.fn(), has: vi.fn() }))
vi.mock('../config.js', () => ({ config: mock.config }))
vi.mock('./server-settings.js', () => ({ getSettingSecret: mock.get, hasSettingSecret: mock.has }))
import { falAvailable, resolveFalKey, submitFalAvatar } from './fal.js'
import { avatarGenerationEnabled } from './avatar-generation.js'

beforeEach(() => { vi.resetAllMocks(); Object.assign(mock.config, { SKILLHUB_PROFILE: 'selfhost', SKILL_AVATARS_ENABLED: false, FAL_KEY: '' }) })
afterEach(() => vi.unstubAllGlobals())
describe('fal credentials and generation availability', () => {
  it('prefers env without decrypting settings and uses that key for the request', async (): Promise<void> => {
    mock.config.FAL_KEY = 'fixture-env'; mock.get.mockResolvedValue('fixture-setting'); mock.has.mockReturnValue(true)
    expect(await resolveFalKey()).toBe('fixture-env'); expect(mock.get).not.toHaveBeenCalled()
    expect(falAvailable()).toBe(true); expect(avatarGenerationEnabled()).toBe(true)
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ request_id: '11111111-1111-4111-8111-111111111111' })))
    vi.stubGlobal('fetch', fetcher)
    await submitFalAvatar('fixture')
    expect(fetcher.mock.calls[0][1].headers.Authorization).toBe('Key fixture-env')
  })
  it('uses loaded selfhost settings; missing keys never send a request', async (): Promise<void> => {
    mock.get.mockResolvedValue('fixture-setting'); mock.has.mockReturnValue(true)
    expect(await resolveFalKey()).toBe('fixture-setting'); expect(falAvailable()).toBe(true)
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ request_id: '11111111-1111-4111-8111-111111111111' })))
    vi.stubGlobal('fetch', fetcher)
    await submitFalAvatar('fixture')
    expect(fetcher.mock.calls[0][1].headers.Authorization).toBe('Key fixture-setting')
    fetcher.mockClear(); mock.get.mockResolvedValue(null); mock.has.mockReturnValue(false)
    expect(falAvailable()).toBe(false); expect(avatarGenerationEnabled()).toBe(false)
    await expect(submitFalAvatar('fixture')).rejects.toMatchObject({ code: 'fal_not_configured' })
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('official availability only follows its switch and never resolves stored credentials', async (): Promise<void> => {
    mock.config.SKILLHUB_PROFILE = 'yitan-official'; mock.has.mockReturnValue(true)
    expect(await resolveFalKey()).toBeNull(); expect(falAvailable()).toBe(false); expect(mock.get).not.toHaveBeenCalled()
    mock.config.FAL_KEY = 'fixture-env'; expect(avatarGenerationEnabled()).toBe(false)
    mock.config.SKILL_AVATARS_ENABLED = true; expect(avatarGenerationEnabled()).toBe(true)
    mock.config.FAL_KEY = ''; expect(avatarGenerationEnabled()).toBe(true)
  })
})
