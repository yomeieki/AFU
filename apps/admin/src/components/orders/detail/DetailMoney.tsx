import { moneyRows } from '../../../utils/order-detail'
import type { OrderDetail } from '../../../types'

function yuan(fen: number) {
  return (fen / 100).toFixed(2)
}

const ROW_CLASS: Record<string, string> = {
  plus: 'text-gray-700',
  minus: 'text-red-500',
  total: 'text-gray-900 font-semibold border-t border-gray-100 pt-1.5 mt-0.5',
  info: 'text-gray-500',
}

export default function DetailMoney({ order }: { order: OrderDetail }) {
  const rows = moneyRows(order)
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-800">金额明细</h3>
        <span className="text-xs text-gray-400">顺序与小票一致</span>
      </div>
      <div className="space-y-1">
        {rows.map((r) => (
          <div key={r.key} className={`flex items-center justify-between text-sm ${ROW_CLASS[r.kind]}`}>
            <span>
              {r.label}
              {r.hint && <span className="ml-1.5 text-xs text-gray-400">{r.hint}</span>}
            </span>
            <span className="tabular-nums">
              {r.kind === 'minus' ? '−' : ''}¥{yuan(r.fen)}
            </span>
          </div>
        ))}
        {(order.pointsUsed ?? 0) > 0 && (
          <div className="flex items-center justify-between text-sm text-gray-400">
            <span>赠品抵扣</span>
            <span>{order.pointsUsed} 积分</span>
          </div>
        )}
      </div>
    </div>
  )
}
