const { getOrderDetail, confirmOrder } = require('../../api/order')
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
              self.pollPaidStatus()
            } else {
              wx.requestPayment({
                timeStamp: data.timeStamp,
                nonceStr: data.nonceStr,
                package: data.package,
                signType: data.signType,
                paySign: data.paySign,
                success: function() {
                  // PAID 状态由后端支付回调异步写入，轮询等待
                  wx.showToast({ title: '支付成功', icon: 'success', duration: 1500 })
                  self.pollPaidStatus()
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

  // 支付后轮询订单状态：1.5s 间隔，最多 8 次，见 PAID 即停
  pollPaidStatus() {
    var self = this
    var attempts = 0
    var maxAttempts = 8

    function check() {
      attempts++
      getOrderDetail(self._orderId)
        .then(function(order) {
          if (order.status !== 'PENDING_PAYMENT') {
            self.loadOrder(self._orderId)
          } else if (attempts < maxAttempts) {
            setTimeout(check, 1500)
          } else {
            wx.showToast({ title: '支付结果确认中，请稍后下拉刷新', icon: 'none', duration: 2500 })
            self.loadOrder(self._orderId)
          }
        })
        .catch(function() {
          self.loadOrder(self._orderId)
        })
    }

    setTimeout(check, 1500)
  },

  // 确认收货（SHIPPED → COMPLETED）
  onConfirmReceipt() {
    var self = this
    wx.showModal({
      title: '确认收货',
      content: '确认已收到商品？',
      confirmText: '确认',
      success: function(modalRes) {
        if (!modalRes.confirm) return
        wx.showLoading({ title: '处理中...' })
        confirmOrder(self.data.order.id)
          .then(function() {
            wx.hideLoading()
            wx.showToast({ title: '已确认收货', icon: 'success', duration: 1500 })
            self.loadOrder(self._orderId)
          })
          .catch(function() {
            wx.hideLoading()
          })
      },
    })
  },
})
