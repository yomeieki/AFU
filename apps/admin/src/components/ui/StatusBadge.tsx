// 状态徽标：色映射唯一收敛处，规范见 docs/design-system.md
const STATUS_MAP: Record<string, { label: string; className: string }> = {
  // 订单状态
  PENDING_PAYMENT: { label: '待付款', className: 'bg-[#fff7e8] text-[#ff9500]' },
  PAID: { label: '待发货', className: 'bg-blue-50 text-blue-600' },
  SHIPPED: { label: '已发货', className: 'bg-cyan-50 text-cyan-700' },
  COMPLETED: { label: '已完成', className: 'bg-green-50 text-green-600' },
  CANCELLED: { label: '已取消', className: 'bg-gray-100 text-gray-500' },
  REFUNDED: { label: '已退款', className: 'bg-red-50 text-red-500' },
  // 商品状态
  ON_SHELF: { label: '上架', className: 'bg-green-50 text-green-600' },
  OFF_SHELF: { label: '下架', className: 'bg-gray-100 text-gray-500' },
}

interface StatusBadgeProps {
  status: string
  /** 覆盖默认文案（如二维码「已生成/未生成」等临时场景请直接用 label+tone） */
  label?: string
}

export default function StatusBadge({ status, label }: StatusBadgeProps) {
  const conf = STATUS_MAP[status] ?? { label: status, className: 'bg-gray-100 text-gray-500' }
  return (
    <span className={`inline-block px-2 py-0.5 rounded-full text-xs whitespace-nowrap ${conf.className}`}>
      {label ?? conf.label}
    </span>
  )
}

export const ORDER_STATUS_LABEL: Record<string, string> = Object.fromEntries(
  Object.entries(STATUS_MAP).map(([k, v]) => [k, v.label])
)
