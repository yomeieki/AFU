import { useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import RangePicker, { QUICK, rangeError, type DateRange } from '../components/dashboard/RangePicker'
import OverviewTab from '../components/dashboard/OverviewTab'
import LocalTab from '../components/dashboard/LocalTab'
import ExpressTab from '../components/dashboard/ExpressTab'

type Tab = 'overview' | 'local' | 'express'
const TABS: { key: Tab; label: string }[] = [
  { key: 'overview', label: '总览' },
  { key: 'local', label: '同城配送' },
  { key: 'express', label: '全国邮寄' },
]

/**
 * 经营概览：统一时间范围 + 三个 tab。tab 与范围都写进 URL（?tab=&start=&end=），刷新不丢。
 * 三个 tab 各拉各的接口（components/dashboard/*Tab.tsx），切换只重拉当前这个。
 */
export default function Dashboard() {
  const [sp, setSp] = useSearchParams()
  const tab: Tab = (TABS.find((t) => t.key === sp.get('tab'))?.key ?? 'overview') as Tab
  const range: DateRange = useMemo(() => {
    const s = sp.get('start'), e = sp.get('end')
    return s && e ? { startDate: s, endDate: e } : QUICK[2].range()   // 默认近 7 天
  }, [sp])

  const setTab = (t: Tab) => setSp((p) => { p.set('tab', t); return p }, { replace: true })
  const setRange = (r: DateRange) => setSp((p) => { p.set('start', r.startDate); p.set('end', r.endDate); return p }, { replace: true })
  const err = rangeError(range)

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold text-gray-800">经营概览</h2>
      <RangePicker value={range} onChange={setRange} />
      <div className="flex gap-2 border-b border-gray-200" role="tablist">
        {TABS.map((t) => (
          <button key={t.key} role="tab" aria-selected={tab === t.key} onClick={() => setTab(t.key)}
            className={`px-4 py-2 text-sm -mb-px border-b-2 ${tab === t.key ? 'border-brand-500 text-brand-600 font-medium' : 'border-transparent text-gray-500'}`}>
            {t.label}
          </button>
        ))}
      </div>
      {err ? (
        <div className="text-sm text-gray-500">请先把上面的时间范围改正确。</div>
      ) : tab === 'overview' ? <OverviewTab range={range} />
        : tab === 'local' ? <LocalTab range={range} />
        : <ExpressTab range={range} />}
    </div>
  )
}
