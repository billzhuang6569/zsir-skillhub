import './EditorialLabels.css'

export function EditorialLabels({ featured = false, labels = [], limit = 3 }: { featured?: boolean; labels?: string[]; limit?: number }) {
  const items = [...(featured ? ['精选'] : []), ...labels]
  if (!items.length) return null
  const visible = limit > 0 ? items.slice(0, limit) : items
  return <span className={`editorial-labels${limit === 0 ? ' expanded' : limit === 2 ? ' list-labels' : ''}`}>
    <span className="editorial-label-line">
      {visible.map((label, index) => <span key={`${index}:${label}`} className={`editorial-chip${featured && index === 0 ? ' featured' : ''}${index > 0 ? ' extra' : ''}`}>{label}</span>)}
      {limit > 0 && <>
        {items.length > limit && <span className="editorial-chip editorial-more wide" aria-label={`还有 ${items.length - limit} 个标签，打开详情查看`}>+{items.length - limit}</span>}
        {items.length > 1 && <span className="editorial-chip editorial-more narrow" aria-label={`还有 ${items.length - 1} 个标签，打开详情查看`}>+{items.length - 1}</span>}
      </>}
    </span>
  </span>
}
