import channel from '../../official-channel.json' with { type: 'json' }

// Older dev skillhub.build.json files predate docsOrigin; derive it like build-channel.mjs does.
export function channelDocsOrigin(config: { siteOrigin: string; docsOrigin?: string }): string {
  return config.docsOrigin ?? `${config.siteOrigin.replace(/\/+$/, '')}/docs/`
}

// Vite substitutes this JSON only for an explicitly selected dev build.
export const OFFICIAL_ENDPOINTS = Object.freeze({
  ...channel,
  docsOrigin: channelDocsOrigin(channel),
  updater: Object.freeze({ ...channel.updater }),
})
export const DONATION_PAGE_URL = OFFICIAL_ENDPOINTS.supportOrigin
export const DEEP_LINK_SCHEME = typeof __SKILLHUB_DEV__ !== 'undefined' && __SKILLHUB_DEV__ ? 'skillhub-dev' : 'skillhub'
