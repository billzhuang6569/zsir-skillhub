import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Icon, type IconName } from './Icon.js'
import { nextRovingIndex } from '../lib/ui-helpers.js'
import { KEYS_PAGE_COPY, skillInitials, type KeySkillChip } from '../lib/keys.js'
import './KeyCard.css'

export type MenuItem = {
  id: string
  label: string
  icon?: IconName
  danger?: boolean
  disabled?: boolean
  onSelect: () => void
}

/**
 * A trigger button with a popup `role="menu"` (#294): ArrowUp/Down/Home/End
 * move between items, Escape and Tab close it and return focus to the
 * trigger, a click outside closes it.
 */
export function MenuButton({ label, items, children, className = 'ico-btn', disabled = false, align = 'end', title }: {
  /** Accessible name of the trigger. */
  label: string
  items: readonly MenuItem[]
  children: ReactNode
  className?: string
  disabled?: boolean
  align?: 'start' | 'end'
  title?: string
}) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const menuId = useId()

  useEffect(() => {
    if (!open) return
    const first = menuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')
    first?.focus()
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node
      if (!menuRef.current?.contains(target) && !triggerRef.current?.contains(target)) setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [open])

  const close = (): void => {
    setOpen(false)
    triggerRef.current?.focus()
  }

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return }
    if (event.key === 'Tab') { event.preventDefault(); close(); return }
    const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'))
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
    const next = nextRovingIndex(index, buttons.length, event.key, 'vertical')
    if (next !== null) { event.preventDefault(); buttons[next]?.focus() }
  }

  return <span className="key-menu-wrap">
    <button
      ref={triggerRef}
      type="button"
      className={className}
      aria-label={label}
      title={title}
      aria-haspopup="menu"
      aria-expanded={open}
      aria-controls={open ? menuId : undefined}
      disabled={disabled}
      onClick={() => setOpen((value) => !value)}
      onKeyDown={(event) => { if (event.key === 'ArrowDown' && !open) { event.preventDefault(); setOpen(true) } }}
    >{children}</button>
    {open && <div ref={menuRef} id={menuId} className={`key-menu key-menu-${align}`} role="menu" aria-label={label} onKeyDown={onMenuKeyDown}>
      {items.map((item) => <button
        key={item.id}
        type="button"
        role="menuitem"
        className={item.danger ? 'key-menu-danger' : undefined}
        disabled={item.disabled}
        onClick={() => { setOpen(false); item.onSelect() }}
      >{item.icon && <Icon name={item.icon} size={14} />}<span>{item.label}</span></button>)}
    </div>}
  </span>
}

/**
 * Main name (mono), the variant label chip 「· 公司」 and the 「默认」 tag
 * (#306, only when the name has several values), then one bare mono tag
 * per alias. `aliasesTitle` marks read-only aliases on a labelled card.
 */
export function KeyNames({ name, aliases, label = null, isDefault = false, showDefault = false, aliasesTitle }: {
  name: string
  aliases: readonly string[]
  label?: string | null
  isDefault?: boolean
  showDefault?: boolean
  aliasesTitle?: string
}) {
  return <span className="key-card-names">
    <code className="key-card-name" title={name}>{name}</code>
    {label && <span className="key-variant-label" title={label}>· {label}</span>}
    {showDefault && isDefault && <span className="key-default-tag">{KEYS_PAGE_COPY.defaultTag}</span>}
    {aliases.map((alias) => <code key={alias} className="key-alias-tag" title={aliasesTitle ?? alias}>{alias}</code>)}
  </span>
}

/**
 * 「可以用这把钥匙的 Skill」: one pressable card per Skill. `aria-pressed`
 * reads the enabled state; read-only chips (team members who are neither
 * holder nor owner) show the state without toggling.
 */
export function KeySkillChipButton({ chip, busy, readOnly = false, onToggle }: {
  chip: KeySkillChip
  busy: boolean
  readOnly?: boolean
  onToggle: (chip: KeySkillChip) => void
}) {
  const state = chip.enabled ? KEYS_PAGE_COPY.enabled : KEYS_PAGE_COPY.disabled
  return <button
    type="button"
    className={`key-skill-chip${chip.enabled ? ' is-on' : ''}`}
    aria-pressed={chip.enabled}
    aria-disabled={readOnly || undefined}
    aria-busy={busy || undefined}
    aria-label={`${chip.name}${chip.sub ? `（${chip.sub}）` : ''}：${state}`}
    disabled={busy}
    onClick={() => { if (!readOnly) onToggle(chip) }}
  >
    <span className="key-skill-avatar" aria-hidden="true">{skillInitials(chip.name)}</span>
    <span className="key-skill-copy">
      <span className="key-skill-name" title={chip.name}>{chip.name}</span>
      {chip.sub && <span className={`key-skill-sub${chip.override ? ' is-override' : ''}`}>{chip.sub}</span>}
    </span>
    <span className="key-skill-badge">{busy ? '…' : state}</span>
  </button>
}

/**
 * One key as a card (#294 boards 4 and 5): the header toggles the Skill list,
 * actions sit to its right, the expanded body holds the chips and extras.
 */
export function KeyCard({ id, tone, open, onToggle, names, meta, summary, actions, panel, children, className }: {
  id: string
  /** Extra class, e.g. `key-card-variant` for a labelled card under its default (#306). */
  className?: string
  tone: 'personal' | 'team'
  open: boolean
  onToggle: () => void
  names: ReactNode
  meta: ReactNode
  summary: string
  actions?: ReactNode
  /** Inline panel under the header (个人「更换」 form, 团队「换新值」 panel). */
  panel?: ReactNode
  children: ReactNode
}) {
  const bodyId = `${id}-body`
  return <article className={`key-card${open ? ' is-open' : ''}${className ? ` ${className}` : ''}`} aria-labelledby={`${id}-head`}>
    <div className="key-card-row">
      <button type="button" id={`${id}-head`} className="key-card-head" aria-expanded={open} aria-controls={bodyId} onClick={onToggle}>
        <span className={`key-card-icon key-card-icon-${tone}`} aria-hidden="true"><Icon name="key-round" size={16} /></span>
        <span className="key-card-main">
          {names}
          <span className="key-card-meta">{meta}</span>
        </span>
        <span className="key-card-summary">{summary}</span>
        <Icon name="chev" size={14} className="key-card-chev" />
      </button>
      {actions && <span className="key-card-actions">{actions}</span>}
    </div>
    {panel && <div className="key-card-panel">{panel}</div>}
    {open && <div className="key-card-body" id={bodyId}>{children}</div>}
  </article>
}

export function KeySkillSection({ title, hint, children }: { title: string; hint: string; children: ReactNode }) {
  return <section className="key-card-section">
    <h3 className="key-card-section-title">{title}<span>{hint}</span></h3>
    {children}
  </section>
}
