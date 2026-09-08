import type { DateRange } from './RangePicker'
export default function ExpressTab({ range }: { range: DateRange }) {
  return <div className="text-sm text-gray-500">全国邮寄板块建设中（{range.startDate} ~ {range.endDate}）</div>
}
