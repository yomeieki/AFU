import { Copy } from 'lucide-react'
import StatusBadge from '../../ui/StatusBadge'
import { copyText } from '../copyText'
import { channelLabel } from '../../../utils/order-detail'
import { fmtDateTimeSec } from '../../../utils/time'
import type { OrderDetail } from '../../../types'

const CHANNEL_TONE: Record<string, string> = {
  LOCAL: 'bg-orange-50 text-orange-700',
  PICKUP: 'bg-teal-50 text-teal-700',
  EXPRESS: 'bg-blue-50 text-blue-700',
}

export default function DetailHero({ order }: { order: OrderDetail }) {
  return (
    <div className="bg-white rounded-lg shadow-card p-3 md:p-4 space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        {/* 状态大字：颜色沿 StatusBadge 的语义，直接复用它而不是另起一套配色表 */}
        <span className="text-base">
          <StatusBadge status={order.status} deliveryType={order.deliveryType} />
        </span>
      </div>
      <div className="flex items-center gap-2 flex-wrap text-sm">
        <span className={`px-1.5 py-0.5 rounded text-xs ${CHANNEL_TONE[order.deliveryType] ?? 'bg-gray-100 text-gray-600'}`}>
          {channelLabel(order.deliveryType)}
        </span>
        <span className="font-mono text-gray-600">{order.orderNo}</span>
        <button onClick={() => copyText(order.orderNo)} className="text-gray-400 hover:text-gray-600" title="复制单号" aria-label="复制单号">
          <Copy className="w-3.5 h-3.5" />
        </button>
      </div>
      <p className="text-xs text-gray-400">下单 {fmtDateTimeSec(order.createdAt)}</p>
    </div>
  )
}
