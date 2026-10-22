/** Every CSS variable name that existed before the design-system tokens (#258) and was deleted in V6 (#263). */
export const LEGACY_TOKEN_NAMES: readonly string[] = [
  'bg', 'bg2', 'surface', 'surface2', 'surface3', 'ink', 'ink1', 'ink2', 'ink3', 'line', 'line2',
  'accent', 'accent-ink', 'accent-soft', 'accent-line', 'violet', 'violet-soft', 'ok', 'ok-soft', 'warn', 'warn-soft',
  'warn-line', 'danger', 'danger-soft', 'danger-line', 'sh1', 'sh2', 'sh3', 'r1', 'r2', 'r3', 'font', 'mono',
]

/** Matches `var(--<legacy>)` / `var(--<legacy>,` and any `--tsh-` name. */
export const LEGACY_TOKEN_PATTERN = new RegExp(`var\\(--(?:${LEGACY_TOKEN_NAMES.map((name) => name.replace(/-/g, '\\-')).join('|')})(?![\\w-])|--tsh-`)
