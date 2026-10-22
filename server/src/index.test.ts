import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { setTimeout } from 'node:timers/promises'
import { expect, it } from 'vitest'

it('variants configuration with unavailable verification exits before listen or worker startup', async (): Promise<void> => {
  const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./index.ts', import.meta.url))], {
    env: { ...process.env, NODE_ENV: 'test', JWT_SECRET: 'startup-test-only-no-production-key', AUTH_MODE: 'legacy',
      SKILL_AVATAR_MODEL_READS: 'variants', SKILL_AVATARS_ENABLED: 'false', DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:1/unused' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', chunk => { output += String(chunk) })
  child.stderr.on('data', chunk => { output += String(chunk) })
  const [code] = await once(child, 'exit')
  expect(code).toBe(1)
  expect(output).toContain('Avatar model database verification unavailable')
  expect(output).not.toContain('Server listening')
}, 15_000)

it('the real Server entrypoint listens after registering worker lifecycle hooks', async (): Promise<void> => {
  const probe = createServer()
  await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve))
  const address = probe.address()
  if (!address || typeof address === 'string') throw new Error('Missing test port')
  await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()))
  const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./index.ts', import.meta.url))], {
    env: { ...process.env, NODE_ENV: 'test', HOST: '127.0.0.1', PORT: String(address.port),
      JWT_SECRET: 'startup-test-only-no-production-key', AUTH_MODE: 'legacy', SKILL_AVATARS_ENABLED: 'false',
      DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:1/unused' },
    stdio: 'ignore',
  })
  try {
    let response: Response | undefined
    for (let attempt = 0; attempt < 100 && child.exitCode === null; attempt += 1) {
      try { response = await fetch(`http://127.0.0.1:${address.port}/health`, { signal: AbortSignal.timeout(500) }); break }
      catch { await setTimeout(50) }
    }
    expect(response?.status).toBe(200)
    expect(await response?.json()).toMatchObject({ status: 'ok' })
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit')
      child.kill('SIGTERM')
      await exited
    }
  }
}, 15_000)
