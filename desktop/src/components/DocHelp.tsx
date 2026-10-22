import { openUrl } from '@tauri-apps/plugin-opener'
import { DOC_LINKS } from '../lib/docs.js'
import { Icon } from './Icon.js'
import './DocHelp.css'
import { toast } from './Toast.js'

export default function DocHelp({ topic, label, className = 'btn btn-ghost btn-sm', variant }: { topic: keyof typeof DOC_LINKS; label: string; className?: string; variant?: 'section' | 'inline' }) {
  return <button type="button" className={variant ? 'doc-link' : className} aria-label={label}
    onClick={() => void openUrl(DOC_LINKS[topic]).catch(() => toast('无法打开系统浏览器，请稍后重试', 'error'))}>{variant === 'section' && <Icon name="doc" size={13} />}{label}</button>
}
