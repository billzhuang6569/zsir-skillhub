import type { AgentInfo } from '../lib/tauri.js'
import './AgentBrandIcon.css'
import claudeLogo from '../assets/agents/claude.png'
import chatgptLogo from '../assets/agents/chatgpt.png'
import workbuddyLogo from '../assets/agents/workbuddy.png'
import doubaoLogo from '../assets/agents/doubao.png'
import traeLogo from '../assets/agents/trae.png'

const productLogos: Record<string, string> = { claude: claudeLogo, codex: chatgptLogo, workbuddy: workbuddyLogo, doubao: doubaoLogo, trae: traeLogo }

type AgentIdentity = Pick<AgentInfo, 'key' | 'name'>

function AgentGlyph({ agentKey }: { agentKey: string }) {
  if (agentKey === 'claude') {
    return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v18M4.2 7.5l15.6 9M4.2 16.5l15.6-9M7.5 4.2l9 15.6M16.5 4.2l-9 15.6" /></svg>
  }
  if (agentKey === 'codex') {
    return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4.1a4.25 4.25 0 0 1 7.5 2.72A4.25 4.25 0 0 1 19 15.2a4.25 4.25 0 0 1-7 4.7 4.25 4.25 0 0 1-7.5-2.72A4.25 4.25 0 0 1 5 8.8 4.25 4.25 0 0 1 12 4.1Z" /><path d="m8.25 9.85 3.75-2.2 3.75 2.2v4.3L12 16.35l-3.75-2.2Z" /></svg>
  }
  if (agentKey === 'agent-skills') {
    return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3.4 7.2 4.15v8.3L12 20l-7.2-4.15v-8.3Z" /><path d="m4.8 7.55 7.2 4.2 7.2-4.2M12 11.75V20" /></svg>
  }
  if (agentKey === 'opencode') {
    return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9.2 7-4 5 4 5M14.8 7l4 5-4 5M13.3 5.8l-2.6 12.4" /></svg>
  }
  if (agentKey === 'openclaw') {
    return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8.4 9.2C5.9 9.1 4 7.7 4 5.7c2.3-.1 4 .8 4.9 2.7M15.6 9.2c2.5-.1 4.4-1.5 4.4-3.5-2.3-.1-4 .8-4.9 2.7M8.2 10.4c0-2.1 1.7-3.8 3.8-3.8s3.8 1.7 3.8 3.8v4.2c0 2.1-1.7 3.8-3.8 3.8s-3.8-1.7-3.8-3.8Z" /><path d="M8.2 12H5.5M18.5 12h-2.7M8.2 15l-2.1 1.6M17.9 16.6 15.8 15" /></svg>
  }
  if (agentKey === 'gemini') {
    return <svg viewBox="0 0 24 24" aria-hidden="true"><path className="agent-gemini-fill" d="M12 2.8c.65 5.15 4.05 8.55 9.2 9.2-5.15.65-8.55 4.05-9.2 9.2-.65-5.15-4.05-8.55-9.2-9.2 5.15-.65 8.55-4.05 9.2-9.2Z" /></svg>
  }
  return <span>{agentKey.slice(0, 2).toLocaleUpperCase()}</span>
}

export default function AgentBrandIcon({ agent, size = 30 }: { agent: AgentIdentity; size?: number }) {
  return <span
    className={`agent-brand-icon agent-brand-${agent.key}`}
    style={{ width: size, height: size }}
    title={agent.name}
    aria-hidden="true"
  >
    {productLogos[agent.key] ? <img src={productLogos[agent.key]} alt="" draggable={false} /> : <AgentGlyph agentKey={agent.key} />}
  </span>
}
