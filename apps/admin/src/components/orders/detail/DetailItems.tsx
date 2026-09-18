import type { OrderDetail } from '../../../types'
import { refundedLineFlags } from '../../../utils/order-detail'

function yuan(fen: number) {
  return (fen / 100).toFixed(2)
}

export default function DetailItems({ order }: { order: OrderDetail }) {
  const flags = refundedLineFlags(order)
  const totalQty = order.items.reduce((s, it) => s + it.quantity, 0)

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-800">商品</h3>
        <span className="text-xs text-gray-400">{order.items.length} 种 · {totalQty} 份</span>
      </div>
      <div className="divide-y divide-gray-100">
        {order.items.map((item, i) => (
          <div key={i} className={`py-1.5 flex items-center justify-between gap-2 text-sm ${flags[i] ? 'text-gray-400' : 'text-gray-700'}`}>
            <span className={`truncate ${flags[i] ? 'line-through' : ''}`}>
              {item.isGift && <span className="mr-1 text-[10px] text-orange-600 bg-orange-50 rounded px-1">赠</span>}
              {item.productName}
              {item.specText && <span className="text-gray-400"> [{item.specText}]</span>}
              {flags[i] && <span className="ml-1.5 text-[10px] text-red-500 bg-red-50 rounded px-1">已退</span>}
            </span>
            <span className="shrink-0 text-gray-500 tabular-nums">
              {item.isGift ? `积分 ${item.pointsCost ?? 0}` : `¥${yuan(item.productPrice)}`} × {item.quantity}
            </span>
            <span className={`shrink-0 w-16 text-right tabular-nums ${flags[i] ? 'line-through' : ''}`}>
              {item.isGift ? '—' : `¥${yuan(item.subtotal)}`}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
