/**
 * One Skill-list load, in publish order: the local inventory (managed list +
 * unmanaged scan) is published as soon as both native reads settle, without
 * waiting for the Server; the authenticated owned-Skills answer is merged in
 * afterwards. Source errors are kept apart so a failing cloud request never
 * empties a usable local list, and a failing local read never hides cloud data
 * the page already had. `isCurrent` is consulted before every publish so an
 * account switch or a newer load drops stale results.
 */
export type SkillsLoadSources<L, U, O> = {
  local: () => Promise<L>
  unmanaged: () => Promise<U>
  /** `null` when signed out: no cloud phase at all. */
  owned: (() => Promise<O>) | null
}

export type SkillsLoadSinks<L, U, O> = {
  isCurrent: () => boolean
  /** Native results are in: show them now. `null` marks a source that failed. */
  publishLocal: (local: L | null, unmanaged: U | null) => void
  /** The owned-Skills answer arrived after the local publish. */
  publishOwned: (owned: O) => void
  /** The cloud phase failed; the local publish stays as is. */
  publishOwnedFailure: (error: unknown) => void
  /** Combined, user-facing error text (`null` clears). */
  publishError: (message: string | null) => void
  messageOf: (error: unknown) => string
}

export type SkillsLoadOutcome = {
  localFailed: boolean
  unmanagedFailed: boolean
  published: boolean
  /**
   * The cloud phase, still running when this resolves (null when signed out).
   * It is deliberately not awaited by the native phase: a slow or hanging
   * owned-Skills request must never hold up the next native refresh, which the
   * caller may start as soon as the native phase has resolved.
   */
  cloud: Promise<{ ownedFailed: boolean }> | null
}

export async function runSkillsLoad<L, U, O>(
  sources: SkillsLoadSources<L, U, O>,
  sinks: SkillsLoadSinks<L, U, O>,
): Promise<SkillsLoadOutcome> {
  // Start the cloud request now so its latency overlaps the native reads,
  // but never let it gate the local publish.
  const owned = sources.owned
    ? sources.owned().then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    )
    : null
  const [localResult, unmanagedResult] = await Promise.allSettled([sources.local(), sources.unmanaged()])
  const outcome: SkillsLoadOutcome = {
    localFailed: localResult.status === 'rejected',
    unmanagedFailed: unmanagedResult.status === 'rejected',
    published: false,
    cloud: null,
  }
  if (!sinks.isCurrent()) return outcome
  sinks.publishLocal(
    localResult.status === 'fulfilled' ? localResult.value : null,
    unmanagedResult.status === 'fulfilled' ? unmanagedResult.value : null,
  )
  outcome.published = true
  const errors: string[] = []
  if (localResult.status === 'rejected') errors.push(sinks.messageOf(localResult.reason))
  if (unmanagedResult.status === 'rejected') errors.push(sinks.messageOf(unmanagedResult.reason))
  const report = (): void => {
    if (outcome.localFailed && outcome.unmanagedFailed) sinks.publishError(`无法读取本机 Skill：${errors.join('；')}`)
    else if (errors.length > 0) sinks.publishError(`部分数据暂不可用：${errors.join('；')}`)
    else sinks.publishError(null)
  }
  if (errors.length > 0 || !owned) report()
  if (!owned) return outcome
  outcome.cloud = owned.then((cloud) => {
    // The caller's `isCurrent` drops a cloud answer that lands after a newer
    // native publish or an account switch, so an old response never overwrites
    // a fresher local list.
    if (!sinks.isCurrent()) return { ownedFailed: !cloud.ok }
    if (cloud.ok) {
      sinks.publishOwned(cloud.value)
      report()
      return { ownedFailed: false }
    }
    sinks.publishOwnedFailure(cloud.error)
    errors.push(sinks.messageOf(cloud.error))
    report()
    return { ownedFailed: true }
  })
  return outcome
}
