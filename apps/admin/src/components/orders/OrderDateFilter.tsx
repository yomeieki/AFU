import { CalendarDays } from 'lucide-react'
import { ORDER_RANGE_PRESETS, orderDateError } from '../../utils/order-date-range'
import type { OrderDateState } from '../../utils/order-date-range'

interface Props {
  value: OrderDateState
  onChange: (s: OrderDateState) => void
}

/** 下单日期筛选：全部/今日/昨日/近7天/近30天/自选 一排 chip；自选展开两个日期框 */
export default function OrderDateFilter({ value, onChange }: Props) {
  const err = orderDateError(value)

  return (
    <div className="flex flex-col md:flex-row md:items-center gap-1.5 md:gap-3">
      <span className="text-xs text-gray-400 shrink-0">下单日期</span>
      <div data-testid="order-date-chips" className="flex flex-nowrap gap-1.5 overflow-hidden">
        {ORDER_RANGE_PRESETS.map((p) => {
          const active = value.range === p.key
          return (
            <button
              key={p.key}
              type="button"
              onClick={() => onChange(p.key === 'custom' ? { ...value, range: 'custom' } : { range: p.key, startDate: '', endDate: '' })}
              aria-label={p.key === 'custom' ? '自选' : undefined}
              className={`rounded-full text-xs px-2 py-1 whitespace-nowrap shrink-0 ${active ? 'bg-brand-500 text-white' : 'bg-gray-100 text-gray-600'}`}
            >
              {p.key === 'custom' ? (
                <>
                  <span className="md:hidden inline-flex"><CalendarDays className="w-3.5 h-3.5" /></span>
                  <span className="hidden md:inline">自选</span>
                </>
              ) : (
                p.label
              )}
            </button>
          )
        })}
      </div>
      {value.range === 'custom' && (
        <div className="flex items-center gap-1.5 flex-wrap">
          <input
            type="date"
            value={value.startDate}
            onChange={(e) => onChange({ ...value, startDate: e.target.value })}
            className="border border-gray-200 rounded-md px-2 py-1 text-xs"
          />
          <span className="text-xs text-gray-400">至</span>
          <input
            type="date"
            value={value.endDate}
            onChange={(e) => onChange({ ...value, endDate: e.target.value })}
            className="border border-gray-200 rounded-md px-2 py-1 text-xs"
          />
          {err && <span className="text-xs text-red-500">{err}</span>}
        </div>
      )}
    </div>
  )
}
