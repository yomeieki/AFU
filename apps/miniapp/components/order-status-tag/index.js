// 订单状态 → 文案映射（配色在 wxss 按 class 区分，规范见 docs/design-system.md）
const STATUS_LABEL = {
  PENDING_PAYMENT: '待付款',
  PAID: '待发货',
  SHIPPED: '已发货',
  COMPLETED: '已完成',
  CANCELLED: '已取消',
  REFUNDED: '已退款',
}

Component({
  properties: {
    // 后端订单状态枚举
    status: {
      type: String,
      value: '',
      observer(val) {
        this.setData({ label: STATUS_LABEL[val] || val })
      },
    },
  },
  data: {
    label: '',
  },
})
