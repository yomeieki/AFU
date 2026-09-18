import { fmtHHmm, fmtMonthDayTime, sameDayKey } from '../../../utils/time'
import type { TimelineNode } from '../../../utils/order-detail'

const TONE_CLASS: Record<TimelineNode['tone'], string> = {
  ok: 'text-gray-700',
  warn: 'text-amber-600',
  bad: 'text-red-600',
  muted: 'text-gray-400',
}

const DOT_CLASS: Record<TimelineNode['tone'], string> = {
  ok: 'bg-brand-500',
  warn: 'bg-amber-500',
  bad: 'bg-red-500',
  muted: 'bg-gray-300',
}

/** 跨自然日的节点显示 M-DD HH:mm，同一天只显示 HH:mm——与工作台抽屉的紧凑写法一致 */
function fmtNodeTime(at: string, first?: string): string {
  if (!first) return fmtHHmm(at)
  return sameDayKey(at, first) ? fmtHHmm(at) : fmtMonthDayTime(at)
}

export default function DetailTimeline({ nodes }: { nodes: TimelineNode[] }) {
  if (nodes.length === 0) return <p className="text-xs text-gray-400">暂无进度记录</p>
  const first = nodes[0]?.at
  return (
    <ol className="space-y-2.5">
      {nodes.map((n, i) => (
        <li key={i} className="flex gap-2 text-sm">
          <span className={`mt-1.5 w-1.5 h-1.5 rounded-full shrink-0 ${DOT_CLASS[n.tone]}`} />
          <span className="text-xs text-gray-400 shrink-0 w-16 tabular-nums">{fmtNodeTime(n.at, first)}</span>
          <span className={TONE_CLASS[n.tone]}>
            {n.label}
            {n.detail && <span className="text-gray-400"> · {n.detail}</span>}
          </span>
        </li>
      ))}
    </ol>
  )
}
