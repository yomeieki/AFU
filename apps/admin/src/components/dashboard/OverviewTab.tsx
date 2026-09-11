import { useState } from 'react'
import { getOverviewStats } from '../../api/admin'
import type { OverviewStats } from '../../types'
import KpiCard from './KpiCard'
import StackedBars from './StackedBars'
import { useStats, StatsShell } from './useStats'
import { fen, pct } from './format'
import type { DateRange } from './RangePicker'

const LOCAL_COLOR = '#f97316'   // 同城：橙（与工作台同城语义一致）
const EXPRESS_COLOR = '#3b82f6' // 邮寄：蓝
const PICKUP_COLOR = '#0d9488'   // 自取：青（与工作台 --pickup 同一语义）

type HotChannel = 'ALL' | 'LOCAL' | 'PICKUP' | 'EXPRESS'

export default function OverviewTab({ range }: { range: DateRange }) {
  const [hotChannel, setHotChannel] = useState<HotChannel>('ALL')
  const { data, loading, failed, reload } = useStats<OverviewStats>(
    () => getOverviewStats({ ...range, channel: hotChannel }),
    [range.startDate, range.endDate, hotChannel],
  )
  return (
    <StatsShell loading={loading} failed={failed} reload={reload}>
      {data && <Body d={data} hotChannel={hotChannel} setHotChannel={setHotChannel} />}
    </StatsShell>
  )
}

function Body({ d, hotChannel, setHotChannel }: { d: OverviewStats; hotChannel: HotChannel; setHotChannel: (c: HotChannel) => void }) {
  const k = d.kpi
  const total = d.channels.LOCAL.revenueFen + d.channels.PICKUP.revenueFen + d.channels.EXPRESS.revenueFen
  const localShare = total ? d.channels.LOCAL.revenueFen / total : 0
  const pickupShare = total ? d.channels.PICKUP.revenueFen / total : 0
  const labels = d.trend.map((t) => t.date.slice(5))
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KpiCard label="实收" value={fen(k.revenueFen)} sub={`退款后 ${fen(k.revenueFen - k.refundFen)}`} cur={k.revenueFen} prev={k.prev.revenueFen} />
        <KpiCard label="订单数" value={String(k.orderCount)} cur={k.orderCount} prev={k.prev.orderCount} />
        <KpiCard label="客单价" value={fen(k.avgOrderFen)} cur={k.avgOrderFen} prev={k.prev.avgOrderFen} />
        <KpiCard label="退款" value={fen(k.refundFen)} sub={`退款率 ${pct(k.revenueFen ? k.refundFen / k.revenueFen : null)}`} cur={k.refundFen} prev={k.prev.refundFen} deltaTone="up-bad" />
      </div>

      <div className="bg-white rounded-lg shadow-card p-4">
        <p className="text-sm text-gray-500 mb-2">渠道占比（按实收）</p>
        <div className="h-3 rounded-full overflow-hidden bg-gray-100 flex">
          {/* 没有实收时留灰底：不然 flex:1 那段会把整条涂成邮寄色，看着像「全是邮寄」 */}
          {total > 0 && <div style={{ width: `${localShare * 100}%`, background: LOCAL_COLOR }} />}
          {total > 0 && <div style={{ width: `${pickupShare * 100}%`, background: PICKUP_COLOR }} />}
          {total > 0 && <div style={{ flex: 1, background: EXPRESS_COLOR }} />}
        </div>
        <div className="mt-2 flex flex-wrap justify-between text-sm text-gray-700">
          <span><i className="inline-block w-2.5 h-2.5 rounded-sm mr-1 align-middle" style={{ background: LOCAL_COLOR }} />同城 {d.channels.LOCAL.orderCount} 单 · {fen(d.channels.LOCAL.revenueFen)}</span>
          <span><i className="inline-block w-2.5 h-2.5 rounded-sm mr-1 align-middle" style={{ background: PICKUP_COLOR }} />自取 {d.channels.PICKUP.orderCount} 单 · {fen(d.channels.PICKUP.revenueFen)}</span>
          <span><i className="inline-block w-2.5 h-2.5 rounded-sm mr-1 align-middle" style={{ background: EXPRESS_COLOR }} />邮寄 {d.channels.EXPRESS.orderCount} 单 · {fen(d.channels.EXPRESS.revenueFen)}</span>
        </div>
      </div>

      <div className="bg-white rounded-lg shadow-card p-4">
        <p className="text-sm text-gray-500 mb-2">日实收趋势</p>
        <StackedBars labels={labels} valueFormatter={(v) => fen(v, 0)}
          series={[
            { name: '同城', color: LOCAL_COLOR, values: d.trend.map((t) => t.LOCAL.revenueFen) },
            { name: '自取', color: PICKUP_COLOR, values: d.trend.map((t) => t.PICKUP.revenueFen) },
            { name: '邮寄', color: EXPRESS_COLOR, values: d.trend.map((t) => t.EXPRESS.revenueFen) },
          ]} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="bg-white rounded-lg shadow-card p-4">
          <p className="text-sm text-gray-500 mb-2">下单时段分布（单数）</p>
          <StackedBars height={180} labels={d.hourly.map((_, h) => `${h}`)} series={[{ name: '订单', color: '#6b7280', values: d.hourly }]} maxXLabels={24} />
        </div>
        <div className="bg-white rounded-lg shadow-card overflow-hidden">
          <div className="flex items-center justify-between px-4 pt-4 pb-2">
            <p className="text-sm text-gray-500">本期热销 Top 5</p>
            <div className="flex rounded-md border border-gray-200 overflow-hidden text-xs">
              {(['ALL', 'LOCAL', 'PICKUP', 'EXPRESS'] as const).map((c) => (
                <button key={c} onClick={() => setHotChannel(c)} className={`px-2 py-1 ${hotChannel === c ? 'bg-brand-500 text-white' : 'text-gray-600'}`}>
                  {c === 'ALL' ? '全部' : c === 'LOCAL' ? '同城' : c === 'PICKUP' ? '自取' : '邮寄'}
                </button>
              ))}
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-gray-600"><tr><th className="text-left px-4 py-2">商品</th><th className="text-right px-4 py-2">售出</th><th className="text-right px-4 py-2">金额</th></tr></thead>
              <tbody className="divide-y divide-gray-100">
                {d.hotProducts.length === 0 && <tr><td colSpan={3} className="px-4 py-6 text-center text-gray-400">本期没有售出记录</td></tr>}
                {d.hotProducts.map((p) => (
                  <tr key={p.productId}><td className="px-4 py-2 text-gray-800">{p.name}</td><td className="px-4 py-2 text-right">{p.qty}</td><td className="px-4 py-2 text-right text-brand-600 font-medium">{fen(p.revenueFen)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div className="bg-white rounded-lg shadow-card p-4 text-sm text-gray-700 flex flex-wrap gap-x-6 gap-y-1">
        <span>顾客 <b>{d.customers.users}</b></span>
        <span>新客 <b>{d.customers.newUsers}</b></span>
        <span>老客 <b>{d.customers.returningUsers}</b></span>
        <span>复购率 <b>{pct(d.customers.repeatRate)}</b></span>
      </div>
    </div>
  )
}
