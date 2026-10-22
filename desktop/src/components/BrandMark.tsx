type BrandMarkProps = {
  size?: number
  inverse?: boolean
  className?: string
}

const brandMarkUrl = new URL('../assets/brand-mark.png', import.meta.url).href
const inverseBrandMarkUrl = new URL('../assets/brand-mark-inverse.svg', import.meta.url).href

/** 一探 SkillHub brand mark, rendered from the canonical asset files. */
export function BrandMark({
  size = 32,
  inverse = false,
  className,
}: BrandMarkProps) {
  return (
    <img
      aria-hidden="true"
      className={className}
      draggable={false}
      src={inverse ? inverseBrandMarkUrl : brandMarkUrl}
      alt=""
      width={size}
      height={size}
    />
  )
}
