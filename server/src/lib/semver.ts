const SEMVER_CORE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/

export function isStrictSemver(value: string): boolean {
  const match = SEMVER_CORE.exec(value)
  if (!match) return false
  const prerelease = match[4]
  const build = match[5]
  const validIdentifiers = (identifiers: string | undefined, rejectZeroPadding: boolean): boolean => (
    identifiers === undefined
    || identifiers.split('.').every((identifier) => (
      identifier.length > 0
      && /^[0-9A-Za-z-]+$/.test(identifier)
      && (!rejectZeroPadding || !/^\d+$/.test(identifier) || identifier === '0' || !identifier.startsWith('0'))
    ))
  )
  return validIdentifiers(prerelease, true) && validIdentifiers(build, false)
}
