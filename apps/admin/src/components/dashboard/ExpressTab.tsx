import { AlertTriangle, CheckCircle2 } from 'lucide-react'
import { getExpressStats } from '../../api/admin'
import type { ExpressStats } from '../../types'
import KpiCard from './KpiCard'
import { useStats, StatsShell } from './useStats'
import { fen, hours } from './format'
import type { DateRange } from './RangePicker'

export default function ExpressTab({ range }: { range: DateRange }) {
  const { data, loading, failed, reload } = useStats<ExpressStats>(() => getExpressStats(range), [range.startDate, range.endDate])
  return <StatsShell loading={loading} failed={failed} reload={reload}>{data && <Body d={data} />}</StatsShell>
}

function Body({ d }: { d: ExpressStats }) {
  const k = d.kpi, b = d.backlog
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
        <KpiCard label="邮寄单量" value={String(k.orderCount)} cur={k.orderCount} prev={k.prev.orderCount} />
        <KpiCard label="实收" value={fen(k.revenueFen)} cur={k.revenueFen} prev={k.prev.revenueFen} />
        <KpiCard label="运费收入" value={fen(k.shippingFeeFen)} cur={k.shippingFeeFen} prev={k.prev.shippingFeeFen} />
      </div>

      {b.count > 0 ? (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 flex items-start gap-3 text-sm">
          <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0" />
          <div>
            <p className="font-medium text-amber-800">当前待发货 {b.count} 单</p>
            <p className="text-amber-700 mt-0.5">最久已等 {hours(b.oldestHours)}{b.oldestOrderNo ? `（${b.oldestOrderNo}）` : ''}</p>
            <p className="text-xs text-amber-600 mt-1">这是当前实时数，不随上面的时间范围变化</p>
          </div>
        </div>
      ) : (
        <div className="rounded-lg border border-green-200 bg-green-50 p-4 flex items-center gap-3 text-sm text-green-700">
          <CheckCircle2 className="w-5 h-5 shrink-0" /> 当前无待发货积压
        </div>
      )}

      <div className="bg-white rounded-lg shadow-card p-4 text-sm flex flex-wrap gap-x-8 gap-y-1">
        <span className="text-gray-500">付款→发货</span>
        <span>中位 <b>{hours(d.shipTiming.medianHours)}</b></span>
        <span>最慢(P90) <b>{hours(d.shipTiming.p90Hours)}</b></span>
        <span className="text-gray-500">样本 {d.shipTiming.n}</span>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <SmallTable title="快递公司" rows={d.companies.map((c) => [c.name, c.count])} empty="本期没有发货记录" />
        <SmallTable title="收件地 Top 5" rows={d.regions.map((r) => [r.province, r.count])} empty="本期没有邮寄单" />
      </div>

      <div className="bg-white rounded-lg shadow-card p-4 text-sm flex flex-wrap gap-x-8 gap-y-1">
        <span>退款 <b>{d.afterSales.refundCount}</b> 单 · {fen(d.afterSales.refundFen)}</span>
        <span>售后申请 <b>{d.afterSales.afterSaleCount}</b></span>
      </div>
    </div>
  )
}

function SmallTable({ title, rows, empty }: { title: string; rows: [string, number][]; empty: string }) {
  return (
    <div className="bg-white rounded-lg shadow-card overflow-hidden">
      <p className="text-sm text-gray-500 px-4 pt-4 pb-2">{title}</p>
      <table className="w-full text-sm">
        <tbody className="divide-y divide-gray-100">
          {rows.length === 0 && <tr><td className="px-4 py-6 text-center text-gray-400">{empty}</td></tr>}
          {rows.map(([name, n]) => <tr key={name}><td className="px-4 py-2 text-gray-800">{name}</td><td className="px-4 py-2 text-right">{n}</td></tr>)}
        </tbody>
      </table>
    </div>
  )
}
