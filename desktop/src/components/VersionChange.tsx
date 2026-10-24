import './VersionChange.css'

export default function VersionChange({ current, next }: { current: string; next: string }) {
  return <div className="version-change" aria-label={`当前发布 ${current}，将发布 ${next}`}>
    <div><span>当前发布</span><code>{current}</code></div>
    <span className="version-change-arrow" aria-hidden="true">→</span>
    <div className="next"><span>将发布</span><code>{next}</code></div>
  </div>
}
