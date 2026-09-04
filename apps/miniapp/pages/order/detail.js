const { getOrderDetail, confirmOrder, cancelOrder } = require('../../api/order')
const { callShop } = require('../../utils/contact')
const { payOrder } = require('../../api/payment')
const { formatPrice } = require('../../utils/format')
const { requestSubscribe } = require('../../utils/subscribe')

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

// 退款单状态 → 顾客可见文案
var REFUND_STATUS_LABEL = {
  PENDING: '处理中',
  PROCESSING: '微信处理中',
  SUCCESS: '已原路退回',
  ABNORMAL: '处理中（银行侧异常，商家跟进中）',
  CLOSED: '未成功，商家将重新处理',
  FAILED: '未成功，商家将重新处理',
}

var AFTER_SALE_REASON_LABEL = { SHORTAGE: '少发/漏发', WRONG: '错发', DAMAGED: '变质/破损', OTHER: '其他' }
var AFTER_SALE_STATUS_LABEL = {
  PENDING: '待商家处理',
  APPROVED: '商家已同意，退款中',
  DONE: '已退款',
  REJECTED: '商家已拒绝',
}

function t(v) {
  return v ? new Date(v).toLocaleString() : ''
}

// 商家拒单原因前缀（服务端 apps/server/src/routes/admin/orders.ts 拼的 cancelReason 格式，服务端不会改）：
// 「商家拒单：菜品售罄」「商家拒单：其他原因（说明）」。命中前缀才认为是拒单，其余取消原因原样展示。
var REJECT_REASON_PREFIX = '商家拒单：'
function rejectReasonText(cancelReason) {
  if (!cancelReason || cancelReason.indexOf(REJECT_REASON_PREFIX) !== 0) return ''
  return cancelReason.slice(REJECT_REASON_PREFIX.length)
}

// 退款事实这一行只认服务端权威字段（order.status / order.refundedAmount / 最新退款单状态），
// 不解析 cancelReason 文案——同一个 cancelReason 还被后台订单列表和退款订阅消息消费，
// 顾客端在这里画蛇添足地拼串会导致退款单状态变化时（PENDING→SUCCESS）文案不同步刷新。
// order.refundedAmount 是「已确认到账的累计值」（仅在退款单 SUCCESS 落库时才 increment，
// 见 apps/server/src/services/refund.ts:243），所以只有它 >0 时才敢说「已原路退回」。
function refundFactText(order) {
  if (order.status === 'REFUNDED' && order.refundedAmount > 0) {
    return '款项 ¥' + formatPrice(order.refundedAmount) + ' 已原路退回'
  }
  var latest = order.refunds && order.refunds[0]
  var stuck = latest && (latest.status === 'ABNORMAL' || latest.status === 'CLOSED' || latest.status === 'FAILED')
  return stuck ? '退款处理中，如有疑问请联系商家' : '退款处理中'
}

// 待付款倒计时文案：hh:mm:ss；到期返回 ''
function countdownText(expireAt) {
  if (!expireAt) return ''
  var left = Math.floor((new Date(expireAt).getTime() - Date.now()) / 1000)
  if (left <= 0) return ''
  var p = function(n) { return n < 10 ? '0' + n : '' + n }
  return p(Math.floor(left / 3600)) + ':' + p(Math.floor((left % 3600) / 60)) + ':' + p(left % 60)
}

// 支付截止时刻：HH:mm（横幅「请在 19:23 前完成支付」）
function deadlineText(expireAt) {
  if (!expireAt) return ''
  var d = new Date(expireAt)
  var p = function(n) { return n < 10 ? '0' + n : '' + n }
  return p(d.getHours()) + ':' + p(d.getMinutes())
}

// 订单进度时间线：已达节点亮起并带时间，未达灰显
function buildTimeline(order) {
  var shipped = order.shipment && order.shipment.shippedAt
  var shipExtra = order.shipment && order.shipment.expressNo
    ? (order.shipment.expressCompany || '') + ' ' + order.shipment.expressNo
    : ''
  var steps = [{ label: '提交订单', time: t(order.createdAt), done: true }]

  if (order.status === 'CANCELLED') {
    if (order.paidAt) steps.push({ label: '支付成功', time: t(order.paidAt), done: true })
    var rejectReasonCancelled = rejectReasonText(order.cancelReason)
    // 未付款就被拒单：没收过钱，不欠顾客第二行「退款」事实——那是假话，见 refundFactText 的注释。
    steps.push({
      label: rejectReasonCancelled ? ('商家已拒单 · ' + rejectReasonCancelled) : '订单已取消',
      time: t(order.cancelledAt),
      done: true,
      extra: rejectReasonCancelled ? '' : (order.cancelReason || ''),
    })
    return steps
  }

  if (order.status === 'REFUNDING' || order.status === 'REFUNDED') {
    steps.push({ label: '支付成功', time: t(order.paidAt), done: !!order.paidAt })
    if (order.acceptedAt) steps.push({ label: '商家接单 · 备餐中', time: t(order.acceptedAt), done: true })
    if (shipped) steps.push({ label: '已发货', time: t(shipped), done: true, extra: shipExtra })
    if (order.completedAt) steps.push({ label: '已完成', time: t(order.completedAt), done: true })

    var rejectReason = rejectReasonText(order.cancelReason)
    // 顾客自助发起的取消/退款：cancelReason 固定以「用户」开头（见 apps/server/src/routes/orders.ts
    // 的「用户取消」「用户申请退款」）。用前缀匹配代替原来的 === '用户申请退款' 精确比较——
    // 精确比较只要文案措辞一改就会静默判错且没有任何报错。这仍是字符串猜测，真要根治
    // 得服务端加一个结构化字段（如 cancelledBy），本轮先在顾客端做得更稳健，见任务报告。
    var byCustomer = !rejectReason && !!order.cancelReason && order.cancelReason.indexOf('用户') === 0
    steps.push({
      label: rejectReason ? ('商家已拒单 · ' + rejectReason) : (byCustomer ? '申请退款' : '商家发起退款'),
      time: t(order.cancelledAt),
      done: true,
      extra: (rejectReason || byCustomer) ? '' : (order.cancelReason || ''),
    })
    // 第二行：退款事实，按退款单实时状态渲染（PENDING/PROCESSING「退款处理中」，SUCCESS 才「已原路退回」）。
    steps.push({
      label: refundFactText(order),
      time: order.status === 'REFUNDED' && order.refundedAmount > 0 ? t(order.refundedAt) : '',
      done: order.status === 'REFUNDED' && order.refundedAmount > 0,
    })
    return steps
  }

  steps.push({ label: '支付成功', time: t(order.paidAt), done: !!order.paidAt })
  // 直接发货未接单：跳过接单节点
  if (order.acceptedAt || !shipped) {
    steps.push({ label: '商家接单 · 备餐中', time: t(order.acceptedAt), done: !!order.acceptedAt })
  }
  steps.push({ label: '已发货', time: t(shipped), done: !!shipped, extra: shipExtra })
  steps.push({ label: '已完成', time: t(order.completedAt), done: !!order.completedAt })
  return steps
}

function decorateOrder(order) {
  var refunds = (order.refunds || []).map(function(r) {
    return Object.assign({}, r, {
      amountText: formatPrice(r.amount),
      statusLabel: REFUND_STATUS_LABEL[r.status] || r.status,
      timeText: t(r.successTime || r.createdAt),
    })
  })
  var afterSale = order.afterSale
    ? Object.assign({}, order.afterSale, {
        reasonLabel: AFTER_SALE_REASON_LABEL[order.afterSale.reason] || order.afterSale.reason,
        statusLabel: AFTER_SALE_STATUS_LABEL[order.afterSale.status] || order.afterSale.status,
        timeText: t(order.afterSale.createdAt),
      })
    : null
  return Object.assign({}, order, {
    statusLabel: STATUS_LABEL[order.status] || order.status,
    // 自助取消/退款：待付款，或已付款且商家未接单
    canSelfCancel: order.status === 'PENDING_PAYMENT' || (order.status === 'PAID' && !order.acceptedAt),
    totalAmountText: formatPrice(order.totalAmount),
    shippingFeeText: formatPrice(order.shippingFee),
    actualAmountText: formatPrice(order.actualAmount),
    refundedAmountText: formatPrice(order.refundedAmount || 0),
    payDeadlineText: order.status === 'PENDING_PAYMENT' ? deadlineText(order.payExpireAt) : '',
    createdAtText: t(order.createdAt),
    paidAtText: order.paidAt ? t(order.paidAt) : null,
    timeline: buildTimeline(order),
    refunds: refunds,
    afterSale: afterSale,
    items: order.items.map(function(item) {
      return Object.assign({}, item, {
        priceText: formatPrice(item.productPrice),
        subtotalText: formatPrice(item.subtotal),
      })
    }),
  })
}

Page({
  data: {
    order: null,
    loading: true,
    countdown: '',
  },

  onLoad(options) {
    var id = options.id
    if (!id) {
      wx.showToast({ title: '订单不存在', icon: 'none' })
      setTimeout(function() { wx.navigateBack() }, 1500)
      return
    }
    this._orderId = id
    // 从确认页跳来：自动拉起支付（订阅消息已在确认页点击时请求过）
    this._autopay = options.autopay === '1'
    this.loadOrder(id)
  },

  onShow() {
    // 从售后申请页返回时刷新
    if (this._orderId && !this.data.loading && this._needRefresh) {
      this._needRefresh = false
      this.loadOrder(this._orderId, true)
    }
    this.startTicker()
  },

  onHide() {
    this.stopTicker()
  },

  onUnload() {
    this.stopTicker()
  },

  onPullDownRefresh() {
    this.loadOrder(this._orderId, true)
  },

  loadOrder(id, silent) {
    var self = this
    if (!silent) wx.showLoading({ title: '加载中...' })
    getOrderDetail(id)
      .then(function(order) {
        if (!silent) wx.hideLoading()
        wx.stopPullDownRefresh()
        self.setData({
          order: decorateOrder(order),
          loading: false,
          countdown: order.status === 'PENDING_PAYMENT' ? countdownText(order.payExpireAt) : '',
        })
        if (self._autopay) {
          self._autopay = false
          if (order.status === 'PENDING_PAYMENT') self.startPay()
        }
      })
      .catch(function() {
        if (!silent) wx.hideLoading()
        wx.stopPullDownRefresh()
        if (!self.data.order) {
          self.setData({ loading: false })
          setTimeout(function() { wx.navigateBack() }, 1500)
        }
      })
  },

  // 待付款倒计时；到期后刷新（服务端已自动取消）
  startTicker() {
    var self = this
    this.stopTicker()
    this._ticker = setInterval(function() {
      var order = self.data.order
      if (!order || order.status !== 'PENDING_PAYMENT') return
      var text = countdownText(order.payExpireAt)
      if (text !== self.data.countdown) self.setData({ countdown: text })
      if (!text) {
        self.stopTicker()
        setTimeout(function() { self.loadOrder(self._orderId, true) }, 1500)
      }
    }, 1000)
  },

  stopTicker() {
    if (this._ticker) {
      clearInterval(this._ticker)
      this._ticker = null
    }
  },

  // 点击「去支付」：先在点击手势内请求订阅消息（发货/退款通知），再发起支付
  onPay() {
    var self = this
    requestSubscribe(this.data.order.subscribeTemplateIds, function() {
      self.startPay()
    })
  },

  startPay() {
    var self = this
    if (this._paying) return
    this._paying = true
    wx.showLoading({ title: '支付中...' })
    payOrder(this.data.order.id)
      .then(function(data) {
        wx.hideLoading()
        if (data.mode === 'mock') {
          self._paying = false
          wx.showToast({ title: '支付成功，正在确认…', icon: 'none', duration: 1500 })
          self.pollPaidStatus()
          return
        }
        wx.requestPayment({
          timeStamp: data.timeStamp,
          nonceStr: data.nonceStr,
          package: data.package,
          signType: data.signType,
          paySign: data.paySign,
          success: function() {
            // PAID 状态由后端支付回调异步写入，轮询等待
            wx.showToast({ title: '支付成功，正在确认…', icon: 'none', duration: 1500 })
            self.pollPaidStatus()
          },
          fail: function(err) {
            if (err.errMsg && err.errMsg.indexOf('cancel') !== -1) {
              wx.showToast({ title: '已取消支付，可稍后在订单中继续支付', icon: 'none', duration: 2000 })
            } else {
              wx.showToast({ title: '支付失败，请重试', icon: 'none' })
            }
          },
          complete: function() {
            self._paying = false
          },
        })
      })
      .catch(function() {
        self._paying = false
        wx.hideLoading()
        // 订单已超时等业务错误 request 已 toast；刷新以显示最新状态
        self.loadOrder(self._orderId, true)
      })
  },

  // 支付后轮询订单状态：1.5s 间隔，最多 12 次，单次失败不中断
  pollPaidStatus() {
    var self = this
    var attempts = 0
    var maxAttempts = 12

    function check() {
      attempts++
      getOrderDetail(self._orderId)
        .then(function(order) {
          if (order.status !== 'PENDING_PAYMENT') {
            self.loadOrder(self._orderId, true)
          } else if (attempts < maxAttempts) {
            setTimeout(check, 1500)
          } else {
            wx.showToast({ title: '支付结果确认中，请稍后下拉刷新', icon: 'none', duration: 2500 })
            self.loadOrder(self._orderId, true)
          }
        })
        .catch(function() {
          if (attempts < maxAttempts) setTimeout(check, 1500)
          else self.loadOrder(self._orderId, true)
        })
    }

    setTimeout(check, 1500)
  },

  onCancelOrder() {
    var self = this
    var isPaid = this.data.order.status !== 'PENDING_PAYMENT'
    wx.showModal({
      title: isPaid ? '申请退款' : '取消订单',
      content: isPaid
        ? '商家尚未接单，取消后货款会立即原路退回微信，一般几分钟内到账。确认退款？'
        : '确认取消该订单？取消后需重新下单。',
      confirmText: '确认',
      success: function(res) {
        if (!res.confirm) return
        cancelOrder(self.data.order.id)
          .then(function(data) {
            var title = !isPaid ? '订单已取消' : (data && data.autoRefunded ? '已退款，请留意微信到账通知' : '已申请退款，商家将尽快处理')
            wx.showToast({ title: title, icon: 'none', duration: 2000 })
            self.loadOrder(self._orderId, true)
          })
          .catch(function() {
            self.loadOrder(self._orderId, true)
          })
      },
    })
  },

  onContactShop() {
    callShop()
  },

  onApplyAfterSale() {
    this._needRefresh = true
    wx.navigateTo({ url: '/pages/order/after-sale?id=' + this.data.order.id })
  },

  onPreviewImage(e) {
    var urls = (this.data.order.afterSale && this.data.order.afterSale.images) || []
    wx.previewImage({ current: e.currentTarget.dataset.url, urls: urls })
  },

  onConfirmReceipt() {
    var self = this
    wx.showModal({
      title: '确认收货',
      content: '确认已收到商品？确认后如有问题仍可申请售后。',
      confirmText: '确认',
      success: function(modalRes) {
        if (!modalRes.confirm) return
        wx.showLoading({ title: '处理中...' })
        confirmOrder(self.data.order.id)
          .then(function() {
            wx.hideLoading()
            wx.showToast({ title: '已确认收货', icon: 'success', duration: 1500 })
            self.loadOrder(self._orderId, true)
          })
          .catch(function() {
            wx.hideLoading()
          })
      },
    })
  },
})
