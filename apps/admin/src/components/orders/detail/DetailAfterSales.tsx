import { AFTER_SALE_REASON_LABEL, AFTER_SALE_STATUS_LABEL } from '../../../types'
import { fmtMonthDayTime } from '../../../utils/time'
import type { OrderDetail } from '../../../types'

export default function DetailAfterSales({ order }: { order: OrderDetail }) {
  const list = order.afterSales ?? []
  return (
    <div className="bg-white rounded-lg shadow-card p-3 md:p-4 space-y-2">
      <h3 className="text-sm font-semibold text-gray-800">售后</h3>
      {list.length === 0 ? (
        <p className="text-xs text-gray-400">没有售后申请</p>
      ) : (
        <div className="divide-y divide-gray-100">
          {list.map((a) => (
            <div key={a.id} className="py-1.5 space-y-1">
              <div className="flex items-center gap-2 text-sm">
                <span className="text-gray-800">{AFTER_SALE_REASON_LABEL[a.reason] ?? a.reason}</span>
                <span className="px-1.5 py-0.5 rounded text-xs bg-gray-100 text-gray-600">{AFTER_SALE_STATUS_LABEL[a.status] ?? a.status}</span>
                <span className="ml-auto text-xs text-gray-400">{fmtMonthDayTime(a.createdAt)}</span>
              </div>
              {a.description && <p className="text-xs text-gray-500">{a.description}</p>}
              {a.images.length > 0 && (
                <div className="flex gap-1.5 flex-wrap">
                  {a.images.map((src, i) => (
                    <a key={i} href={src} target="_blank" rel="noreferrer">
                      <img src={src} alt="售后图片" className="w-12 h-12 rounded object-cover border border-gray-200" />
                    </a>
                  ))}
                </div>
              )}
              {a.reply && <p className="text-xs text-gray-600">回复：{a.reply}</p>}
              {a.handledAt && (
                <p className="text-xs text-gray-400">
                  处理时间 {fmtMonthDayTime(a.handledAt)}
                  {a.handledBy && ` · ${a.handledBy}`}
                </p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
