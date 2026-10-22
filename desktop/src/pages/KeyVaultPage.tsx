import { useEffect, useMemo } from 'react'
import { useStore } from '../store/index.js'
import { LoadError } from '../components/StateViews.js'
import KeysPage from './KeysPage.js'
import { getKeyVaultSettings, listVaultKeys } from '../lib/tauri.js'
import { ENV_READINESS_CHANGED_EVENT } from '../lib/env-readiness.js'
import { acceptsVaultResponse, loadKeyVault } from '../lib/keys.js'
import { loadFailedMessage } from '../lib/state-copy.js'
import { createKeyVaultLoader } from '../lib/key-vault-loader.js'

/**
 * Binds the personal key vault (#253) to the 「钥匙」 page (#294): it reads
 * the vault into the store slice and re-reads it after any key change.
 * Values are never shown or read here.
 */
export default function KeyVaultPage() {
  const authStatus = useStore((state) => state.authStatus)
  const accountUserId = useStore((state) => state.currentUser?.id ?? null)
  const space = useStore((state) => state.activeSpace)
  const keyVault = useStore((state) => state.keyVault)
  const setKeyVault = useStore((state) => state.setKeyVault)

  const loader = useMemo(() => createKeyVaultLoader(async (): Promise<void> => {
    const next = await loadKeyVault(accountUserId, { listVaultKeys, getKeyVaultSettings })
    if (useStore.getState().activeSpace === space && acceptsVaultResponse(useStore.getState().currentUser?.id ?? null, next)) setKeyVault(next)
  }), [accountUserId, space, setKeyVault])
  const { reload } = loader

  useEffect(() => {
    if (authStatus === 'restoring') return
    void reload()
    const refresh = loader.schedule
    window.addEventListener(ENV_READINESS_CHANGED_EVENT, refresh)
    return () => {
      window.removeEventListener(ENV_READINESS_CHANGED_EVENT, refresh)
      loader.cancel()
    }
  }, [authStatus, loader, reload])

  // The account-level auto-allow switch lives in 设置 › 通用 (#289).
  const notice = keyVault.status === 'error'
    ? <LoadError message={loadFailedMessage('钥匙库', keyVault.error)} onRetry={() => void reload()} />
    : null
  const loading = keyVault.status === 'idle' || keyVault.status === 'loading'

  return <KeysPage
    keys={keyVault.keys}
    autoAllow={keyVault.autoAllow}
    reload={reload}
    busy={loading}
    loading={loading}
    notice={notice}
  />
}
