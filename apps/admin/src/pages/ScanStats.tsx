import { useCallback, useEffect, useState } from 'react'
import { ScanLine, Users, CalendarDays, Percent } from 'lucide-react'
import { getScanSummary, getScanTrend, getScanProducts } from '../api/admin'
import type { ScanSummary, ScanTrendPoint, ScanProductRow } from '../types'
import TrendChart from '../components/ui/TrendChart'
import Table from '../components/ui/Table'
import Pagination from '../components/ui/Pagination'
import Spinner from '../components/ui/Spinner'
import { todayKey, shiftDayKey } from '../utils/time'

/**
 * 查询区间必须按**上海时区**的自然日拼，不能用浏览器本地日。
 *
 * 服务端把扫码记录按 Asia/Shanghai 分桶（server utils/local-day.ts），这里传的
 * startDate/endDate 是直接拿去比对桶名的。原来用 `new Date().getFullYear()/getMonth()/
 * getDate()` 拼——那是**看的人那台电脑**的日期：店主在东七区的电脑上，北京时间
 * 00:00–01:00 之间点「今日」，查到的是上海的昨天，而页面上不会有任何异常提示。
 * 这是本组时区问题里唯一「查错数据」而不只是「显示错」的一处。
 */
function quickRange(days: number) {
  return { startDate: shiftDayKey(-(days - 1)), endDate: todayKey() }
}

const QUICK = [
  { label: '今日', days: 1 },
  { label: '近 7 天', days: 7 },
  { label: '近 30 天', days: 30 },
]

export default function ScanStats() {
  const [range, setRange] = useState(quickRange(7))
  const [activeQuick, setActiveQuick] = useState<number | null>(7)
  const [summary, setSummary] = useState<ScanSummary | null>(null)
  const [trend, setTrend] = useState<ScanTrendPoint[]>([])
  const [rows, setRows] = useState<ScanProductRow[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const pageSize = 10
  const [loading, setLoading] = useState(true)
  // 没有 catch 的话接口一挂就渲染「该时间段暂无扫码记录」和一排「-」，店主会当成真的没人扫码
  const [loadFailed, setLoadFailed] = useState(false)

  const load = useCallback(
    (p: number) => {
      setLoading(true)
      setLoadFailed(false)
      Promise.all([
        getScanSummary(range),
        getScanTrend(range),
        getScanProducts({ ...range, page: p, pageSize }),
      ])
        .then(([s, t, pr]) => {
          setSummary(s.data.data)
          setTrend(t.data.data.list)
          setRows(pr.data.data.list)
          setTotal(pr.data.data.total)
        })
        .catch(() => setLoadFailed(true))
        .finally(() => setLoading(false))
    },
    [range]
  )

  useEffect(() => {
    load(page)
  }, [page, load])

  const applyQuick = (days: number) => {
    setActiveQuick(days)
    setPage(1)
    setRange(quickRange(days))
  }

  const applyCustom = (key: 'startDate' | 'endDate', value: string) => {
    setActiveQuick(null)
    setPage(1)
    setRange((r) => ({ ...r, [key]: value }))
  }

  const rate = summary?.conversion.rate
  const cards = [
    { label: '总扫码次数', value: summary?.totalScans ?? '-', icon: ScanLine, tone: 'bg-brand-50 text-brand-500' },
    { label: '独立访客', value: summary?.uniqueVisitors ?? '-', icon: Users, tone: 'bg-blue-50 text-blue-500' },
    { label: '今日扫码', value: summary?.todayScans ?? '-', icon: CalendarDays, tone: 'bg-green-50 text-green-600' },
    {
      label: '扫码转化率',
      value: rate === null || rate === undefined ? '-' : `${(rate * 100).toFixed(1)}%`,
      icon: Percent,
      tone: 'bg-purple-50 text-purple-500',
    },
  ]

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold text-gray-800">扫码统计</h2>

      {/* 日期筛选 */}
      <div className="bg-white rounded-lg shadow-card p-4 flex flex-wrap items-center gap-3">
        <div className="flex rounded-md border border-gray-200 overflow-hidden">
          {QUICK.map((q) => (
            <button
              key={q.days}
              onClick={() => applyQuick(q.days)}
              className={`px-3 py-1.5 text-sm transition-colors ${
                activeQuick === q.days
                  ? 'bg-brand-500 text-white'
                  : 'text-gray-600 hover:bg-gray-50'
              }`}
            >
              {q.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2 text-sm text-gray-500">
          <input
            type="date"
            value={range.startDate}
            onChange={(e) => applyCustom('startDate', e.target.value)}
            className="border border-gray-200 rounded-md px-2 py-1.5"
          />
          <span>至</span>
          <input
            type="date"
            value={range.endDate}
            onChange={(e) => applyCustom('endDate', e.target.value)}
            className="border border-gray-200 rounded-md px-2 py-1.5"
          />
        </div>
        {loading && <Spinner />}
      </div>

      {loadFailed && (
        <div className="rounded-md bg-red-50 border border-red-200 p-3 text-sm text-red-700 flex items-center justify-between gap-3">
          <span>扫码统计加载失败，下面显示的不是真实数据</span>
          <button onClick={() => load(page)} className="text-red-700 underline shrink-0">重试</button>
        </div>
      )}

      {/* 摘要卡 */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {cards.map((c) => (
          <div key={c.label} className="bg-white rounded-lg shadow-card p-5 flex items-center gap-4">
            <span className={`w-11 h-11 rounded-xl flex items-center justify-center shrink-0 ${c.tone}`}>
              <c.icon className="w-5 h-5" strokeWidth={1.8} />
            </span>
            <div className="min-w-0">
              <p className="text-sm text-gray-500">{c.label}</p>
              <p className="text-2xl font-bold text-gray-800 mt-0.5 truncate">{c.value}</p>
            </div>
          </div>
        ))}
      </div>

      {/* 趋势图 */}
      <div className="bg-white rounded-lg shadow-card p-5">
        <h3 className="text-sm font-medium text-gray-700 mb-3">扫码趋势</h3>
        <TrendChart data={trend.map((t) => ({ label: t.date, value: t.scans }))} type="line" />
      </div>

      {/* 商品聚合表 */}
      <div className="bg-white rounded-lg shadow-card overflow-hidden">
        {loadFailed ? (
          <div className="py-10 text-center text-sm text-red-600">商品扫码明细加载失败，请点上方「重试」</div>
        ) : (
        <Table
          columns={4}
          loading={loading}
          isEmpty={rows.length === 0}
          emptyText="该时间段暂无扫码记录"
          head={
            <tr>
              <th className="text-left px-4 py-3">商品</th>
              <th className="text-right px-4 py-3">扫码次数</th>
              <th className="text-right px-4 py-3">订单数</th>
              <th className="text-right px-4 py-3">转化率</th>
            </tr>
          }
          mobileCards={
            <>
              {rows.map((r) => (
                <div key={r.productId} className="border border-gray-100 rounded-lg p-3">
                  <p className="text-sm font-medium text-gray-800">{r.productName}</p>
                  <div className="mt-1.5 flex gap-4 text-xs text-gray-500">
                    <span>扫码 {r.scans}</span>
                    <span>订单 {r.orders}</span>
                    <span>转化 {r.conversionRate === null ? '-' : `${(r.conversionRate * 100).toFixed(1)}%`}</span>
                  </div>
                </div>
              ))}
            </>
          }
        >
          {rows.map((r) => (
            <tr key={r.productId} className="hover:bg-gray-50">
              <td className="px-4 py-3 text-gray-800">{r.productName}</td>
              <td className="px-4 py-3 text-right text-gray-700">{r.scans}</td>
              <td className="px-4 py-3 text-right text-gray-700">{r.orders}</td>
              <td className="px-4 py-3 text-right text-gray-700">
                {r.conversionRate === null ? '-' : `${(r.conversionRate * 100).toFixed(1)}%`}
              </td>
            </tr>
          ))}
        </Table>
        )}
        {!loading && !loadFailed && total > pageSize && (
          <Pagination page={page} total={total} pageSize={pageSize} onChange={setPage} />
        )}
      </div>
    </div>
  )
}
