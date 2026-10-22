import { OFFICIAL_ENDPOINTS } from './official-endpoints.ts'

export function docsUrl(slug: string, anchor?: string): string {
  if (!/^[a-z0-9-]+(?:\/[a-z0-9-]+)*$/.test(slug) || (anchor !== undefined && !/^[a-z0-9-]+$/.test(anchor))) {
    throw new Error('无效的文档地址')
  }
  return `${OFFICIAL_ENDPOINTS.docsOrigin.replace(/\/+$/, '')}/${slug}/${anchor ? `#${anchor}` : ''}`
}

// All APP help destinations live here so the guide index can validate them offline.
export const DOC_LINKS = {
  modes: docsUrl('getting-started/choose-mode'),
  start: docsUrl('getting-started/first-open'),
  local: docsUrl('self-host/local-deployment'),
  connect: docsUrl('self-host/connect-app'),
  setup: docsUrl('self-host/create-admin'),
  ai: docsUrl('ai-and-avatars/ai-api'),
  claude: docsUrl('ai-and-avatars/local-claude'),
  fal: docsUrl('ai-and-avatars/fal-key'),
  storage: docsUrl('self-host/object-storage'),
  backup: docsUrl('self-host/backup-restore-upgrade'),
  keys: docsUrl('guides/keys'),
  agents: docsUrl('guides/manage-agent-skills'),
  migrate: docsUrl('account-and-data/migrate-skills'),
  docs: OFFICIAL_ENDPOINTS.docsOrigin,
  storeLogin: docsUrl('account-and-data/store-login'),
  connectionError: docsUrl('self-host/troubleshooting', 'app-connection'),
  setupError: docsUrl('self-host/troubleshooting', 'setup-code-expired'),
  certificateUntrusted: docsUrl('self-host/troubleshooting', 'cert-untrusted'),
  certificateExpired: docsUrl('self-host/troubleshooting', 'cert-expired'),
  certificateName: docsUrl('self-host/troubleshooting', 'cert-name-mismatch'),
  instanceChanged: docsUrl('self-host/troubleshooting', 'instance-changed'),
  hostMismatch: docsUrl('self-host/troubleshooting', 'host-mismatch'),
} as const

export function connectionHelpTopic(code?: string): keyof typeof DOC_LINKS {
  switch (code) {
    case 'certificate_untrusted': return 'certificateUntrusted'
    case 'certificate_expired': return 'certificateExpired'
    case 'certificate_name_mismatch': return 'certificateName'
    case 'instance_changed': return 'instanceChanged'
    case 'host_mismatch': return 'hostMismatch'
    default: return 'connectionError'
  }
}
