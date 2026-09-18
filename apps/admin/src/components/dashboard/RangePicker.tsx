import { QUICK, rangeError, MAX_DAYS, spanDays, matchQuick } from '../../utils/date-range'
import type { DateRange, QuickKey } from '../../utils/date-range'

export { QUICK, rangeError, MAX_DAYS, spanDays, matchQuick }
export type { DateRange, QuickKey }

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
