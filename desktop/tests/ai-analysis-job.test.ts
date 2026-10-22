import { fixtureSpace } from './helpers/space.ts'
import type { SpaceHandle } from '../src/lib/tauri.ts'
/**
 * Background 「AI 分析」 jobs (#181): the real job runner against the real
 * store, with controllable promises standing in for the API and the native
 * bridge. Each case checks request counts, store state and notices.
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import type { LocalSkill } from '../src/store/index.ts'
import type { AiAnalysisEnvironment, AiAnalysisResult, ServerProfileSnapshot, SkillProfileSnapshot } from '../src/lib/ai-analysis-job.ts'

const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
  if (context.parentURL?.includes('/desktop/src/') && specifier.startsWith('.') && specifier.endsWith('.js')) {
    const candidate = new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL)
    if (existsSync(fileURLToPath(candidate))) return nextResolve(candidate.href, context)
  }
  return nextResolve(specifier, context)
} })
const { useStore } = await import('../src/store/index.ts')
const {
  aiAnalysisJobKey, describeAiAnalysisFailure, runSkillAiAnalysis,
} = await import('../src/lib/ai-analysis-job.ts')
const { ApiError } = await import('../src/lib/api.ts')
hooks.deregister()

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sheet = readFileSync(resolve(desktopRoot, 'src/components/SkillDetailSheet.tsx'), 'utf8')

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void }
function deferred<T>(): Deferred<T> {
  let resolveValue!: (value: T) => void
  let rejectValue!: (error: unknown) => void
  const promise = new Promise<T>((ok, fail) => { resolveValue = ok; rejectValue = fail })
  return { promise, resolve: resolveValue, reject: rejectValue }
}
const tick = (): Promise<void> => new Promise((done) => setImmediate(done))

const ACCOUNT_A = 'user-a'
const ACCOUNT_B = 'user-b'

function skill(id: string, serverId: string, overrides: Partial<LocalSkill> = {}): LocalSkill {
  return {
    id, name: id, displayName: `Skill ${id}`, description: '旧简介', category: '其他', labels: ['旧'], fitScenarios: ['旧场景'],
    localPath: `/fixture/${id}`, version: '0.1.0', latestVersion: '0.1.0', sources: [], agents: {}, installed: false, isOwn: true,
    installCount: 0, acquisitionSource: 'local', compatibleAgents: ['codex'], sharedTo: {}, envDeps: [], versions: [],
    serverId, serverOwnerId: ACCOUNT_A,
    ...overrides,
  }
}

function aiResult(displayName: string, status: AiAnalysisResult['analysis']['status'] = 'completed'): AiAnalysisResult {
  return {
    skill: { displayName, description: `${displayName} 简介`, category: '开发与工程', labels: ['AI'], triggerScenarios: ['新场景'] },
    analysis: { status },
  }
}

type Harness = {
  env: AiAnalysisEnvironment
  space: { value: SpaceHandle | null }
  online: { value: boolean }
  analyzeCalls: { serverId: string; expectedProfile: ServerProfileSnapshot; space: SpaceHandle; reply: Deferred<AiAnalysisResult> }[]
  localWrites: { skillId: string; profile: SkillProfileSnapshot }[]
  notices: { message: string; kind: string }[]
  readbacks: () => number
  failLocalWrite: (error: Error | null) => void
}

function signIn(userId: string, space: SpaceHandle, harness?: Harness): void {
  useStore.getState().setAuthSession({ id: userId, email: `${userId}@example.com`, displayName: userId }, space)
  if (harness) harness.space.value = space
}

function setup(skills: LocalSkill[]): Harness {
  useStore.getState().clearAuthSession()
  useStore.setState({ skills, aiAnalysisJobs: {} })
  const space = { value: fixtureSpace('space-a') as SpaceHandle | null }
  const online = { value: true }
  const analyzeCalls: Harness['analyzeCalls'] = []
  const localWrites: Harness['localWrites'] = []
  const notices: Harness['notices'] = []
  let readbacks = 0
  let localWriteError: Error | null = null
  let sequence = 0
  const env: AiAnalysisEnvironment = {
    currentUserId: () => useStore.getState().currentUser?.id ?? null,
    readSpace: () => space.value,
    findSkill: (serverId, accountUserId) => useStore.getState().skills.find((item) => item.serverId === serverId && item.serverOwnerId === accountUserId),
    beginJob: (job) => {
      useStore.getState().startAiAnalysisJob(job)
      return useStore.getState().aiAnalysisJobs[job.key]?.id === job.id
    },
    endJob: (key, jobId) => useStore.getState().finishAiAnalysisJob(key, jobId),
    readLocalSkillMd: async (item) => `# ${item.name}`,
    fetchSource: async (serverId) => `# cloud ${serverId}`,
    fetchServerProfile: async () => ({ displayName: 'server', description: null, category: null, labels: [], triggerScenarios: [] }),
    analyze: (serverId, _skillMd, expectedProfile, space) => {
      const reply = deferred<AiAnalysisResult>()
      analyzeCalls.push({ serverId, expectedProfile, space: space, reply })
      return reply.promise
    },
    writeLocalProfile: async (item, profile) => {
      if (localWriteError) throw localWriteError
      localWrites.push({ skillId: item.id, profile })
    },
    replaceSkill: (currentId, updated) => useStore.getState().replaceSkill(currentId, updated),
    notify: (message, kind) => { notices.push({ message, kind }) },
    requestReadback: () => { readbacks++ },
    isOnline: () => online.value,
    newJobId: () => `job-${++sequence}`,
    now: () => 0,
  }
  const harness: Harness = {
    env, space, online, analyzeCalls, localWrites, notices,
    readbacks: () => readbacks,
    failLocalWrite: (error) => { localWriteError = error },
  }
  signIn(ACCOUNT_A, fixtureSpace('space-a'), harness)
  // setAuthSession downgrades ownership until a refresh confirms it; restore the fixture.
  useStore.setState({ skills })
  return harness
}

function entry(serverId: string): LocalSkill | undefined {
  return useStore.getState().skills.find((item) => item.serverId === serverId)
}

const keyA = aiAnalysisJobKey(ACCOUNT_A, 'server-a')
const keyB = aiAnalysisJobKey(ACCOUNT_A, 'server-b')

test('a click starts one background job that writes only the analysed profile fields and then releases', async () => {
  const h = setup([skill('a', 'server-a', { avatarUrl: 'https://cdn.example/a.png' })])
  const run = runSkillAiAnalysis(h.env, { skill: entry('server-a')!, serverId: 'server-a' })
  assert.equal(useStore.getState().aiAnalysisJobs[keyA]?.accountUserId, ACCOUNT_A)
  await tick()
  assert.equal(h.analyzeCalls.length, 1)
  assert.equal(h.analyzeCalls[0].space, fixtureSpace('space-a'))
  assert.deepEqual(h.analyzeCalls[0].expectedProfile, { displayName: 'server', description: null, category: null, labels: [], triggerScenarios: [] })
  // Unrelated fields that change meanwhile are kept: the result never replays a stale object.
  useStore.setState({ skills: [{ ...entry('server-a')!, installed: true }] })
  h.analyzeCalls[0].reply.resolve(aiResult('新名字'))
  assert.equal(await run, 'applied')
  const updated = entry('server-a')!
  assert.equal(updated.displayName, '新名字')
  assert.deepEqual(updated.labels, ['AI'])
  assert.deepEqual(updated.fitScenarios, ['新场景'])
  assert.equal(updated.installed, true)
  assert.equal(updated.avatarUrl, 'https://cdn.example/a.png')
  assert.deepEqual(h.localWrites.map((write) => write.skillId), ['a'])
  assert.equal(useStore.getState().aiAnalysisJobs[keyA], undefined)
  assert.deepEqual(h.notices, [{ message: '「新名字」AI 分析完成，资料已更新', kind: 'default' }])
})

test('repeated clicks on the same Skill send exactly one request', async () => {
  const h = setup([skill('a', 'server-a')])
  const first = runSkillAiAnalysis(h.env, { skill: entry('server-a')!, serverId: 'server-a' })
  const second = runSkillAiAnalysis(h.env, { skill: entry('server-a')!, serverId: 'server-a' })
  assert.equal(await second, 'duplicate')
  await tick()
  assert.equal(h.analyzeCalls.length, 1)
  h.analyzeCalls[0].reply.resolve(aiResult('A'))
  assert.equal(await first, 'applied')
  // Released: a later click may analyse again.
  const third = runSkillAiAnalysis(h.env, { skill: entry('server-a')!, serverId: 'server-a' })
  await tick()
  assert.equal(h.analyzeCalls.length, 2)
  h.analyzeCalls[1].reply.resolve(aiResult('A2'))
  assert.equal(await third, 'applied')
})

test('closing the sheet, switching pages and switching A→B→A keeps each job and its result separate', async () => {
  const h = setup([skill('a', 'server-a'), skill('b', 'server-b')])
  useStore.getState().openSkillSheet('a')
  const runA = runSkillAiAnalysis(h.env, { skill: entry('server-a')!, serverId: 'server-a' })
  useStore.getState().openSkillSheet('b')
  const runB = runSkillAiAnalysis(h.env, { skill: entry('server-b')!, serverId: 'server-b' })
  useStore.getState().closeSheet()
  useStore.getState().setView('settings')
  await tick()
  assert.equal(h.analyzeCalls.length, 2)
  useStore.getState().setView('skills')
  useStore.getState().openSkillSheet('a')
  assert.ok(useStore.getState().aiAnalysisJobs[keyA])
  assert.ok(useStore.getState().aiAnalysisJobs[keyB])
  // Out of order: B returns first; A stays running and untouched.
  h.analyzeCalls[1].reply.resolve(aiResult('B 新'))
  assert.equal(await runB, 'applied')
  assert.equal(entry('server-b')!.displayName, 'B 新')
  assert.equal(entry('server-a')!.displayName, 'Skill a')
  assert.ok(useStore.getState().aiAnalysisJobs[keyA])
  assert.equal(useStore.getState().aiAnalysisJobs[keyB], undefined)
  h.analyzeCalls[0].reply.resolve(aiResult('A 新'))
  assert.equal(await runA, 'applied')
  assert.equal(entry('server-a')!.displayName, 'A 新')
  assert.equal(entry('server-b')!.displayName, 'B 新')
  assert.deepEqual(useStore.getState().aiAnalysisJobs, {})
})

test('an account switch discards the late result without notices, writes or job resurrection', async () => {
  const h = setup([skill('a', 'server-a')])
  const run = runSkillAiAnalysis(h.env, { skill: entry('server-a')!, serverId: 'server-a' })
  await tick()
  signIn(ACCOUNT_B, fixtureSpace('space-b'), h)
  assert.deepEqual(useStore.getState().aiAnalysisJobs, {})
  const before = entry('server-a')
  h.analyzeCalls[0].reply.resolve(aiResult('不该出现'))
  assert.equal(await run, 'discarded')
  assert.deepEqual(h.notices, [])
  assert.deepEqual(h.localWrites, [])
  assert.equal(entry('server-a'), before)
  assert.deepEqual(useStore.getState().aiAnalysisJobs, {})
})

test('logout and same-account re-login with a new space both discard the old job', async () => {
  const h = setup([skill('a', 'server-a')])
  const loggedOut = runSkillAiAnalysis(h.env, { skill: entry('server-a')!, serverId: 'server-a' })
  await tick()
  useStore.getState().clearAuthSession()
  h.space.value = null
  h.analyzeCalls[0].reply.resolve(aiResult('X'))
  assert.equal(await loggedOut, 'discarded')

  signIn(ACCOUNT_A, fixtureSpace('space-a'), h)
  useStore.setState({ skills: [skill('a', 'server-a')] })
  const relogin = runSkillAiAnalysis(h.env, { skill: entry('server-a')!, serverId: 'server-a' })
  await tick()
  signIn(ACCOUNT_A, fixtureSpace('space-a2'), h)
  useStore.setState({ skills: [skill('a', 'server-a')] })
  h.analyzeCalls[1].reply.resolve(aiResult('Y'))
  assert.equal(await relogin, 'discarded')
  assert.deepEqual(h.notices, [])
  assert.deepEqual(h.localWrites, [])
  assert.equal(entry('server-a')!.displayName, 'Skill a')
})

test('a stale job finishing late never releases the newer job of the same Skill', async () => {
  const h = setup([skill('a', 'server-a')])
  const old = runSkillAiAnalysis(h.env, { skill: entry('server-a')!, serverId: 'server-a' })
  await tick()
  signIn(ACCOUNT_B, fixtureSpace('space-b'), h)
  signIn(ACCOUNT_A, fixtureSpace('space-a3'), h)
  useStore.setState({ skills: [skill('a', 'server-a')] })
  const fresh = runSkillAiAnalysis(h.env, { skill: entry('server-a')!, serverId: 'server-a' })
  await tick()
  const freshJobId = useStore.getState().aiAnalysisJobs[keyA]?.id
  assert.ok(freshJobId)
  h.analyzeCalls[0].reply.resolve(aiResult('old'))
  assert.equal(await old, 'discarded')
  assert.equal(useStore.getState().aiAnalysisJobs[keyA]?.id, freshJobId)
  h.analyzeCalls[1].reply.resolve(aiResult('fresh'))
  assert.equal(await fresh, 'applied')
  assert.equal(entry('server-a')!.displayName, 'fresh')
})

test('a profile edited during the analysis is kept and the user is asked to analyse again', async () => {
  const h = setup([skill('a', 'server-a')])
  const run = runSkillAiAnalysis(h.env, { skill: entry('server-a')!, serverId: 'server-a' })
  await tick()
  useStore.getState().replaceSkill('a', { ...entry('server-a')!, description: '用户刚保存的简介' })
  h.analyzeCalls[0].reply.resolve(aiResult('AI 名字'))
  assert.equal(await run, 'conflict')
  assert.equal(entry('server-a')!.description, '用户刚保存的简介')
  assert.equal(entry('server-a')!.displayName, 'Skill a')
  assert.deepEqual(h.localWrites, [])
  assert.deepEqual(h.notices, [{ message: '「Skill a」资料已被修改，请重新分析', kind: 'warn' }])
  assert.equal(h.readbacks(), 1)
  assert.deepEqual(useStore.getState().aiAnalysisJobs, {})
})

test('an entry deleted during the analysis is not resurrected', async () => {
  const h = setup([skill('a', 'server-a')])
  const run = runSkillAiAnalysis(h.env, { skill: entry('server-a')!, serverId: 'server-a' })
  await tick()
  useStore.getState().setSkills([])
  h.analyzeCalls[0].reply.resolve(aiResult('AI'))
  assert.equal(await run, 'missing')
  assert.deepEqual(useStore.getState().skills, [])
  assert.deepEqual(h.localWrites, [])
})

test('a cloud-only author Skill reads the cloud source and updates only the store entry', async () => {
  const h = setup([skill('cloud', 'server-c', { localPath: '' })])
  let sourceSpace: SpaceHandle | null = null
  h.env.fetchSource = async (serverId, space) => { sourceSpace = space; return `# ${serverId}` }
  const run = runSkillAiAnalysis(h.env, { skill: entry('server-c')!, serverId: 'server-c' })
  await tick()
  h.analyzeCalls[0].reply.resolve(aiResult('云端'))
  assert.equal(await run, 'applied')
  assert.equal(sourceSpace, fixtureSpace('space-a'))
  assert.deepEqual(h.localWrites, [])
  assert.equal(entry('server-c')!.displayName, '云端')
})

test('server success with a failed local write reports the partial state and reads back without re-running AI', async () => {
  const h = setup([skill('a', 'server-a')])
  h.failLocalWrite(new Error('磁盘只读'))
  const run = runSkillAiAnalysis(h.env, { skill: entry('server-a')!, serverId: 'server-a' })
  await tick()
  h.analyzeCalls[0].reply.resolve(aiResult('AI'))
  assert.equal(await run, 'partial')
  assert.equal(h.analyzeCalls.length, 1)
  assert.equal(h.readbacks(), 1)
  assert.match(h.notices[0].message, /^「Skill a」云端已更新，本机未同步/)
  assert.equal(entry('server-a')!.displayName, 'Skill a')
  assert.deepEqual(useStore.getState().aiAnalysisJobs, {})
})

const failures: { label: string; error: () => unknown; online?: boolean; message: RegExp; readback: boolean; outcome: string }[] = [
  { label: '401', error: () => new ApiError('http', 'Unauthorized', { status: 401 }), message: /^「Skill a」AI 分析失败：登录已失效/, readback: false, outcome: 'failed' },
  { label: '403', error: () => new ApiError('http', 'Forbidden', { status: 403 }), message: /^「Skill a」AI 分析失败：只有作者本人/, readback: false, outcome: 'failed' },
  { label: '404', error: () => new ApiError('http', 'Not Found', { status: 404 }), message: /^「Skill a」AI 分析失败：云端已找不到/, readback: true, outcome: 'failed' },
  { label: '409', error: () => new ApiError('http', 'conflict', { status: 409, code: 'PROFILE_CONFLICT' }), message: /^「Skill a」资料已被修改，请重新分析$/, readback: true, outcome: 'conflict' },
  { label: '429', error: () => new ApiError('http', 'Too Many Requests', { status: 429, retryAfterSeconds: 30 }), message: /^「Skill a」AI 分析请求过于频繁，请 30 秒后再试$/, readback: false, outcome: 'failed' },
  { label: 'timeout', error: () => new ApiError('timeout', 'Request timed out'), message: /^「Skill a」AI 分析超时，云端结果未确认/, readback: true, outcome: 'failed' },
  { label: 'offline', error: () => new ApiError('network', 'Failed to fetch'), online: false, message: /^「Skill a」AI 分析失败：当前离线/, readback: false, outcome: 'failed' },
  { label: 'connection lost', error: () => new ApiError('network', 'Failed to fetch'), message: /^「Skill a」AI 分析连接中断，云端结果未确认/, readback: true, outcome: 'failed' },
]

for (const failure of failures) {
  test(`${failure.label} gives an accurate notice naming the Skill, releases the job and is not retried`, async () => {
    const h = setup([skill('a', 'server-a')])
    h.online.value = failure.online ?? true
    const run = runSkillAiAnalysis(h.env, { skill: entry('server-a')!, serverId: 'server-a' })
    await tick()
    h.analyzeCalls[0].reply.reject(failure.error())
    assert.equal(await run, failure.outcome)
    assert.equal(h.analyzeCalls.length, 1)
    assert.equal(h.notices.length, 1)
    assert.match(h.notices[0].message, failure.message)
    assert.equal(h.readbacks(), failure.readback ? 1 : 0)
    assert.deepEqual(useStore.getState().aiAnalysisJobs, {})
    assert.equal(entry('server-a')!.displayName, 'Skill a')
    assert.deepEqual(h.localWrites, [])
  })
}

test('a 401 that already cleared this session is still explained to the user', async () => {
  const h = setup([skill('a', 'server-a')])
  const run = runSkillAiAnalysis(h.env, { skill: entry('server-a')!, serverId: 'server-a' })
  await tick()
  h.space.value = null
  useStore.getState().clearAuthSession()
  h.analyzeCalls[0].reply.reject(new ApiError('http', 'Unauthorized', { status: 401 }))
  assert.equal(await run, 'failed')
  assert.match(h.notices[0].message, /登录已失效/)
})

test('a fallback result keeps the existing profile and releases the job', async () => {
  const h = setup([skill('a', 'server-a')])
  const run = runSkillAiAnalysis(h.env, { skill: entry('server-a')!, serverId: 'server-a' })
  await tick()
  h.analyzeCalls[0].reply.resolve(aiResult('不应写入', 'fallback'))
  assert.equal(await run, 'fallback')
  assert.equal(entry('server-a')!.displayName, 'Skill a')
  assert.deepEqual(h.localWrites, [])
  assert.match(h.notices[0].message, /^「Skill a」AI 服务本次未返回有效资料，已保留现有内容/)
  assert.deepEqual(useStore.getState().aiAnalysisJobs, {})
})

test('failures before the request (local read) also release the job', async () => {
  const h = setup([skill('a', 'server-a')])
  h.env.readLocalSkillMd = async () => { throw new Error('找不到 SKILL.md') }
  assert.equal(await runSkillAiAnalysis(h.env, { skill: entry('server-a')!, serverId: 'server-a' }), 'failed')
  assert.equal(h.analyzeCalls.length, 0)
  assert.match(h.notices[0].message, /^「Skill a」AI 分析失败：找不到 SKILL\.md$/)
  assert.deepEqual(useStore.getState().aiAnalysisJobs, {})
})

test('without a session the click is refused and no job is registered', async () => {
  const h = setup([skill('a', 'server-a')])
  useStore.getState().clearAuthSession()
  h.space.value = null
  assert.equal(await runSkillAiAnalysis(h.env, { skill: skill('a', 'server-a'), serverId: 'server-a' }), 'unavailable')
  assert.deepEqual(useStore.getState().aiAnalysisJobs, {})
})

test('the store refuses to register a job for an account that is not signed in', () => {
  setup([skill('a', 'server-a')])
  useStore.getState().startAiAnalysisJob({ id: 'x', key: aiAnalysisJobKey(ACCOUNT_B, 'server-a'), serverId: 'server-a', accountUserId: ACCOUNT_B, skillName: 'a', startedAt: 0 })
  assert.deepEqual(useStore.getState().aiAnalysisJobs, {})
})

test('describeAiAnalysisFailure omits a missing Retry-After instead of inventing one', () => {
  assert.equal(describeAiAnalysisFailure('X', new ApiError('http', 'busy', { status: 429 }), true).message, '「X」AI 分析请求过于频繁，请稍后再试')
})

test('the detail sheet starts analysis on click from the store job, with an inline notice instead of a modal', () => {
  const start = sheet.indexOf('function ProfilePanel(')
  const end = sheet.indexOf('\nfunction ', start + 10)
  const panel = sheet.slice(start, end)
  assert.match(panel, /state\.aiAnalysisJobs\[aiAnalysisJobKey\(currentUser\.id, ownedServerId\)\]/)
  assert.match(panel, /void runSkillAiAnalysis\(aiAnalysisEnvironment, \{ skill, serverId: ownedServerId \}\)/)
  assert.match(panel, /onClick=\{analyze\}/)
  assert.match(panel, /analysisRunning \? '分析中' : 'AI 分析'/)
  assert.match(panel, /className="profile-analysis-note" role="note"/)
  assert.match(panel, /脱敏后的 SKILL\.md 发送给服务端 AI/)
  assert.doesNotMatch(panel, /analysisOpen|重新分析这个 Skill？|确认分析/)
  // The job itself is wired at module scope, not inside a component.
  assert.match(sheet, /^const aiAnalysisEnvironment: AiAnalysisEnvironment = \{/m)
  assert.match(sheet, /analyze: \(serverId, skillMd, expectedProfile, space\) => apiAnalyzeSkill\(serverId, skillMd, \{ expectedProfile, space: space \}\)/)
})
