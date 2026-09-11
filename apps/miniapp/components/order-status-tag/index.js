// 订单状态 → 文案映射（配色在 wxss 按 class 区分，规范见 docs/design-system.md）
const STATUS_LABEL = {
  PENDING_PAYMENT: '待付款',
  PAID: '待发货',
  PREPARING: '备餐中',
  REFUNDING: '退款中',
  SHIPPED: '已发货',
  COMPLETED: '已完成',
  CANCELLED: '已取消',
  REFUNDED: '已退款',
}
// 自取（2026-09-11）：同一套状态、不同说法
const PICKUP_LABEL = { PAID: '待接单', SHIPPED: '待取餐', COMPLETED: '已取餐' }

Component({
  properties: {
    // 后端订单状态枚举
    status: { type: String, value: '' },
    // 'EXPRESS' | 'LOCAL' | 'PICKUP'，只有 PICKUP 会改文案
    deliveryType: { type: String, value: '' },
  },
  data: {
    label: '',
  },
  observers: {
    'status, deliveryType': function(status, deliveryType) {
      var label = deliveryType === 'PICKUP' && PICKUP_LABEL[status] ? PICKUP_LABEL[status] : (STATUS_LABEL[status] || status)
      this.setData({ label: label })
    },
  },
})
