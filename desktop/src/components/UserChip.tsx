import './UserChip.css'
import { useMediaUrl } from '../lib/media.js'

type UserChipProps = {
  /** Display name. Ignored when `me` is set: the chip then reads 「你」. */
  name: string
  /** The current account: brand tint and the word 你. */
  me?: boolean
  avatarUrl?: string | null
  className?: string
  title?: string
}

export const USER_CHIP_SELF_LABEL = '你'

/**
 * User name as a labelled chip (#289, global rule from the design review):
 * every person's name sits on its own light background so it reads apart
 * from prose; the current user is 「你」 on the brand tint.
 */
export function UserChip({ name, me = false, avatarUrl, className, title }: UserChipProps) {
  const imageUrl = useMediaUrl(avatarUrl)
  const classes = ['user-chip', me ? 'user-chip-me' : '', className].filter(Boolean).join(' ')
  return (
    <span className={classes} title={title ?? (me ? undefined : name)}>
      {imageUrl && !me && <img className="user-chip-avatar" src={imageUrl} alt="" aria-hidden="true" />}
      <span className="user-chip-name">{me ? USER_CHIP_SELF_LABEL : name}</span>
    </span>
  )
}
