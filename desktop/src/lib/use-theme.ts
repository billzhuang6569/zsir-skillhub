import { useSyncExternalStore } from 'react'
import { useStore } from '../store/index.js'
import {
  darkSchemeQuery,
  resolveTheme,
  watchSystemDarkScheme,
  type ResolvedTheme,
  type ThemePreference,
} from './theme.js'

function subscribeSystemDark(onChange: () => void): () => void {
  return watchSystemDarkScheme(darkSchemeQuery(), onChange)
}

function systemPrefersDark(): boolean {
  return darkSchemeQuery()?.matches ?? false
}

export type ThemeState = {
  preference: ThemePreference
  resolved: ResolvedTheme
  setPreference: (preference: ThemePreference) => void
}

/** Current theme preference, the theme it resolves to right now, and its setter. */
export function useTheme(): ThemeState {
  const preference = useStore((state) => state.themePreference)
  const setPreference = useStore((state) => state.setThemePreference)
  const prefersDark = useSyncExternalStore(subscribeSystemDark, systemPrefersDark, () => false)
  return { preference, resolved: resolveTheme(preference, prefersDark), setPreference }
}
