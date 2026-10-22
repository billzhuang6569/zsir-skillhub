import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Icon } from './Icon.js'

type Props = { children: ReactNode }
type State = { error: string | null }

export default class AppErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: unknown): State {
    return { error: error instanceof Error ? error.message : String(error) }
  }

  componentDidCatch(_error: unknown, _info: ErrorInfo): void {
    // The recovery surface intentionally keeps the desktop app usable instead of rendering a blank root.
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children
    return <main className="app-crash-recovery" role="alert">
      <span className="app-crash-icon"><Icon name="warn" size={22} /></span>
      <h1>页面暂时无法显示</h1>
      <p>{this.state.error}</p>
      <button className="btn btn-primary" onClick={() => window.location.reload()}><Icon name="refresh" size={14} />重新载入</button>
    </main>
  }
}
