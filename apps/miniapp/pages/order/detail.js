const { getOrderDetail } = require('../../api/order')
const { formatPrice } = require('../../utils/format')

var STATUS_LABEL = {
  PENDING_PAYMENT: '待付款',
  PAID: '待发货',
  SHIPPED: '已发货',
  COMPLETED: '已完成',
  CANCELLED: '已取消',
  REFUNDED: '已退款',
}

Page({
  data: {
    order: null,
    loading: true,
  },

  onLoad(options) {
    var id = options.id
    if (!id) {
      wx.showToast({ title: '订单不存在', icon: 'none' })
      setTimeout(function() { wx.navigateBack() }, 1500)
      return
    }
    this.loadOrder(id)
  },

  loadOrder(id) {
    var self = this
    wx.showLoading({ title: '加载中...' })
    getOrderDetail(id)
      .then(function(order) {
        wx.hideLoading()
        self.setData({
          order: Object.assign({}, order, {
            statusLabel: STATUS_LABEL[order.status] || order.status,
            totalAmountText: formatPrice(order.totalAmount),
            shippingFeeText: formatPrice(order.shippingFee),
            actualAmountText: formatPrice(order.actualAmount),
            createdAtText: new Date(order.createdAt).toLocaleString(),
            paidAtText: order.paidAt ? new Date(order.paidAt).toLocaleString() : null,
            items: order.items.map(function(item) {
              return Object.assign({}, item, {
                priceText: formatPrice(item.productPrice),
                subtotalText: formatPrice(item.subtotal),
              })
            }),
          }),
          loading: false,
        })
      })
      .catch(function() {
        wx.hideLoading()
        self.setData({ loading: false })
        setTimeout(function() { wx.navigateBack() }, 1500)
      })
  },

  onPay() {
    wx.showToast({ title: '支付功能将在下一阶段开发', icon: 'none', duration: 2000 })
  },
})
