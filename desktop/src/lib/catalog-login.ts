export function catalogSettingsMode(profile: string, signedIn: boolean): 'official' | 'signedIn' | 'signedOut' | 'local' {
  return profile === 'official' ? 'official' : signedIn ? 'signedIn' : profile === 'local' ? 'local' : 'signedOut'
}
export function catalogListValues(value: string): string[] {
  return value.split(/[,，、]/).map(item => item.trim()).filter(Boolean).slice(0, 8)
}
export function catalogPublishMode(profile: string): 'official' | 'selfhost' | 'local' {
  return profile === 'official' ? 'official' : profile === 'selfhost' ? 'selfhost' : 'local'
}
export function catalogPending(status?: string): boolean { return status === 'submitted' || status === 'under_review' }
export function catalogSwitchChoice(from: string, to: string, signedIn: boolean, migration: boolean): 'reuse' | 'retain' | null {
  if (migration || from === to) return null
  if (to === 'official' && signedIn) return 'reuse'
  return from === 'official' && to !== 'official' ? 'retain' : null
}
