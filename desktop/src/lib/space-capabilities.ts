import type { ApiHealth } from './api.js'
import type { SpaceHandle } from './tauri.js'

export function spaceProfile(space: SpaceHandle | null): 'official' | 'local' | 'selfhost' {
  return !space || space.spaceId === 'official' ? 'official' : space.spaceId === 'local' ? 'local' : 'selfhost'
}

export function spaceCapabilities(space: SpaceHandle | null, info: ApiHealth | null, pending = false) {
  const profile = spaceProfile(space)
  const online = Boolean(space) && profile !== 'local' && !pending
  const has = (name: string): boolean => online && (info?.capabilities?.includes(name) ?? false)
  return {
    profile, account: online,
    library: has('skills.library-sync.v1'), organizer: has('skills.library-organizer.v1'),
    teams: has('teams.management.v1'), teamKeys: has('teams.management.v1') && has('runtime.env.v1'),
    ai: online && Boolean(info && (info.features?.ai ?? profile === 'official')),
    avatars: online && (info?.features?.avatars ?? has('skills.avatars.v1')),
    avatarUpload: has('media.picem.v1') && has('skills.avatars.v1'),
    uploads: has('skills.packages.v1'),
    marketplace: online && (info?.features?.marketplace ?? has('marketplace.public.v1')),
  }
}
