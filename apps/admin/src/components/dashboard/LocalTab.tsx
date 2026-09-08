import type { DateRange } from './RangePicker'
export default function LocalTab({ range }: { range: DateRange }) {
  return <div className="text-sm text-gray-500">同城配送板块建设中（{range.startDate} ~ {range.endDate}）</div>
}
