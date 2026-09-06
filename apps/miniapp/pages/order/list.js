const { getOrders } = require('../../api/order')
const { formatPrice } = require('../../utils/format')

var TABS = [
  { label: '全部', status: '' },
  { label: '待付款', status: 'PENDING_PAYMENT' },
  { label: '待发货', status: 'PAID,PREPARING' },
  { label: '已发货', status: 'SHIPPED' },
  { label: '已完成', status: 'COMPLETED' },
  { label: '退款/售后', status: 'REFUNDING,REFUNDED' },
  { label: '已取消', status: 'CANCELLED' },
]

var EXPRESS_STATUS_LABEL = {
  PENDING_PAYMENT: '待付款',
  PAID: '待发货',
  PREPARING: '备餐中',
  REFUNDING: '退款中',
  SHIPPED: '已发货',
  COMPLETED: '已完成',
  CANCELLED: '已取消',
  REFUNDED: '已退款',
}

var LOCAL_STATUS_LABEL = Object.assign({}, EXPRESS_STATUS_LABEL, {
  SHIPPED: '配送中',
})

var AFTER_SALE_LABEL = {
  PENDING: '售后处理中',
  APPROVED: '售后退款中',
  DONE: '售后已退款',
  REJECTED: '售后已拒绝',
}

var PAGE_SIZE = 20

// 待付款倒计时文案：mm:ss；到期返回 ''
function countdownText(expireAt) {
  if (!expireAt) return ''
  var left = Math.floor((new Date(expireAt).getTime() - Date.now()) / 1000)
  if (left <= 0) return ''
  var m = Math.floor(left / 60)
  var s = left % 60
  return (m < 10 ? '0' + m : m) + ':' + (s < 10 ? '0' + s : s)
}

// 卡片封面那一行优先取非赠品：一张「买了什么」的卡片被一件赠品当封面，
// 顾客既认不出这是哪一单，也容易以为自己只买了赠品。整单都是赠品时才回落到第一行。
function coverItem(items) {
  if (!items || items.length === 0) return undefined
  for (var i = 0; i < items.length; i++) {
    if (!items[i].isGift) return items[i]
  }
  return items[0]
}

function decorate(order) {
  var extra = ''
  var statusLabels = order.deliveryType === 'LOCAL' ? LOCAL_STATUS_LABEL : EXPRESS_STATUS_LABEL
  if (order.refundedAmount > 0) extra = '已退 ¥' + formatPrice(order.refundedAmount)
  if (order.afterSale && AFTER_SALE_LABEL[order.afterSale.status]) {
    extra = (extra ? extra + ' · ' : '') + AFTER_SALE_LABEL[order.afterSale.status]
  }
  return Object.assign({}, order, {
    statusLabel: statusLabels[order.status] || order.status,
    actualAmountText: formatPrice(order.actualAmount),
    firstItem: coverItem(order.items),
    moreCount: order.items && order.items.length > 1 ? order.items.length - 1 : 0,
    extraText: extra,
    countdown: countdownText(order.payExpireAt),
  })
}

Page({
  data: {
    tabs: TABS,
    activeTab: 0,
    orders: [],
    loading: true,
    loadingMore: false,
    hasMore: true,
    page: 1,
  },

  onLoad(options) {
    if (options.status) {
      var idx = TABS.findIndex(function(t) { return t.status === options.status })
      if (idx >= 0) this.setData({ activeTab: idx })
    }
  },

  onShow() {
    this.loadOrders(true)
    this.startTicker()
  },

  onHide() {
    this.stopTicker()
  },

  onUnload() {
    this.stopTicker()
  },

  onTabChange(e) {
    var idx = e.currentTarget.dataset.idx
    this.setData({ activeTab: idx })
    this.loadOrders(true)
  },

  onPullDownRefresh() {
    this.loadOrders(true)
  },

  onReachBottom() {
    if (this.data.loadingMore || !this.data.hasMore || this.data.loading) return
    this.loadOrders(false)
  },

  loadOrders(reset) {
    var self = this
    var status = TABS[this.data.activeTab].status
    var page = reset ? 1 : this.data.page + 1
    var seq = (this._seq = (this._seq || 0) + 1)
    if (reset) this.setData({ loading: true })
    else this.setData({ loadingMore: true })
    getOrders({ status: status || undefined, page: page, pageSize: PAGE_SIZE })
      .then(function(data) {
        if (seq !== self._seq) return // 快速切 Tab 时丢弃过期响应
        var list = (data.list || []).map(decorate)
        var orders = reset ? list : self.data.orders.concat(list)
        self.setData({
          orders: orders,
          page: page,
          hasMore: orders.length < (data.total || 0),
          loading: false,
          loadingMore: false,
        })
        wx.stopPullDownRefresh()
      })
      .catch(function() {
        if (seq !== self._seq) return
        self.setData({ loading: false, loadingMore: false })
        wx.stopPullDownRefresh()
      })
  },

  // 每秒刷新待付款倒计时；有单到期则重新拉列表（服务端已自动取消）
  startTicker() {
    var self = this
    this.stopTicker()
    this._ticker = setInterval(function() {
      var orders = self.data.orders
      var changed = false
      var expired = false
      var patch = {}
      for (var i = 0; i < orders.length; i++) {
        if (orders[i].status !== 'PENDING_PAYMENT') continue
        var text = countdownText(orders[i].payExpireAt)
        if (text !== orders[i].countdown) {
          patch['orders[' + i + '].countdown'] = text
          changed = true
          if (!text) expired = true
        }
      }
      if (changed) self.setData(patch)
      if (expired) setTimeout(function() { self.loadOrders(true) }, 1500)
    }, 1000)
  },

  stopTicker() {
    if (this._ticker) {
      clearInterval(this._ticker)
      this._ticker = null
    }
  },

  goToDetail(e) {
    var id = e.currentTarget.dataset.id
    wx.navigateTo({ url: '/pages/order/detail?id=' + id })
  },
})
