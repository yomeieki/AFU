const { getOrderDetail, confirmOrder, cancelOrder } = require('../../api/order')
const { callShop } = require('../../utils/contact')
const { payOrder } = require('../../api/payment')
const { formatPrice } = require('../../utils/format')

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

// 订单进度时间线：已达节点亮起并带时间，未达灰显
function buildTimeline(order) {
  function t(v) {
    return v ? new Date(v).toLocaleString() : ''
  }
  var cancelled = order.status === 'CANCELLED'
  var steps = [
    { label: '提交订单', time: t(order.createdAt), done: true },
    { label: '支付成功', time: t(order.paidAt), done: !!order.paidAt },
    { label: '商家接单 · 备餐中', time: t(order.acceptedAt), done: !!order.acceptedAt },
    {
      label: '已发货',
      time: t(order.shipment && order.shipment.shippedAt),
      done: !!(order.shipment && order.shipment.shippedAt),
      extra:
        order.shipment && order.shipment.expressNo
          ? (order.shipment.expressCompany || '') + ' ' + order.shipment.expressNo
          : '',
    },
    { label: '已完成', time: t(order.completedAt), done: !!order.completedAt },
  ]
  if (cancelled) {
    steps = [
      { label: '提交订单', time: t(order.createdAt), done: true },
      { label: '订单已取消', time: t(order.cancelledAt), done: true },
    ]
  }
  if (order.status === 'REFUNDING' || order.status === 'REFUNDED') {
    steps = [
      { label: '提交订单', time: t(order.createdAt), done: true },
      { label: '支付成功', time: t(order.paidAt), done: !!order.paidAt },
      { label: '申请退款', time: t(order.cancelledAt), done: true },
      { label: '退款完成（原路退回）', time: t(order.refundedAt), done: !!order.refundedAt },
    ]
  }
  // 直接发货未接单的情况：发货已完成时把接单节点视为跳过（不显示）
  if (!order.acceptedAt && order.shipment && order.shipment.shippedAt) {
    steps = steps.filter(function(st) { return st.label.indexOf('商家接单') !== 0 })
  }
  return steps
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
            // 自助取消/退款：待付款，或已付款且商家未接单
            canSelfCancel:
              order.status === 'PENDING_PAYMENT' ||
              (order.status === 'PAID' && !order.acceptedAt),
            totalAmountText: formatPrice(order.totalAmount),
            shippingFeeText: formatPrice(order.shippingFee),
            actualAmountText: formatPrice(order.actualAmount),
            createdAtText: new Date(order.createdAt).toLocaleString(),
            paidAtText: order.paidAt ? new Date(order.paidAt).toLocaleString() : null,
            timeline: buildTimeline(order),
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
  onCancelOrder() {
    var self = this
    var isPaid = this.data.order.status !== 'PENDING_PAYMENT'
    wx.showModal({
      title: isPaid ? '申请退款' : '取消订单',
      content: isPaid
        ? '商家尚未接单，取消后货款将原路退回（1-3 个工作日）。确认申请退款？'
        : '确认取消该订单？',
      confirmText: '确认',
      success: function(res) {
        if (!res.confirm) return
        cancelOrder(self.data.order.id)
          .then(function() {
            wx.showToast({ title: isPaid ? '已申请退款' : '订单已取消', icon: 'success' })
            self.loadOrder(self._orderId)
          })
          .catch(function() {})
      },
    })
  },

  onContactShop() {
    callShop()
  },

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
