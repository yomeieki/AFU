import type { ReactNode } from 'react'
import { getLocalStats } from '../../api/admin'
import type { LocalStats } from '../../types'
import { PROVIDER_LABEL } from '../../utils/providers'
import KpiCard from './KpiCard'
import { useStats, StatsShell } from './useStats'
import { fen, pct, minutes, km } from './format'
import type { DateRange } from './RangePicker'

export default function LocalTab({ range }: { range: DateRange }) {
  const { data, loading, failed, reload } = useStats<LocalStats>(() => getLocalStats(range), [range.startDate, range.endDate])
  return <StatsShell loading={loading} failed={failed} reload={reload} hasData={!!data}>{data && <Body d={data} />}</StatsShell>
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return <div className="bg-white rounded-lg shadow-card p-4"><p className="text-sm text-gray-500 mb-2">{title}</p>{children}</div>
}

function Body({ d }: { d: LocalStats }) {
  const k = d.kpi, f = d.freight
  const netGood = f.netFen >= 0
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KpiCard label="同城单量" value={String(k.orderCount)} cur={k.orderCount} prev={k.prev.orderCount} />
        <KpiCard label="实收" value={fen(k.revenueFen)} cur={k.revenueFen} prev={k.prev.revenueFen} />
        <KpiCard label="平均距离" value={km(k.avgDistanceM)} cur={k.avgDistanceM} prev={k.prev.avgDistanceM} deltaTone="up-bad" />
        <KpiCard label="免运费单" value={String(k.freeShipCount)} sub={`占比 ${pct(k.freeShipRate)}`} cur={k.freeShipCount} prev={k.prev.freeShipCount} deltaTone="up-bad" />
      </div>

      <Card title="运费账">
        <dl className="text-sm space-y-1.5">
          <div className="flex justify-between"><dt className="text-gray-600">顾客付运费</dt><dd className="font-medium">{fen(f.customerPaidFen)}</dd></div>
          <div className="flex justify-between"><dt className="text-gray-600">付给骑手 <span className="text-gray-400">（配送费 {fen(f.deliveryFen)} + 小费 {fen(f.tipFen)} + 取消费 {fen(f.cancelFen)}）</span></dt><dd className="font-medium">{fen(f.riderTotalFen)}</dd></div>
          <div className="flex justify-between border-t border-gray-200 pt-1.5">
            <dt className="text-gray-800 font-medium">运费差额</dt>
            <dd className={`font-bold ${netGood ? 'text-green-600' : 'text-red-500'}`}>{netGood ? '盈余 ' : '补贴 '}{fen(Math.abs(f.netFen))}</dd>
          </div>
          {f.unpricedCount > 0 && <div className="text-xs text-amber-600">另有 {f.unpricedCount} 张送达单没有记到配送费（未计入上面的数）</div>}
          <div className="text-xs text-gray-400">上期差额 {f.prev.netFen >= 0 ? '盈余' : '补贴'} {fen(Math.abs(f.prev.netFen))}</div>
        </dl>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="bg-white rounded-lg shadow-card overflow-hidden">
          <p className="text-sm text-gray-500 px-4 pt-4 pb-2">时效（已完成单）</p>
          <div className="overflow-x-auto"><table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-600"><tr><th className="text-left px-4 py-2">阶段</th><th className="text-right px-4 py-2">中位</th><th className="text-right px-4 py-2">最慢(P90)</th><th className="text-right px-4 py-2">样本</th></tr></thead>
            <tbody className="divide-y divide-gray-100">
              {d.timing.stages.map((s) => (
                <tr key={s.key} className={s.key === 'total' ? 'font-medium' : ''}><td className="px-4 py-2">{s.label}</td><td className="px-4 py-2 text-right">{minutes(s.medianMin)}</td><td className="px-4 py-2 text-right">{minutes(s.p90Min)}</td><td className="px-4 py-2 text-right text-gray-500">{s.n}</td></tr>
              ))}
            </tbody></table></div>
        </div>
        <div className="bg-white rounded-lg shadow-card overflow-hidden">
          <p className="text-sm text-gray-500 px-4 pt-4 pb-2">承运商（已送达）</p>
          <div className="overflow-x-auto"><table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-600"><tr><th className="text-left px-4 py-2">运力</th><th className="text-right px-4 py-2">单量</th><th className="text-right px-4 py-2">均价</th><th className="text-right px-4 py-2">呼叫→取货</th></tr></thead>
            <tbody className="divide-y divide-gray-100">
              {d.providers.length === 0 && <tr><td colSpan={4} className="px-4 py-6 text-center text-gray-400">本期没有送达记录</td></tr>}
              {d.providers.map((p) => (
                <tr key={p.provider}><td className="px-4 py-2">{PROVIDER_LABEL[p.provider] ?? p.provider}</td><td className="px-4 py-2 text-right">{p.count}</td><td className="px-4 py-2 text-right">{fen(p.avgFeeFen)}</td><td className="px-4 py-2 text-right">{minutes(p.avgPickupMin)}</td></tr>
              ))}
            </tbody></table></div>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-sm">
        <Card title="呼叫阶梯"><div className="space-y-1"><div>第一级成交 <b>{d.ladder.first}</b></div><div>升到 3 家并呼 <b>{d.ladder.cheapestN}</b></div><div>全呼 <b>{d.ladder.all}</b></div></div></Card>
        <Card title="距离分布"><div className="space-y-1">{d.distance.map((x) => <div key={x.label}>{x.label} <b>{x.count}</b></div>)}</div></Card>
        <Card title="取消"><div className="space-y-1"><div>顾客取消申请 <b>{d.cancels.requested}</b></div><div>配送中取消 <b>{d.cancels.deliveryCancelled}</b></div></div></Card>
      </div>
    </div>
  )
}
