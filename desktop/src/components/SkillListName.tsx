import { useRef } from 'react'
import { truncateSkillName } from '../lib/skill-title.js'
import './SkillListName.css'

export default function SkillListName({ name, className = '' }: { name: string; className?: string }) {
  const ref = useRef<HTMLElement>(null)
  const measure = (): void => {
    const node = ref.current
    const full = node?.querySelector<HTMLElement>('.skill-list-name-full')
    if (!node || !full) return
    const overflow = Math.max(0, full.scrollWidth - node.clientWidth)
    node.style.setProperty('--name-travel', `${-overflow}px`)
    node.dataset.overflow = String(overflow > 0)
  }
  return <strong ref={ref} className={`skill-list-name ${className}`} title={name} aria-label={name} onMouseEnter={measure} onFocus={measure}>
    <span className="skill-list-name-short" aria-hidden="true">{truncateSkillName(name)}</span>
    <span className="skill-list-name-full" aria-hidden="true">{name}</span>
  </strong>
}
