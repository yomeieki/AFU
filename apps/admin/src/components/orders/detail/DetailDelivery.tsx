import { useState } from 'react'
import { ChevronDown, ChevronUp, Phone } from 'lucide-react'
import StatusBadge from '../../ui/StatusBadge'
import Spinner from '../../ui/Spinner'
import { providerLabel } from '../../../utils/providers'
import { fmtDateTimeSec, fmtHHmmOrDate, fmtMonthDayTime } from '../../../utils/time'
import type { DeliveryEventInfo, DeliveryInfo, OrderDetail as OrderDetailData } from '../../../types'

function yuan(fen: number) {
  return (fen / 100).toFixed(2)
}

const CALL_ORIGIN_LABEL: Record<string, string> = {
  SCHEDULED_AUTO: '到点自动',
  MANUAL_EARLY: '店员提前呼叫',
}

interface Props {
  order: OrderDetailData
  data: { delivery: DeliveryInfo | null; events: DeliveryEventInfo[]; costFen: number } | null
  loading: boolean
  loadFailed: boolean
  onRetry: () => void
}

export default function DetailDelivery({ order, data, loading, loadFailed, onRetry }: Props) {
  const [expanded, setExpanded] = useState(false)
  const d = data?.delivery ?? null
  const sc = order.schedule

  return (
    <div className="bg-white rounded-lg shadow-card p-3 md:p-4 space-y-2">
      <h3 className="text-sm font-semibold text-gray-800">配送</h3>
      {sc && (
        <div className="text-sm text-gray-700 space-y-1">
          <p>出备餐票 {fmtHHmmOrDate(sc.ticketAt)}</p>
          <p>开始备餐 {fmtHHmmOrDate(sc.prepStartAt)}</p>
          <p>该呼叫 {fmtHHmmOrDate(sc.callAt)}</p>
          <p>已备好 {fmtMonthDayTime(sc.readyAt, '未点')}</p>
        </div>
      )}
      {loading ? (
        <p className="text-xs text-gray-400 flex items-center gap-1.5"><Spinner className="w-3.5 h-3.5" />加载中…</p>
      ) : loadFailed ? (
        <p className="text-xs text-red-500 flex items-center gap-2">
          加载失败
          <button onClick={onRetry} className="underline">重试</button>
        </p>
      ) : !d ? (
        <p className="text-xs text-gray-400">尚未呼叫过骑手</p>
      ) : (
        <>
          <div className="flex items-center gap-2 flex-wrap text-sm">
            <span className="text-gray-500">{providerLabel(d.provider)}</span>
            <StatusBadge status={d.status} />
          </div>
          {d.courierName && (
            <p className="text-sm text-gray-700">
              骑手 {d.courierName}
              {d.courierMobile && (
                <a href={`tel:${d.courierMobile}`} className="ml-1.5 text-brand-600 inline-flex items-center gap-1 hover:underline">
                  <Phone className="w-3.5 h-3.5" />
                  {d.courierMobile}
                </a>
              )}
            </p>
          )}
          <p className="text-sm text-gray-500">配送成本 {(data?.costFen ?? 0) > 0 ? `¥${yuan(data!.costFen)}` : '—'}</p>
          {d.callOrigin && <p className="text-sm text-gray-500">呼叫来源 {CALL_ORIGIN_LABEL[d.callOrigin] ?? d.callOrigin}</p>}
          {d.failReason && <p className="text-xs text-red-500">失败原因：{d.failReason}</p>}
          {data && data.events.length > 0 && (
            <div>
              <button onClick={() => setExpanded((v) => !v)} className="inline-flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700">
                {expanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                {expanded ? '收起' : `展开配送轨迹（${data.events.length} 条）`}
              </button>
              {expanded && (
                <ol className="mt-2 space-y-1.5 border-t border-gray-100 pt-2">
                  {data.events.map((ev) => (
                    <li key={ev.id} className="text-xs text-gray-600 flex gap-2">
                      <span className="text-gray-400 shrink-0">{fmtDateTimeSec(ev.createdAt)}</span>
                      <span>
                        {ev.statusDesc ?? ev.source}
                        {ev.courierName ? `（${ev.courierName}）` : ''}
                        {ev.operator ? ` · ${ev.operator}` : ''}
                      </span>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}
