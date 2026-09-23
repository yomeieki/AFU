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
// 同城（M2，2026-09-23 复审阻塞）：SHIPPED 是骑手在路上，不是「已发货」——
// 邮寄单才用「已发货」，同城顾客看到这四个字会以为快递已经揽收，实际骑手可能
// 还没到店。本文件基线即非 ES5（见 scripts/check-miniapp-es5.mjs 的既有 ✘），
// 新增行仍沿用仓库既有做法（旧式变量声明、不用箭头函数）。
var LOCAL_LABEL = { SHIPPED: '配送中' }

Component({
  properties: {
    // 后端订单状态枚举
    status: { type: String, value: '' },
    // 'EXPRESS' | 'LOCAL' | 'PICKUP'，自取与同城各有一张改写表
    deliveryType: { type: String, value: '' },
    // 是否预约单（order.scheduledAt 非空）。预约送达 2026-09-21 §5.3：PAID 且预约 → 「已预约」
    scheduled: { type: Boolean, value: false },
  },
  data: {
    label: '',
  },
  observers: {
    'status, deliveryType, scheduled': function(status, deliveryType, scheduled) {
      var label = scheduled && status === 'PAID'
        ? '已预约'
        : (deliveryType === 'PICKUP' && PICKUP_LABEL[status]) ? PICKUP_LABEL[status]
        : (deliveryType === 'LOCAL' && LOCAL_LABEL[status]) ? LOCAL_LABEL[status]
        : (STATUS_LABEL[status] || status)
      this.setData({ label: label })
    },
  },
})
