var cartApi = require('../../api/cart')
var getCart = cartApi.getCart
var updateCartItem = cartApi.updateCartItem
var deleteCartItem = cartApi.deleteCartItem
var getAddresses = require('../../api/address').getAddresses
var localApi = require('../../api/local')
var getLocalMeta = localApi.getLocalMeta
var quoteLocal = localApi.quoteLocal
var orderApi = require('../../api/order')
var createOrder = orderApi.createOrder
var getOrderMeta = orderApi.getOrderMeta
var requestSubscribe = require('../../utils/subscribe').requestSubscribe
var formatPrice = require('../../utils/format').formatPrice
var app = getApp()

function getHeadNotice(quote) {
  if (!quote) return { text: '', blocking: false }
  if (!quote.enabled) return { text: '同城配送暂未开通', blocking: true }
  if (quote.paused) return { text: '暂停接单' + (quote.paused.reason ? '：' + quote.paused.reason : ''), blocking: true }
  if (!quote.isOpen) return { text: quote.nextOpenText || '当前非营业时间', blocking: true }
  return { text: '', blocking: false }
}

function formatArrival(minutes) {
  var time = new Date(Date.now() + (Number(minutes) || 0) * 60 * 1000)
  var hour = time.getHours() < 10 ? '0' + time.getHours() : String(time.getHours())
  var minute = time.getMinutes() < 10 ? '0' + time.getMinutes() : String(time.getMinutes())
  return hour + ':' + minute
}

function decorateQuote(quote) {
  return Object.assign({}, quote, {
    distanceText: ((quote.distanceM || 0) / 1000).toFixed(1),
    feeText: formatPrice(quote.fee || 0),
    arrivalTime: formatArrival(quote.estimatedMinutes),
  })
}

function selectedItems(cart, cartItemIds) {
  return (cart.items || []).filter(function(item) { return cartItemIds.indexOf(item.id) !== -1 }).map(function(item) {
    return Object.assign({}, item, { priceText: formatPrice(item.price) })
  })
}

Page({
  data: {
    cartItemIds: [],
    items: [],
    subtotal: 0,
    address: null,
    meta: null,
    headNotice: '',
    headBlocking: false,
    quoting: false,
    quote: null,
    quoteToken: null,
    quotedAt: 0,
    quoteError: '',
    blockReason: '',
    needTableware: false,
    remark: '',
    payAmount: 0,
    submitting: false,
    feeFlash: false,
    subscribeTemplateIds: [],
    payTimeoutMin: 15,
  },

  onLoad: function(options) {
    var ids = (options.cartItemIds || '').split(',').filter(Boolean).map(Number)
    this.setData({ cartItemIds: ids })
    this.loadData()
    this.loadMeta()
    var self = this
    getOrderMeta().then(function(meta) {
      self.setData({
        subscribeTemplateIds: (meta && meta.subscribeTemplateIds) || [],
        payTimeoutMin: (meta && meta.payTimeoutMin) || 15,
      })
    }).catch(function() {})
  },

  onShow: function() {
    if (app.globalData.selectedAddress) {
      this.setData({ address: app.globalData.selectedAddress })
      app.globalData.selectedAddress = null
      this.refreshQuote('address')
      return
    }
    // onLoad 后会紧跟一次 onShow；首次报价完成前不重复打 /local/quote。
    if (this._quotedOnce) this.refreshQuote('show')
  },

  onUnload: function() {
    if (this._quoteTimer) clearTimeout(this._quoteTimer)
    if (this._feeFlashTimer) clearTimeout(this._feeFlashTimer)
  },

  loadMeta: function() {
    var self = this
    getLocalMeta().then(function(meta) {
      self.setData({ meta: meta })
    }).catch(function() {
      // 报价结果才是确认页的最终状态；meta 仅为报价前的店头信息兜底。
    })
  },

  loadData: function() {
    var self = this
    Promise.all([getCart('LOCAL'), getAddresses()])
      .then(function(results) {
        var items = selectedItems(results[0] || {}, self.data.cartItemIds)
        var subtotal = items.reduce(function(sum, item) { return sum + item.subtotal }, 0)
        var addresses = results[1] || []
        var address = addresses.find(function(item) { return item.isDefault }) || addresses[0] || null
        self.setData({ items: items, subtotal: subtotal, address: address })
        self._quotedOnce = true
        self.refreshQuote('load')
      })
      .catch(function() {
        self.setData({ blockReason: '商品信息加载失败，请返回同城菜单重试', quoteToken: null })
      })
  },

  refreshQuote: function(reason) {
    var self = this
    var seq = (this._quoteSeq = (this._quoteSeq || 0) + 1)
    var address = this.data.address
    if (this._quoteTimer) {
      clearTimeout(this._quoteTimer)
      this._quoteTimer = null
    }
    if (!address) {
      this.setData({ quoting: false, quoteToken: null, quoteError: '', blockReason: '请选择收货地址' })
      return
    }
    if (address.latE6 == null || address.lngE6 == null) {
      this.setData({ quoting: false, quoteToken: null, quoteError: '', blockReason: '该地址缺少定位，请补充后再下单' })
      return
    }
    if (!this.data.items.length) {
      this.setData({ quoting: false, quoteToken: null, quoteError: '', blockReason: '请先选择同城商品' })
      return
    }
    this.setData({ quoting: true, quoteToken: null, quoteError: '' })
    quoteLocal(address.id, this.data.subtotal)
      .then(function(rawQuote) {
        if (seq !== self._quoteSeq) return
        var quote = decorateQuote(rawQuote)
        var notice = getHeadNotice(quote)
        var patch = {
          quoting: false,
          quote: quote,
          quotedAt: Date.now(),
          headNotice: notice.text,
          headBlocking: notice.blocking,
          payAmount: self.data.subtotal + (quote.fee || 0),
          quoteError: '',
        }
        // 服务端的状态结论优先级：未开通/暂停 > 打烊 > 超范围 > 未达起送。
        if (!quote.enabled) {
          patch.blockReason = '同城配送暂未开通'
          patch.quoteToken = null
        } else if (quote.paused) {
          patch.blockReason = '暂停接单' + (quote.paused.reason ? '：' + quote.paused.reason : '')
          patch.quoteToken = null
        } else if (!quote.isOpen) {
          patch.blockReason = quote.nextOpenText || '当前非营业时间'
          patch.quoteToken = null
        } else if (!quote.inRange) {
          patch.blockReason = '超出配送范围（约 ' + (quote.distanceM / 1000).toFixed(1) + ' km）'
          patch.quoteToken = null
        } else if (quote.belowMin) {
          patch.blockReason = '还差 ¥' + formatPrice(quote.minOrderAmount - self.data.subtotal) + ' 起送'
          patch.quoteToken = null
        } else {
          patch.blockReason = ''
          patch.quoteToken = quote.quoteToken
        }
        self.setData(patch)
      })
      .catch(function(err) {
        if (seq !== self._quoteSeq) return
        if (err.code === 42223) {
          self.setData({ quoting: false, quoteToken: null, quoteError: '', blockReason: err.message || '该地址缺少定位，请补充后再下单' })
          return
        }
        if (err.code === 42226) {
          self.setData({ quoting: false, quoteToken: null, quoteError: '', headNotice: err.message, headBlocking: true, blockReason: err.message })
          return
        }
        var rateLimited = err.code === 42901 || err.code === 429
        if (rateLimited) wx.showToast({ title: '操作太频繁，请稍后再试', icon: 'none' })
        self.setData({
          quoting: false,
          quoteToken: null,
          quoteError: rateLimited ? '操作太频繁，请稍后再试' : '运费获取失败',
        })
        if (rateLimited && !self._retriedRateLimit) {
          self._retriedRateLimit = true
          setTimeout(function() { self.refreshQuote('retry') }, 3000)
        }
      })
  },

  scheduleQuote: function() {
    var self = this
    if (this._quoteTimer) clearTimeout(this._quoteTimer)
    // 小计一变，旧凭证与旧金额立刻作废：debounce 的 500ms 里不能提交旧报价。
    this._quoteSeq = (this._quoteSeq || 0) + 1
    this.setData({ quoting: true, quoteToken: null })
    this._quoteTimer = setTimeout(function() { self.refreshQuote('subtotal') }, 500)
  },

  reloadCart: function() {
    var self = this
    return getCart('LOCAL').then(function(cart) {
      var items = selectedItems(cart || {}, self.data.cartItemIds)
      var subtotal = items.reduce(function(sum, item) { return sum + item.subtotal }, 0)
      self.setData({ items: items, subtotal: subtotal })
      self.scheduleQuote()
    })
  },

  onDecrease: function(e) {
    var id = e.currentTarget.dataset.id
    var item = this.data.items.find(function(row) { return row.id === id })
    if (!item || item.quantity <= 1 || this._cartMutating) return
    this.updateQuantity(id, item.quantity - 1)
  },

  onIncrease: function(e) {
    var id = e.currentTarget.dataset.id
    var item = this.data.items.find(function(row) { return row.id === id })
    if (!item || this._cartMutating) return
    this.updateQuantity(id, item.quantity + 1)
  },

  updateQuantity: function(id, quantity) {
    var self = this
    this._cartMutating = true
    updateCartItem(id, { quantity: quantity })
      .then(function() { return self.reloadCart() })
      .then(function() { self._cartMutating = false })
      .catch(function() { self._cartMutating = false })
  },

  onDelete: function(e) {
    if (this._cartMutating) return
    var id = e.currentTarget.dataset.id
    var self = this
    wx.showModal({
      title: '提示',
      content: '确认删除该商品？',
      success: function(result) {
        if (!result.confirm) return
        self._cartMutating = true
        deleteCartItem(id)
          .then(function() {
            self.setData({ cartItemIds: self.data.cartItemIds.filter(function(itemId) { return itemId !== id }) })
            return self.reloadCart()
          })
          .then(function() { self._cartMutating = false })
          .catch(function() { self._cartMutating = false })
      },
    })
  },

  onSelectAddress: function() {
    wx.navigateTo({ url: '/pages/address/list?mode=select&channel=LOCAL' })
  },

  onFixAddress: function() {
    if (!this.data.address) return
    wx.navigateTo({ url: '/pages/address/edit?id=' + this.data.address.id + '&channel=LOCAL' })
  },

  onTablewareChange: function(e) {
    this.setData({ needTableware: !!e.detail.value })
  },

  onRemarkInput: function(e) {
    this.setData({ remark: e.detail.value })
  },

  goLegal: function(e) {
    wx.navigateTo({ url: '/pages/legal/index?type=' + e.currentTarget.dataset.type })
  },

  goExpress: function() {
    wx.switchTab({ url: '/pages/index/index' })
  },

  goLocalMenu: function() {
    wx.navigateBack()
  },

  contactShop: function() {
    var phone = this.data.meta && this.data.meta.store && this.data.meta.store.phone
    if (!phone) {
      wx.showToast({ title: '商家电话暂未设置', icon: 'none' })
      return
    }
    wx.makePhoneCall({ phoneNumber: phone })
  },

  onSubmit: function() {
    if (this.data.quoteError) {
      this.refreshQuote('retry')
      return
    }
    if (this.data.submitting || this.data.quoting || !this.data.quoteToken) return
    if (Date.now() - this.data.quotedAt > 10 * 60 * 1000) {
      this.refreshQuote('stale')
      wx.showToast({ title: '运费已重新计算，请确认后提交', icon: 'none' })
      return
    }
    var self = this
    requestSubscribe(this.data.subscribeTemplateIds, function() { self.doSubmit() })
  },

  doSubmit: function() {
    if (this.data.submitting || !this.data.quoteToken || !this.data.address) return
    this.setData({ submitting: true })
    var self = this
    var remark = (this.data.needTableware ? '[需要餐具] ' : '') + (this.data.remark || '')
    createOrder({
      cartItemIds: this.data.cartItemIds,
      addressId: this.data.address.id,
      deliveryType: 'LOCAL',
      quoteToken: this.data.quoteToken,
      remark: remark ? remark.slice(0, 255) : undefined,
    }, true)
      .then(function(res) {
        wx.showToast({ title: '下单成功，请在 ' + self.data.payTimeoutMin + ' 分钟内完成支付', icon: 'none', duration: 1500 })
        setTimeout(function() {
          wx.redirectTo({ url: '/pages/order/detail?id=' + res.orderId + '&autopay=1' })
        }, 800)
      })
      .catch(function(err) {
        self.setData({ submitting: false })
        self.handleSubmitError(err)
      })
  },

  handleSubmitError: function(err) {
    var self = this
    var code = err.code
    if (code === 42239 || code === 42227) {
      wx.showToast({ title: code === 42239 ? '配送费需要重新确认' : '配送费已更新，请确认后重新提交', icon: 'none', duration: 2500 })
      this.setData({ feeFlash: true })
      if (this._feeFlashTimer) clearTimeout(this._feeFlashTimer)
      this._feeFlashTimer = setTimeout(function() { self.setData({ feeFlash: false }) }, 1200)
      this.refreshQuote('retry')
      return
    }
    if (code === 42223) {
      wx.showModal({
        title: '地址缺少定位',
        content: err.message,
        confirmText: '去补充',
        success: function(result) {
          if (result.confirm && self.data.address) self.onFixAddress()
        },
      })
      return
    }
    if (code === 42220 || code === 42222 || code === 42226) {
      this.setData({ blockReason: err.message, quoteToken: null, headNotice: err.message, headBlocking: true })
      wx.showToast({ title: err.message, icon: 'none', duration: 3000 })
      return
    }
    if (code === 42230) {
      wx.showModal({
        title: '无法下单',
        content: err.message,
        confirmText: '联系商家',
        success: function(result) { if (result.confirm) self.contactShop() },
      })
      return
    }
    if (code === 42210 || code === 42224) {
      wx.showModal({
        title: '无法下单',
        content: err.message,
        confirmText: '返回同城菜单',
        success: function(result) { if (result.confirm) self.goLocalMenu() },
      })
      return
    }
    wx.showToast({ title: err.message || '下单失败，请重试', icon: 'none', duration: 2500 })
  },

})
