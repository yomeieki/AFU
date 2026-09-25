import { useState } from 'react'
import { ChevronDown, ChevronUp, Phone } from 'lucide-react'
import StatusBadge from '../../ui/StatusBadge'
import Spinner from '../../ui/Spinner'
import { providerLabel } from '../../../utils/providers'
import { callStrategyLabelWithEscalation, historyEventRows, isSelfDelivery } from '../../../utils/delivery-history'
import { fmtDateTimeSec, fmtHHmmOrDate, fmtMonthDayTime } from '../../../utils/time'
import type { DeliveryEventInfo, DeliveryHistory, DeliveryInfo, OrderDetail as OrderDetailData } from '../../../types'

function yuan(fen: number) {
  return (fen / 100).toFixed(2)
}

const CALL_ORIGIN_LABEL: Record<string, string> = {
  SCHEDULED_AUTO: '到点自动',
  MANUAL_EARLY: '店员提前呼叫',
}

interface Props {
  order: OrderDetailData
  data: { delivery: DeliveryInfo | null; events: DeliveryEventInfo[]; history?: DeliveryHistory | null; costFen: number } | null
  loading: boolean
  loadFailed: boolean
  onRetry: () => void
}

export default function DetailDelivery({ order, data, loading, loadFailed, onRetry }: Props) {
  const [expanded, setExpanded] = useState(false)
  const d = data?.delivery ?? null
  const sc = order.schedule
  // wb-escalation-display：轨迹改用 history（全部配送单事件按时间合并，多于一张单时带 D…-N 标签）；
  // history 缺失（旧响应/加载中）时退回只看最新一张单的旧渲染。
  const historyRows = data?.history ? historyEventRows(data.history) : null
  const eventCount = historyRows ? historyRows.length : (data?.events.length ?? 0)

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
          {/* wb-escalation-display：呼叫方式（自动升级时追加「只呼 X N 分钟无人接，自动升级」）——
              从 history.deliveries 里找当前 d 对应的那张摘要，取它的 escalatedFrom。
              复核 R4：SELF（店内自送）没有运力/呼叫策略这回事，callStrategy 恒 null 会显示
              词不达意的「并呼（旧）」——这一行只在非自送时出现。 */}
          {!isSelfDelivery(d) && (
            <p className="text-sm text-gray-500">呼叫方式 {callStrategyLabelWithEscalation({
              callStrategy: d.callStrategy, calledProviders: d.calledProviders, courierCompany: d.courierCompany,
              escalatedFrom: data?.history?.deliveries.find((x) => x.id === d.id)?.escalatedFrom ?? null,
            })}</p>
          )}
          {d.callOrigin && <p className="text-sm text-gray-500">呼叫来源 {CALL_ORIGIN_LABEL[d.callOrigin] ?? d.callOrigin}</p>}
          {d.failReason && <p className="text-xs text-red-500">失败原因：{d.failReason}</p>}
          {eventCount > 0 && (
            <div>
              <button onClick={() => setExpanded((v) => !v)} className="inline-flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700">
                {expanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                {expanded ? '收起' : `展开配送轨迹（${eventCount} 条）`}
              </button>
              {expanded && (
                <ol className="mt-2 space-y-1.5 border-t border-gray-100 pt-2">
                  {historyRows
                    ? historyRows.map((row) => (
                      <li key={row.id} className="text-xs text-gray-600 flex gap-2">
                        <span className="text-gray-400 shrink-0">{fmtDateTimeSec(row.at)}</span>
                        <span>
                          {row.tag && <span className="text-gray-400">{row.tag} · </span>}
                          {row.text}
                          {row.courierName ? `（${row.courierName}）` : ''}
                          {row.operator ? ` · ${row.operator}` : ''}
                        </span>
                      </li>
                    ))
                    : data!.events.map((ev) => (
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
