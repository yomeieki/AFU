import { Copy, Phone } from 'lucide-react'
import { copyText } from '../copyText'
import { tablewareLabel } from '../../../utils/tableware'
import { fmtDateTime } from '../../../utils/time'
import type { OrderDetail } from '../../../types'

export default function DetailCustomer({ order }: { order: OrderDetail }) {
  const isPickup = order.deliveryType === 'PICKUP'
  const fullAddressLine = `${order.receiverName} ${order.receiverPhone} ${order.receiverFullAddress}`

  return (
    <div className="bg-white rounded-lg shadow-card p-3 md:p-4 space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-800">{isPickup ? '取餐信息' : '收货信息'}</h3>
        {order.user?.nickname && <span className="text-xs text-gray-400">会员 · {order.user.nickname}</span>}
      </div>
      <p className="text-sm text-gray-700">
        {order.receiverName}
        <span className="mx-1.5" />
        <a href={`tel:${order.receiverPhone}`} className="text-brand-600 inline-flex items-center gap-1 hover:underline">
          <Phone className="w-3.5 h-3.5" />
          {order.receiverPhone}
        </a>
      </p>
      {!isPickup && (
        <p className="text-sm text-gray-700 flex items-start gap-1.5">
          <span>{order.receiverDisplayAddress ?? order.receiverFullAddress}</span>
          <button onClick={() => copyText(fullAddressLine)} className="text-gray-400 hover:text-gray-600 shrink-0" title="复制收件信息" aria-label="复制收件信息">
            <Copy className="w-3.5 h-3.5" />
          </button>
        </p>
      )}
      {isPickup && (
        <div className="text-sm text-gray-700 space-y-1">
          {order.pickupAt && <p>预约取餐 {fmtDateTime(order.pickupAt)}</p>}
          {order.pickupReadyAt && <p>备好 {fmtDateTime(order.pickupReadyAt)}</p>}
          {order.status === 'COMPLETED' && order.completedAt && <p>取走 {fmtDateTime(order.completedAt)}</p>}
        </div>
      )}
      {order.tablewareMode && (order.deliveryType === 'LOCAL' || isPickup) && (
        <p className="text-sm text-gray-600">{tablewareLabel(order.tablewareMode, order.tablewareCount)}</p>
      )}
      {order.remark && <p className="text-xs text-orange-700 bg-orange-50 rounded px-2 py-1">备注：{order.remark}</p>}
    </div>
  )
}
