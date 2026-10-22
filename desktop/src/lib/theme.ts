// APP colour theme (#258). `system` follows the OS through the
// `prefers-color-scheme` rules in design-tokens.css; `light` / `dark` force a
// theme through <html data-theme>, which those rules check first.

export type ThemePreference = 'system' | 'light' | 'dark'
export type ResolvedTheme = 'light' | 'dark'

export const THEME_PREFERENCE_KEY = 'yitan-skillhub.theme-preference.v1'
export const DARK_SCHEME_QUERY = '(prefers-color-scheme: dark)'
export const THEME_PREFERENCES: readonly ThemePreference[] = ['system', 'light', 'dark']
/** Settings 「外观」 segment labels, in THEME_PREFERENCES order (#262). */
export const THEME_PREFERENCE_LABELS: Readonly<Record<ThemePreference, string>> = { system: '跟随系统', light: '浅色', dark: '深色' }

export function parseThemePreference(value: unknown): ThemePreference {
  return value === 'light' || value === 'dark' ? value : 'system'
}

export function resolveTheme(preference: ThemePreference, systemPrefersDark: boolean): ResolvedTheme {
  if (preference === 'system') return systemPrefersDark ? 'dark' : 'light'
  return preference
}

type ThemeRoot = { dataset: Record<string, string | undefined> }

/** Sets `data-theme` for a forced theme and removes it for `system`. */
export function applyThemePreference(root: ThemeRoot, preference: ThemePreference): void {
  if (preference === 'system') delete root.dataset.theme
  else root.dataset.theme = preference
}

type DarkSchemeQuery = Pick<MediaQueryList, 'matches' | 'addEventListener' | 'removeEventListener'>

export function darkSchemeQuery(): DarkSchemeQuery | null {
  try {
    return typeof window === 'undefined' || typeof window.matchMedia !== 'function'
      ? null
      : window.matchMedia(DARK_SCHEME_QUERY)
  } catch {
    return null
  }
}

/** Calls `listener` with the OS dark preference whenever it changes; returns the unsubscribe. */
export function watchSystemDarkScheme(query: DarkSchemeQuery | null, listener: (prefersDark: boolean) => void): () => void {
  if (!query) return () => undefined
  const onChange = (event: { matches: boolean }): void => listener(event.matches)
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}
