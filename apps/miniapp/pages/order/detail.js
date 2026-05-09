const { getOrderDetail } = require('../../api/order')
const { payOrder } = require('../../api/payment')
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
    this._orderId = id
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
    var self = this
    wx.showModal({
      title: '确认支付',
      content: '确认支付此订单？',
      confirmText: '确认',
      success: function(modalRes) {
        if (!modalRes.confirm) return
        wx.showLoading({ title: '支付中...' })
        payOrder(self.data.order.id)
          .then(function(data) {
            wx.hideLoading()
            if (data.mode === 'mock') {
              wx.showToast({ title: '支付成功', icon: 'success', duration: 1500 })
              setTimeout(function() { self.loadOrder(self._orderId) }, 1500)
            } else {
              wx.requestPayment({
                timeStamp: data.timeStamp,
                nonceStr: data.nonceStr,
                package: data.package,
                signType: data.signType,
                paySign: data.paySign,
                success: function() {
                  // Reload from server — actual PAID status is set by backend notify
                  wx.showToast({ title: '支付成功', icon: 'success', duration: 1500 })
                  setTimeout(function() { self.loadOrder(self._orderId) }, 1500)
                },
                fail: function(err) {
                  if (err.errMsg && err.errMsg.indexOf('cancel') !== -1) {
                    wx.showToast({ title: '已取消支付', icon: 'none' })
                  } else {
                    wx.showToast({ title: '支付失败，请重试', icon: 'none' })
                  }
                },
              })
            }
          })
          .catch(function() {
            wx.hideLoading()
          })
      },
    })
  },
})
