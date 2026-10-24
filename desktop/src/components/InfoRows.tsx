import './InfoRows.css'

export default function InfoRows({ rows }: { rows: Array<{ label: string; value: string | number }> }) {
  return <dl className="info-rows">{rows.map(({ label, value }) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
}
