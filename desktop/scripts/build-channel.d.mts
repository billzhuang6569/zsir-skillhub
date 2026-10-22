export const desktopRoot: string
export function readChannel(channel?: string, root?: string): {
  channel: string
  config: typeof import('../official-channel.json')
  path: string
}
export function checkTauriChannel(config: unknown, channel: string, tauri: unknown): void
export function mergeConfig(base: unknown, patch: unknown): unknown
