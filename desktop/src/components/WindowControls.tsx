import { useEffect } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import './WindowControls.css'

function invokeWindowAction(action: 'close' | 'minimize' | 'toggleMaximize'): void {
  const window = getCurrentWindow()
  void window[action]().catch(() => undefined)
}

export default function WindowControls() {
  useEffect(() => {
    let active = true
    let unlisten: (() => void) | undefined
    const current = getCurrentWindow()
    const refresh = async (): Promise<void> => {
      const expanded = await current.isMaximized() || await current.isFullscreen()
      if (!active) return
      document.querySelector('.app-shell')?.classList.toggle('window-expanded', expanded)
      // Portaled overlays live outside .app-shell and read the radius from :root.
      document.documentElement.classList.toggle('window-expanded', expanded)
    }
    void refresh().catch(() => undefined)
    void current.onResized(() => { void refresh().catch(() => undefined) }).then(stop => { if (active) unlisten = stop; else stop() }).catch(() => undefined)
    return () => { active = false; unlisten?.() }
  }, [])
  const windows = typeof navigator !== 'undefined' && /Windows/i.test(navigator.userAgent)
  return <div className={`window-chrome ${windows ? 'windows' : 'macos'}`} data-tauri-drag-region aria-label="窗口控制区">
    <div className="window-controls" aria-label="窗口控制">
      {!windows && <button type="button" className="window-control close" aria-label="关闭窗口" onClick={() => invokeWindowAction('close')} />}
      <button type="button" className="window-control minimize" aria-label="最小化窗口" onClick={() => invokeWindowAction('minimize')}>{windows ? '−' : ''}</button>
      <button type="button" className="window-control maximize" aria-label="最大化或还原窗口" onClick={() => invokeWindowAction('toggleMaximize')}>{windows ? '□' : ''}</button>
      {windows && <button type="button" className="window-control close" aria-label="关闭窗口" onClick={() => invokeWindowAction('close')}>×</button>}
    </div>
    {/* Drag and double-click-to-maximize are both handled natively by Tauri's
        drag-region script (core:default grants internal_toggle_maximize); a
        React double-click handler here would toggle a second time. */}
    <div className="window-drag-region" data-tauri-drag-region aria-hidden="true" />
  </div>
}
