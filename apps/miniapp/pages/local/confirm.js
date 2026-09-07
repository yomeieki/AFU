var cartApi = require('../../api/cart')
var getCart = cartApi.getCart
var updateCartItem = cartApi.updateCartItem
var deleteCartItem = cartApi.deleteCartItem
var getAddresses = require('../../api/address').getAddresses
var localApi = require('../../api/local')
var timeUtil = require('../../utils/time')
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

// 北京时间（utils/time.js）。原来用 getHours()：按运行设备时区解读，
// 开发者工具跑在别的时区的电脑上会给顾客算出错的「预计送达」。
function formatArrival(minutes) {
  return timeUtil.fmtAfterMinutes(minutes)
}

function decorateQuote(quote) {
  var km = ((quote.distanceM || 0) / 1000).toFixed(1)
  var estimated = quote.distanceSource === 'ESTIMATED'
  return Object.assign({}, quote, {
    distanceText: km,
    distanceLabel: estimated ? ('约 ' + km + ' km（估算）') : ('距门店 ' + km + ' km'),
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
    // 会员优惠（M4）。四个值全部来自 checkout-benefits 组件，本页不自己算 discount。
    couponId: null,
    gifts: [],
    discount: 0,
    pointsUsed: 0,
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
      // 同下面那条分支：换地址回来若报价因缺坐标早退，头条提示要靠最新的 meta 兜底
      this.loadMeta()
      this.refreshQuote('address')
      return
    }
    // onLoad 后会紧跟一次 onShow；首次报价完成前不重复打 /local/quote。
    if (this._quotedOnce) {
      // meta（暂停/打烊/未开通）从不主动刷新的话，顾客从地址编辑页/后台切回来，
      // 店铺状态变化（比如店主刚恢复接单）要等到下次报价成功才会体现——重新报价
      // 前先刷一次 meta，让 self._metaNotice 跟上最新状态。
      this.loadMeta()
      this.reloadAddressAndQuote()
    }
  },

  // 「去补充定位」走的是地址编辑页，保存后只 navigateBack、不写 globalData.selectedAddress，
  // 这里不重新拉地址的话 this.data.address 里的 latE6/lngE6 永远是旧的 null，
  // 顾客补完定位回来仍被「该地址缺少定位」挡住，是个死循环。
  reloadAddressAndQuote: function() {
    var self = this
    var current = this.data.address
    getAddresses()
      .then(function(addresses) {
        var list = addresses || []
        var latest = current
          ? list.find(function(item) { return item.id === current.id })
          : null
        // 当前地址在编辑页被删掉了：退回默认/首条，与 loadData 的选法一致
        if (!latest) latest = list.find(function(item) { return item.isDefault }) || list[0] || null
        self.setData({ address: latest })
        self.refreshQuote('show')
      })
      .catch(function() {
        // 拉不到地址就按旧地址报价，至少不把页面卡死
        self.refreshQuote('show')
      })
  },

  onUnload: function() {
    if (this._quoteTimer) clearTimeout(this._quoteTimer)
    if (this._feeFlashTimer) clearTimeout(this._feeFlashTimer)
  },

  loadMeta: function() {
    var self = this
    getLocalMeta().then(function(meta) {
      // meta 独立于 refreshQuote 拉取——refreshQuote 在缺地址/缺坐标/购物车为空三种
      // 情况下会在发请求前直接 return（下面 refreshQuote 里的三个早退分支），永远不会
      // 走到 getHeadNotice(quote) 那一步。若这里不单独算一次头条通知，顾客在这三种
      // 状态下会看不到「同城已暂停/未开通/已打烊」，只看到「缺地址/缺定位」之类的
      // 引导性文案，误以为补完资料就能下单，白跑一趟地图选点/换地址流程。
      // 这里只记结论（self._metaNotice），真正写 headNotice/headBlocking 的只有两处：
      // refreshQuote 的三个早退分支（缺地址/缺坐标/购物车为空）会读它兜底；报价成功
      // 之后头条一律以报价结果为准（见下面 refreshQuote 的 .then），不会被这里写死——
      // 否则店铺恢复营业/报价成功后，这条提示会一直钉在顶部，直到离开本页才消失。
      var notice = getHeadNotice(meta)
      self._metaNotice = notice
      self.setData({ meta: meta })
    }).catch(function() {
      // 报价结果才是确认页的最终状态；meta 仅为报价前的店头信息兜底，拉取失败不影响主流程。
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
    // 这三条早退分支在拿到报价前就 return，永远走不到下面 .then 里用报价结果算头条
    // 通知的那一步——头条只能靠 loadMeta 记下的结论（self._metaNotice）兜底，且只在
    // 它判定为阻塞（暂停/未开通/打烊）时才显示，不阻塞就不覆盖，留空。
    if (!address) {
      this.setData({
        quoting: false, quoteToken: null, quoteError: '', blockReason: '请选择收货地址',
        headNotice: (this._metaNotice && this._metaNotice.blocking) ? this._metaNotice.text : '',
        headBlocking: !!(this._metaNotice && this._metaNotice.blocking),
      })
      return
    }
    if (address.latE6 == null || address.lngE6 == null) {
      this.setData({
        quoting: false, quoteToken: null, quoteError: '', blockReason: '该地址缺少定位，请补充后再下单',
        headNotice: (this._metaNotice && this._metaNotice.blocking) ? this._metaNotice.text : '',
        headBlocking: !!(this._metaNotice && this._metaNotice.blocking),
      })
      return
    }
    if (!this.data.items.length) {
      this.setData({
        quoting: false, quoteToken: null, quoteError: '', blockReason: '请先选择同城商品',
        headNotice: (this._metaNotice && this._metaNotice.blocking) ? this._metaNotice.text : '',
        headBlocking: !!(this._metaNotice && this._metaNotice.blocking),
      })
      return
    }
    this.setData({ quoting: true, quoteToken: null, quoteError: '' })
    quoteLocal(address.id, this.data.subtotal)
      .then(function(rawQuote) {
        if (seq !== self._quoteSeq) return
        var quote = decorateQuote(rawQuote)
        var notice = getHeadNotice(quote)
        // 报价成功即拿到了最新状态，头条一律以这次报价结果为准——不再让 loadMeta
        // 记下的旧结论（self._metaNotice）盖过它。之前反过来「meta 阻塞就优先」会把
        // 头条粘死：店铺恢复营业/报价成功、按钮已能提交，顶部仍钉着「暂停接单」，
        // 因为 meta 只在 onLoad 拉一次、之后再没人把 self._metaNotice 清掉。
        // 报价结果比 meta 新（提交前必然会重新报价），这里清空它，避免留着一个陈旧
        // 的结论去污染后面几条早退分支（缺地址/缺坐标/购物车为空）的兜底判断。
        self._metaNotice = null
        var patch = {
          quoting: false,
          quote: quote,
          quotedAt: Date.now(),
          headNotice: notice.text,
          headBlocking: notice.blocking,
          quoteError: '',
        }
        // 服务端的状态结论优先级：未开通/暂停 > 打烊 > 超范围 > 未达起送。
        // m5: blockReason 生效时不保留可支付合计，避免底部展示收不到的金额。
        if (!quote.enabled) {
          patch.blockReason = '同城配送暂未开通'
          patch.quoteToken = null
          patch.payAmount = null
        } else if (quote.paused) {
          patch.blockReason = '暂停接单' + (quote.paused.reason ? '：' + quote.paused.reason : '')
          patch.quoteToken = null
          patch.payAmount = null
        } else if (!quote.isOpen) {
          patch.blockReason = quote.nextOpenText || '当前非营业时间'
          patch.quoteToken = null
          patch.payAmount = null
        } else if (!quote.inRange) {
          patch.blockReason = '超出配送范围（约 ' + (quote.distanceM / 1000).toFixed(1) + ' km）'
          patch.quoteToken = null
          patch.payAmount = null
        } else if (quote.belowMin) {
          patch.blockReason = '还差 ¥' + formatPrice(quote.minOrderAmount - self.data.subtotal) + ' 起送'
          patch.quoteToken = null
          patch.payAmount = null
        } else {
          patch.blockReason = ''
          patch.quoteToken = quote.quoteToken
          // 券只抵扣商品金额，不抵扣配送费。
          // ⚠️ 传给 /local/quote 的 subtotal 仍是**券前**小计（见 refreshQuote 入口，一行没动）：
          // 服务端 `q.fee > quoted.fee` 那道防线依赖两边口径一致，起送线也按券前判。
          patch.payAmount = self.data.subtotal - self.data.discount + (quote.fee || 0)
        }
        // m1: 报价成功后复位，后续 42901 仍可自动重试一次
        self._retriedRateLimit = false
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
          payAmount: null,
          quoteError: rateLimited ? '操作太频繁，请稍后再试' : '运费获取失败',
        })
        if (rateLimited && !self._retriedRateLimit) {
          self._retriedRateLimit = true
          setTimeout(function() { self.refreshQuote('retry') }, 3000)
        }
      })
  },

  invalidateQuote: function() {
    // 购物车一开始改就作废旧票：写入与 reloadCart 的两趟往返里，按钮不能还写着旧金额。
    this._quoteSeq = (this._quoteSeq || 0) + 1
    this.setData({ quoting: true, quoteToken: null })
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
    this.invalidateQuote()
    updateCartItem(id, { quantity: quantity })
      .then(function() { return self.reloadCart() })
      .then(function() { self._cartMutating = false })
      .catch(function() {
        self._cartMutating = false
        // 写入失败时解除 quoting，否则按钮会永久卡在「计算运费中…」
        self.refreshQuote('retry')
      })
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
        self.invalidateQuote()
        deleteCartItem(id)
          .then(function() {
            self.setData({ cartItemIds: self.data.cartItemIds.filter(function(itemId) { return itemId !== id }) })
            return self.reloadCart()
          })
          .then(function() { self._cartMutating = false })
          .catch(function() {
            self._cartMutating = false
            self.refreshQuote('retry')
          })
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

  onRetryQuote: function() {
    // 同 onShow：重新报价前先刷一次 meta，避免顾客点「重试」时头条通知还停在
    // 上一次 loadMeta 拉到的旧结论上。
    this.loadMeta()
    this.refreshQuote('retry')
  },

  /**
   * payAmount 只有两个写入点：refreshQuote 的成功分支，和这里。
   *
   * **降级分支一行不改**：quoteError / blockReason / 报价失败时 payAmount 是 null，
   * 底部合计整块不显示。这里必须守住同一条规矩——报价还没成功就把 payAmount 写成
   * 一个数，等于在「运费未知」的状态下给顾客看一个收不到的金额。
   */
  onBenefitsChange: function(e) {
    var d = e.detail || {}
    var patch = {
      couponId: d.couponId === undefined ? null : d.couponId,
      gifts: d.gifts || [],
      discount: d.discount || 0,
      pointsUsed: d.pointsUsed || 0,
    }
    if (this.data.quoteToken && !this.data.blockReason && !this.data.quoteError) {
      var fee = (this.data.quote && this.data.quote.fee) || 0
      var pay = this.data.subtotal - patch.discount + fee
      patch.payAmount = pay < 0 ? 0 : pay
    }
    this.setData(patch)
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
      // 没选券/没加赠品时是 undefined，不会被序列化——请求体与改前一致
      couponId: this.data.couponId || undefined,
      gifts: this.data.gifts && this.data.gifts.length ? this.data.gifts : undefined,
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
    // 42250 积分不足 / 42251 券不可用 / 42252 赠品不可用：优惠项在别处变了，选择过期。
    // 只刷组件，**不清 quoteToken、不改 blockReason**——报价本身没问题，
    // 清掉会逼顾客重新走一遍报价（还可能因为限流被挡），而问题只出在优惠那一格。
    // createOrder 这里传的是 silent:true，request.js 不会替我们弹 toast，所以自己弹。
    if (code === 42250 || code === 42251 || code === 42252) {
      wx.showToast({ title: err.message || '优惠已变化，请重新选择', icon: 'none', duration: 2500 })
      var benefits = this.selectComponent('#benefits')
      if (benefits) benefits.refresh()
      return
    }
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
