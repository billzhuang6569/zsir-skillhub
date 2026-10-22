import { useRef, type KeyboardEvent, type ReactNode } from 'react'
import { Icon, type IconName } from './Icon.js'
import './SegmentedControl.css'

export type SegmentedOption<V extends string> = {
  value: V
  label: ReactNode
  /** Lucide icon shown before the label (design: every segmented control carries icons). */
  icon?: IconName
  /** Small muted count after the label, e.g. `个人 3`. */
  count?: number
  disabled?: boolean
}

type SegmentedControlProps<V extends string> = {
  options: readonly SegmentedOption<V>[]
  value: V
  onChange: (value: V) => void
  'aria-label': string
  /** `tablist` when the control switches panels, `radiogroup` for a setting. */
  mode?: 'tablist' | 'radiogroup'
  size?: 'md' | 'sm'
  className?: string
}

/**
 * Icon + label segmented control (#289). Replaces the page-local `.seg-ctrl`,
 * `.skills-scope-switch` and `.settings-segmented` variants. Arrow keys move
 * the selection; the selected segment is the only tab stop.
 */
export function SegmentedControl<V extends string>({
  options,
  value,
  onChange,
  mode = 'tablist',
  size = 'md',
  className,
  ...aria
}: SegmentedControlProps<V>) {
  const buttons = useRef<Array<HTMLButtonElement | null>>([])
  const itemRole = mode === 'tablist' ? 'tab' : 'radio'

  const move = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const delta = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0
    if (delta === 0) return
    event.preventDefault()
    const enabled = options.map((option, i) => (option.disabled ? -1 : i)).filter((i) => i >= 0)
    const position = enabled.indexOf(index)
    const next = enabled[(position + delta + enabled.length) % enabled.length]
    if (next === undefined) return
    const option = options[next]
    if (!option) return
    onChange(option.value)
    buttons.current[next]?.focus()
  }

  const classes = ['ui-seg', size === 'sm' ? 'ui-seg-sm' : '', className].filter(Boolean).join(' ')
  return (
    <div className={classes} role={mode} aria-label={aria['aria-label']}>
      {options.map((option, index) => {
        const selected = option.value === value
        return (
          <button
            key={option.value}
            ref={(element) => { buttons.current[index] = element }}
            type="button"
            role={itemRole}
            className={`ui-seg-item${selected ? ' ui-seg-on' : ''}`}
            aria-selected={itemRole === 'tab' ? selected : undefined}
            aria-checked={itemRole === 'radio' ? selected : undefined}
            tabIndex={selected ? 0 : -1}
            disabled={option.disabled}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => move(event, index)}
          >
            {option.icon && <Icon name={option.icon} size={size === 'sm' ? 13 : 14} />}
            <span className="ui-seg-label">{option.label}</span>
            {option.count !== undefined && <span className="ui-seg-count">{option.count}</span>}
          </button>
        )
      })}
    </div>
  )
}
