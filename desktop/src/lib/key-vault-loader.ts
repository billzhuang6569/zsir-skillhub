/** One read per load round; change events wait for a fresh read after any older one. */
export function createKeyVaultLoader(load: () => Promise<void>) {
  let inFlight: Promise<void> | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  let generation = 0

  const reload = (): Promise<void> => {
    if (!inFlight) {
      inFlight = Promise.resolve().then(load).finally(() => { inFlight = null })
    }
    return inFlight
  }
  const cancel = (): void => {
    clearTimeout(timer)
    timer = undefined
    generation++
  }
  const schedule = (): void => {
    cancel()
    const expected = generation
    timer = setTimeout(() => {
      timer = undefined
      // A change may arrive after the current read took its snapshot.
      void (async (): Promise<void> => {
        await inFlight?.catch(() => undefined)
        if (expected === generation) await reload()
      })().catch(() => undefined)
    }, 150)
  }
  return { reload, schedule, cancel }
}
