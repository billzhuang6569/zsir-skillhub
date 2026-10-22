import type { SpaceHandle } from '../../src/lib/tauri.ts'

const spaces = new Map<string, SpaceHandle>()
export function fixtureSpace(label: string): SpaceHandle {
  let space = spaces.get(label)
  if (!space) { space = { spaceId: 'official', generation: spaces.size + 1 }; spaces.set(label, space) }
  return space
}
