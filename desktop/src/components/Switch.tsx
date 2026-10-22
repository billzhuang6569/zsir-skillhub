import './Switch.css'

type SwitchProps = {
  checked: boolean
  onChange: (next: boolean) => void
  disabled?: boolean
  /** Busy: keeps the current look, blocks clicks, exposes `aria-busy`. */
  busy?: boolean
  id?: string
  'aria-label'?: string
  'aria-labelledby'?: string
  'aria-describedby'?: string
  className?: string
}

/**
 * `role="switch"` toggle (#289), shared by the 钥匙 / 设置 pages. Space and
 * Enter toggle via the native button; the knob slides with --motion-fast.
 */
export function Switch({ checked, onChange, disabled = false, busy = false, id, className, ...aria }: SwitchProps) {
  const classes = ['ui-switch', checked ? 'ui-switch-on' : '', className].filter(Boolean).join(' ')
  return (
    <button
      type="button"
      role="switch"
      id={id}
      className={classes}
      aria-checked={checked}
      aria-busy={busy || undefined}
      aria-label={aria['aria-label']}
      aria-labelledby={aria['aria-labelledby']}
      aria-describedby={aria['aria-describedby']}
      disabled={disabled}
      onClick={() => {
        if (disabled || busy) return
        onChange(!checked)
      }}
    >
      <span className="ui-switch-knob" aria-hidden="true" />
    </button>
  )
}
