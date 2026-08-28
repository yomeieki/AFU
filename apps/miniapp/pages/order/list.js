const { getOrders } = require('../../api/order')
const { formatPrice } = require('../../utils/format')

var TABS = [
  { label: '全部', status: '' },
  { label: '待付款', status: 'PENDING_PAYMENT' },
  { label: '待发货', status: 'PAID,PREPARING' },
  { label: '已发货', status: 'SHIPPED' },
  { label: '已完成', status: 'COMPLETED' },
  { label: '已取消', status: 'CANCELLED' },
]

var STATUS_LABEL = {
  PENDING_PAYMENT: '待付款',
  PAID: '待发货',
  PREPARING: '备餐中',
  REFUNDING: '退款中',
  SHIPPED: '已发货',
  COMPLETED: '已完成',
  CANCELLED: '已取消',
  REFUNDED: '已退款',
}

Page({
  data: {
    tabs: TABS,
    activeTab: 0,
    orders: [],
    loading: true,
  },

  onLoad(options) {
    if (options.status) {
      var idx = TABS.findIndex(function(t) { return t.status === options.status })
      if (idx >= 0) this.setData({ activeTab: idx })
    }
  },

  onShow() {
    this.loadOrders()
  },

  onTabChange(e) {
    var idx = e.currentTarget.dataset.idx
    this.setData({ activeTab: idx })
    this.loadOrders()
  },

  loadOrders() {
    var self = this
    var status = TABS[this.data.activeTab].status
    this.setData({ loading: true })
    getOrders({ status: status || undefined })
      .then(function(data) {
        self.setData({
          orders: (data.list || []).map(function(order) {
            return Object.assign({}, order, {
              statusLabel: STATUS_LABEL[order.status] || order.status,
              actualAmountText: formatPrice(order.actualAmount),
              firstItem: order.items && order.items[0],
              moreCount: order.items && order.items.length > 1 ? order.items.length - 1 : 0,
            })
          }),
          loading: false,
        })
      })
      .catch(function() {
        self.setData({ loading: false })
      })
  },

  goToDetail(e) {
    var id = e.currentTarget.dataset.id
    wx.navigateTo({ url: '/pages/order/detail?id=' + id })
  },
})
