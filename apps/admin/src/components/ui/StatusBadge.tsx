// 状态徽标：色映射唯一收敛处，规范见 docs/design-system.md
const STATUS_MAP: Record<string, { label: string; className: string }> = {
  // 订单状态
  PENDING_PAYMENT: { label: '待付款', className: 'bg-[#fff7e8] text-[#ff9500]' },
  PAID: { label: '待接单', className: 'bg-blue-50 text-blue-600' },
  PREPARING: { label: '备餐中', className: 'bg-[#fff7e8] text-[#b45309]' },
  SHIPPED: { label: '已发货', className: 'bg-cyan-50 text-cyan-700' },
  COMPLETED: { label: '已完成', className: 'bg-green-50 text-green-600' },
  CANCELLED: { label: '已取消', className: 'bg-gray-100 text-gray-500' },
  REFUNDING: { label: '退款中', className: 'bg-red-50 text-red-500' },
  REFUNDED: { label: '已退款', className: 'bg-gray-100 text-gray-500' },
  // 商品状态
  ON_SHELF: { label: '上架', className: 'bg-green-50 text-green-600' },
  OFF_SHELF: { label: '下架', className: 'bg-gray-100 text-gray-500' },
  // 配送单状态（CANCELLED 复用上面订单的「已取消」键，文案一致）
  PENDING: { label: '待呼叫', className: 'bg-gray-100 text-gray-500' },
  CALLING: { label: '待抢单', className: 'bg-[#fff7e8] text-[#a15c07]' },
  ACCEPTED: { label: '骑手已接单', className: 'bg-blue-50 text-blue-600' },
  ARRIVING: { label: '赶来取货', className: 'bg-blue-50 text-blue-600' },
  ARRIVED: { label: '已到店', className: 'bg-indigo-50 text-indigo-600' },
  DELIVERING: { label: '配送中', className: 'bg-cyan-50 text-cyan-700' },
  REASSIGNING: { label: '改派中', className: 'bg-[#fff7e8] text-[#a15c07]' },
  ABNORMAL: { label: '配送异常', className: 'bg-red-50 text-red-600' },
  DELIVERED: { label: '已送达', className: 'bg-green-50 text-green-600' },
  FAILED: { label: '呼叫失败', className: 'bg-red-50 text-red-600' },
  UNKNOWN: { label: '状态未确认', className: 'bg-red-50 text-red-600' },
}

/** 自取单复用 PAID/SHIPPED/COMPLETED 三个状态，但店员看到的词不同（spec P8） */
const PICKUP_STATUS_LABEL: Record<string, string> = { PAID: '待接单', SHIPPED: '待取餐', COMPLETED: '已取餐' }
/** 同城外送的 SHIPPED 是「配送中」——StatusBadge 默认是邮寄的「已发货」 */
const LOCAL_STATUS_LABEL: Record<string, string> = { SHIPPED: '配送中' }

export function orderStatusLabel(status: string, deliveryType?: string | null): string {
  const base = STATUS_MAP[status]?.label ?? status
  if (deliveryType === 'PICKUP') return PICKUP_STATUS_LABEL[status] ?? base
  if (deliveryType === 'LOCAL') return LOCAL_STATUS_LABEL[status] ?? base
  return base
}

interface StatusBadgeProps {
  status: string
  /** 覆盖默认文案（如二维码「已生成/未生成」等临时场景请直接用 label+tone） */
  label?: string
  deliveryType?: string | null
}

export default function StatusBadge({ status, label, deliveryType }: StatusBadgeProps) {
  const conf = STATUS_MAP[status] ?? { label: status, className: 'bg-gray-100 text-gray-500' }
  return (
    <span className={`inline-block px-2 py-0.5 rounded-full text-xs whitespace-nowrap ${conf.className}`}>
      {label ?? orderStatusLabel(status, deliveryType)}
    </span>
  )
}

export const ORDER_STATUS_LABEL: Record<string, string> = Object.fromEntries(
  Object.entries(STATUS_MAP).map(([k, v]) => [k, v.label])
)
