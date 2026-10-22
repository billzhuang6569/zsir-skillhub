import type { FastifyBaseLogger } from 'fastify'

export function startStartupRetry(
  task: 'server-settings' | 'instance-identity' | 'setup-code' | 'avatar-styles',
  load: () => Promise<unknown>,
  logger: Pick<FastifyBaseLogger, 'warn'>,
  repeatAfterMs?: number,
  options: { maxDelayMs?: number; failureMessage?: string; failureCode?: string; warnOnce?: boolean } = {},
): () => void {
  let stopped = false
  let failed = false
  let delayMs = 1_000
  let timer: ReturnType<typeof setTimeout> | undefined

  async function attempt(): Promise<void> {
    if (stopped) return
    try {
      await load()
      failed = false
      delayMs = 1_000
      if (!stopped && repeatAfterMs !== undefined) {
        timer = setTimeout(() => { void attempt() }, repeatAfterMs)
        timer.unref()
      }
    } catch {
      if (stopped) return
      // Database and crypto errors may contain secrets; log only fixed task metadata.
      if (!options.warnOnce || !failed) {
        logger.warn({ task, retryInMs: delayMs, ...(options.failureCode ? { code: options.failureCode } : {}) },
          options.failureMessage ?? 'Instance initialization unavailable; retrying in background')
      }
      failed = true
      timer = setTimeout(() => { void attempt() }, delayMs)
      timer.unref()
      delayMs = Math.min(delayMs * 2, options.maxDelayMs ?? 60_000)
    }
  }

  void attempt()
  return () => {
    stopped = true
    clearTimeout(timer)
  }
}
