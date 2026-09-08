import { todayKey, shiftDayKey } from '../../utils/time'

export interface DateRange { startDate: string; endDate: string }

export const QUICK = [
  { key: 'today', label: '今日', range: () => ({ startDate: todayKey(), endDate: todayKey() }) },
  { key: 'yesterday', label: '昨日', range: () => ({ startDate: shiftDayKey(-1), endDate: shiftDayKey(-1) }) },
  { key: '7d', label: '近 7 天', range: () => ({ startDate: shiftDayKey(-6), endDate: todayKey() }) },
  { key: '30d', label: '近 30 天', range: () => ({ startDate: shiftDayKey(-29), endDate: todayKey() }) },
] as const
export type QuickKey = (typeof QUICK)[number]['key']

export const MAX_DAYS = 92

/** 两个 YYYY-MM-DD 之间的天数（含端）；纯字符串算，不经本地时区 */
export function spanDays(r: DateRange): number {
  const [a, b] = [r.startDate, r.endDate].map((s) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)))
  return Math.round((b - a) / 86400000) + 1
}
export const rangeError = (r: DateRange): string | null =>
  !r.startDate || !r.endDate ? '请选完整的起止日期'
  : r.endDate < r.startDate ? '结束日期早于开始日期'
  : spanDays(r) > MAX_DAYS ? `最多查 ${MAX_DAYS} 天`
  : null

/** 当前值命中哪个快捷项（用来高亮）；自定义则 null */
export function matchQuick(r: DateRange): QuickKey | null {
  for (const q of QUICK) { const x = q.range(); if (x.startDate === r.startDate && x.endDate === r.endDate) return q.key }
  return null
}

export default function RangePicker({ value, onChange }: { value: DateRange; onChange: (r: DateRange) => void }) {
  const active = matchQuick(value)
  const err = rangeError(value)
  return (
    <div className="bg-white rounded-lg shadow-card p-3 flex flex-wrap items-center gap-3">
      <div className="flex rounded-md border border-gray-200 overflow-hidden">
        {QUICK.map((q) => (
          <button key={q.key} type="button" onClick={() => onChange(q.range())}
            className={`px-3 py-1.5 text-sm transition-colors ${active === q.key ? 'bg-brand-500 text-white' : 'text-gray-600 hover:bg-gray-50'}`}>
            {q.label}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-2 text-sm text-gray-500">
        <input type="date" value={value.startDate} onChange={(e) => onChange({ ...value, startDate: e.target.value })} className="border border-gray-200 rounded-md px-2 py-1.5" />
        <span>至</span>
        <input type="date" value={value.endDate} onChange={(e) => onChange({ ...value, endDate: e.target.value })} className="border border-gray-200 rounded-md px-2 py-1.5" />
      </div>
      {err && <span className="text-xs text-red-500">{err}</span>}
    </div>
  )
}
