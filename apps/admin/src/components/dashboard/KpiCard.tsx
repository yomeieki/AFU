import { ArrowDownRight, ArrowUpRight } from 'lucide-react'

interface Props {
  label: string
  value: string
  /** 主值下面的一行小字（如「退款后 ¥…」「占比 32%」） */
  sub?: string
  /** 本期与上期的原始数；都传了才显示「较上期」 */
  cur?: number | null
  prev?: number | null
  /** 上升是好事（实收/单数）还是坏事（退款）；默认 up-good */
  deltaTone?: 'up-good' | 'up-bad'
}

export default function KpiCard({ label, value, sub, cur, prev, deltaTone = 'up-good' }: Props) {
  let delta: { text: string; up: boolean } | null = null
  if (cur != null && prev != null) {
    if (prev === 0) delta = cur === 0 ? null : { text: '较上期 —', up: cur > 0 }
    else {
      const r = (cur - prev) / prev
      delta = { text: `较上期 ${r >= 0 ? '+' : ''}${(r * 100).toFixed(0)}%`, up: r >= 0 }
    }
  }
  const good = delta ? (deltaTone === 'up-good' ? delta.up : !delta.up) : true
  return (
    <div className="bg-white rounded-lg shadow-card p-4 min-w-0">
      <p className="text-sm text-gray-500">{label}</p>
      <p className="text-2xl font-bold text-gray-800 mt-1 truncate">{value}</p>
      <div className="mt-1 flex items-center gap-2 text-xs min-h-[1rem]">
        {sub && <span className="text-gray-500 truncate">{sub}</span>}
        {delta && (
          <span className={`inline-flex items-center gap-0.5 ${good ? 'text-green-600' : 'text-red-500'}`}>
            {delta.up ? <ArrowUpRight className="w-3 h-3" /> : <ArrowDownRight className="w-3 h-3" />}
            {delta.text}
          </span>
        )}
      </div>
    </div>
  )
}
