import { useState } from 'react'
import { ChevronDown, ChevronUp, Copy, Phone } from 'lucide-react'
import Spinner from '../../ui/Spinner'
import { copyText } from '../copyText'
import { fmtDateTimeSec } from '../../../utils/time'
import type { ExpressBookingEventInfo, ExpressBookingView, ExpressTrack, OrderDetail } from '../../../types'

function yuan(fen: number) {
  return (fen / 100).toFixed(2)
}

interface Props {
  order: OrderDetail
  data: { booking: ExpressBookingView | null; active: boolean; events: ExpressBookingEventInfo[]; track: ExpressTrack | null } | null
  loading: boolean
  loadFailed: boolean
  onRetry: () => void
}

export default function DetailExpress({ order, data, loading, loadFailed, onRetry }: Props) {
  const [trackOpen, setTrackOpen] = useState(false)
  const [eventsOpen, setEventsOpen] = useState(false)
  const b = data?.booking ?? null
  const s = order.shipment

  const fee = b ? (b.settledFeeFen ?? b.prepaidFeeFen ?? b.quotedFeeFen) : null

  return (
    <div className="bg-white rounded-lg shadow-card p-3 md:p-4 space-y-2">
      <h3 className="text-sm font-semibold text-gray-800">物流</h3>
      <p className="text-sm text-gray-700 flex items-center gap-1.5">
        {s?.expressCompany && s?.expressNo ? (
          <>
            快递 {s.expressCompany} {s.expressNo}
            <button onClick={() => copyText(s.expressNo!)} className="text-gray-400 hover:text-gray-600" title="复制单号" aria-label="复制单号">
              <Copy className="w-3.5 h-3.5" />
            </button>
          </>
        ) : (
          <span className="text-gray-400">未发货</span>
        )}
      </p>

      {loading ? (
        <p className="text-xs text-gray-400 flex items-center gap-1.5"><Spinner className="w-3.5 h-3.5" />加载中…</p>
      ) : loadFailed ? (
        <p className="text-xs text-red-500 flex items-center gap-2">
          加载失败
          <button onClick={onRetry} className="underline">重试</button>
        </p>
      ) : b ? (
        <>
          <p className="text-sm text-gray-700">
            取件 {b.slotText}
            {b.statusLabel && <span className="text-gray-400"> · {b.statusLabel}</span>}
          </p>
          {b.courierName && (
            <p className="text-sm text-gray-700">
              快递员 {b.courierName}
              {b.courierMobile && (
                <a href={`tel:${b.courierMobile}`} className="ml-1.5 text-brand-600 inline-flex items-center gap-1 hover:underline">
                  <Phone className="w-3.5 h-3.5" />
                  {b.courierMobile}
                </a>
              )}
            </p>
          )}
          {b.failReason && <p className="text-xs text-red-500">{b.failReason}</p>}
          <p className="text-sm text-gray-500">
            重量 {b.weightKg} kg{b.billedWeightG ? `（计费 ${(b.billedWeightG / 1000).toFixed(1)} kg）` : ''}
          </p>
          <p className="text-sm text-gray-500">
            运费 顾客付 ¥{yuan(order.shippingFee)}
            {' · 实扣 '}
            {fee != null ? `¥${yuan(fee)}` : '—'}
          </p>
          {data && data.track && data.track.items.length > 0 && (
            <div>
              <button onClick={() => setTrackOpen((v) => !v)} className="inline-flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700">
                {trackOpen ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                {trackOpen ? '收起' : `展开物流轨迹（${data.track.items.length} 条）`}
              </button>
              {trackOpen && (
                <ol className="mt-2 space-y-1.5 border-t border-gray-100 pt-2">
                  {data.track.items.map((it, i) => (
                    <li key={i} className="text-xs text-gray-600 flex gap-2">
                      <span className="text-gray-400 shrink-0">{it.ftime}</span>
                      <span>{it.context}</span>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          )}
          {data && data.events.length > 0 && (
            <div>
              <button onClick={() => setEventsOpen((v) => !v)} className="inline-flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700">
                {eventsOpen ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                {eventsOpen ? '收起' : `展开预约进度（${data.events.length} 条）`}
              </button>
              {eventsOpen && (
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
      ) : (
        <p className="text-xs text-gray-400">尚未预约取件</p>
      )}
    </div>
  )
}
