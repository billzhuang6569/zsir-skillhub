import type { LocalSkill } from '../store/index.js'

/** Unknown versions are deliberately not treated as upgrades. */
export function compareSkillVersions(left: string, right: string): number | null {
  const parse = (value: string): { numbers: bigint[]; pre: string[] } | null => {
    const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value.trim())
    if (!match) return null
    const pre = match[4]?.split('.') ?? []
    if (pre.some(part => /^\d+$/.test(part) && part.length > 1 && part.startsWith('0'))) return null
    return { numbers: match.slice(1, 4).map(BigInt), pre }
  }
  const a = parse(left); const b = parse(right)
  if (!a || !b) return null
  for (let i = 0; i < 3; i++) if (a.numbers[i] !== b.numbers[i]) return a.numbers[i] > b.numbers[i] ? 1 : -1
  if (!a.pre.length || !b.pre.length) return a.pre.length === b.pre.length ? 0 : a.pre.length ? -1 : 1
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i]; const y = b.pre[i]
    if (x === y) continue
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1
    const xn = /^\d+$/.test(x); const yn = /^\d+$/.test(y)
    if (xn && yn) return BigInt(x) > BigInt(y) ? 1 : -1
    if (xn !== yn) return xn ? -1 : 1
    return x > y ? 1 : -1
  }
  return 0
}

/** SkillHub personal snapshots are local edits of the same upstream release. */
export function isMarketplaceUpgrade(storeVersion: string, localVersion: string): boolean {
  return compareSkillVersions(storeVersion, localVersion.replace(/-personal\.\d+$/, '')) === 1
}

export function marketplaceAction(skill: LocalSkill): { label: string; joined: boolean; update: boolean } {
  const joined = Boolean(skill.marketplaceLocalId || skill.localPath)
  const update = joined && isMarketplaceUpgrade(skill.version, skill.marketplaceLocalVersion ?? skill.version)
  return { joined, update, label: update ? '更新' : joined ? '已加入我的 Skills' : '加入我的 Skills' }
}
