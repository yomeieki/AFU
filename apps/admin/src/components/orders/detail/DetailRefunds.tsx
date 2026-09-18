import { REFUND_STATUS_LABEL } from '../../../utils/order-detail'
import { fmtMonthDayTime } from '../../../utils/time'
import type { OrderDetail } from '../../../types'

function yuan(fen: number) {
  return (fen / 100).toFixed(2)
}

const STATUS_TONE: Record<string, string> = {
  SUCCESS: 'text-green-600 bg-green-50',
  FAILED: 'text-red-600 bg-red-50',
  ABNORMAL: 'text-red-600 bg-red-50',
}

export default function DetailRefunds({ order }: { order: OrderDetail }) {
  const refunds = order.refunds ?? []
  return (
    <div className="bg-white rounded-lg shadow-card p-3 md:p-4 space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-800">退款记录</h3>
        <span className="text-xs text-gray-400">全部 {refunds.length} 笔</span>
      </div>
      {refunds.length === 0 ? (
        <p className="text-xs text-gray-400">没有退款记录</p>
      ) : (
        <div className="divide-y divide-gray-100">
          {refunds.map((r) => (
            <div key={r.id} className="py-1.5 space-y-0.5">
              <div className="flex items-center gap-2 text-sm">
                <span className="font-medium text-gray-800">¥{yuan(r.amount)}</span>
                <span className={`px-1.5 py-0.5 rounded text-xs ${STATUS_TONE[r.status] ?? 'text-gray-500 bg-gray-100'}`}>
                  {REFUND_STATUS_LABEL[r.status] ?? r.status}
                </span>
                {r.mode === 'MOCK' && <span className="text-xs text-gray-400">模拟</span>}
                <span className="ml-auto text-xs text-gray-400">{fmtMonthDayTime(r.successTime ?? r.createdAt)}</span>
              </div>
              <p className="text-xs text-gray-500">
                {r.reason}
                {r.reason && ' · '}操作人 {r.operator ?? '系统'}
              </p>
              {r.errorMessage && <p className="text-xs text-red-500">{r.errorMessage}</p>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
