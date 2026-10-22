export type OnboardingEvidence = { hasSession: boolean; hasManagedSkills: boolean; completed: boolean; introSeen: boolean }
export function onboardingKind(value: OnboardingEvidence): 'welcome' | 'upgrade' | null {
  if (value.completed || value.introSeen) return null
  return value.hasSession || value.hasManagedSkills ? 'upgrade' : 'welcome'
}
export type GuideStep = 'mode' | 'agents' | 'ai' | 'tour' | 'done'
export const GUIDE_STEPS: readonly GuideStep[] = ['mode', 'agents', 'ai', 'tour', 'done']
export const GUIDE_PROGRESS_KEY = 'yitan-skillhub.onboarding.v1.progress'
export function restoreGuideProgress(value: string | null, spaceId: string, selfhostAdmin: boolean): GuideStep | null {
  try {
    const saved: unknown = JSON.parse(value ?? 'null')
    if (!saved || typeof saved !== 'object' || !('step' in saved) || !GUIDE_STEPS.includes(saved.step as GuideStep)) return null
    if (saved.step === 'ai' && (!selfhostAdmin || !('spaceId' in saved) || saved.spaceId !== spaceId)) return 'tour'
    return saved.step as GuideStep
  } catch { return null }
}
export function completionKey(step: GuideStep | 'completed' | 'intro', spaceId: string): string {
  const scope = step === 'mode' || step === 'ai' ? `space:${spaceId}` : 'device'
  return `yitan-skillhub.onboarding.v1.${scope}.${step}`
}
export function nextGuideStep(step: GuideStep, selfhostAdmin: boolean): GuideStep | null {
  const next = GUIDE_STEPS[GUIDE_STEPS.indexOf(step) + 1] ?? null
  return next === 'ai' && !selfhostAdmin ? 'tour' : next
}
export function nextTourTarget(ids: readonly string[], current: number, direction: 1 | -1, exists: (id: string) => boolean): number | null {
  for (let index = current + direction; index >= 0 && index < ids.length; index += direction) {
    if (exists(ids[index])) return index
  }
  return null
}
export function emptyStateActions(capabilities: { teams: boolean }, page: 'skills' | 'teams'): Array<'import' | 'marketplace' | 'create-team'> {
  // The official catalogue is explicitly accessible even in the local space.
  return page === 'skills' ? ['import', 'marketplace'] : capabilities.teams ? ['create-team'] : []
}

export function tourCardPosition(target: { left: number; top: number; right: number; bottom: number } | null, card: { width: number; height: number }, viewport: { width: number; height: number }): { left: number; top: number } | null {
  if (!target || card.width <= 0 || card.height <= 0 || target.right <= target.left || target.bottom <= target.top
    || ![target.left, target.top, target.right, target.bottom, card.width, card.height, viewport.width, viewport.height].every(Number.isFinite)) return null
  const margin = 24, gap = 12
  const clampX = (x: number): number => Math.max(margin, Math.min(x, viewport.width - card.width - margin))
  const clampY = (y: number): number => Math.max(margin, Math.min(y, viewport.height - card.height - margin))
  const candidates = [
    { left: target.right + gap, top: clampY(target.top) },
    { left: target.left - card.width - gap, top: clampY(target.top) },
    { left: clampX(target.left), top: target.bottom + gap },
    { left: clampX(target.left), top: target.top - card.height - gap },
  ]
  return candidates.find(p => p.left >= margin && p.top >= margin && p.left + card.width <= viewport.width - margin && p.top + card.height <= viewport.height - margin)
    ?? { left: clampX(target.right + gap), top: clampY(target.bottom + gap) }
}
