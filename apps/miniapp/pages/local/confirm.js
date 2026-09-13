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
var checkoutState = require('../../utils/local-checkout-state')
var checkoutAction = checkoutState.checkoutAction
var newClientRequestId = checkoutState.newClientRequestId
var packingFeeOf = checkoutState.packingFeeOf
var packingFeeText = require('../../utils/pickup-checkout-state').packingFeeText
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
/** 「大概还要多久送到」。高峰给区间，平时给单值；缺字段时退回旧的 estimatedMinutes */
function etaRangeText(quote) {
  var lo = quote.estimatedMinRange
  var hi = quote.estimatedMaxRange
  if (typeof lo !== 'number' || typeof hi !== 'number') {
    return quote.estimatedMinutes ? ('约 ' + quote.estimatedMinutes + ' 分钟送达') : ''
  }
  return lo === hi ? ('约 ' + hi + ' 分钟送达') : ('约 ' + lo + '–' + hi + ' 分钟送达')
}

function decorateQuote(quote) {
  var km = ((quote.distanceM || 0) / 1000).toFixed(1)
  var estimated = quote.distanceSource === 'ESTIMATED'
  return Object.assign({}, quote, {
    distanceText: km,
    distanceLabel: estimated ? ('约 ' + km + ' km（估算）') : ('距门店 ' + km + ' km'),
    feeText: formatPrice(quote.fee || 0),
    // 结算页**只给大概时长，不给钟点**（PO 2026-09-07）。原来这里算的是「此刻 + 预计分钟」
    // 的绝对时刻，但备餐是从店员点接单才开始的——这一刻店员还没接单，那个钟点等于替他打包票。
    // 顾客付完款可能还要等几分钟才被接单，高峰期更久，写死的钟点必然偏早。
    // 高峰时段给区间（如「35–40 分钟」），平时 min===max 就退化成一个数。
    etaText: etaRangeText(quote),
    peakHint: quote.isPeakNow ? '当前为高峰时段，出餐较慢' : '',
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
    // 报价凭证的过期时刻（毫秒），**由服务端随报价下发**。
    // 客户端不再自己写死 TTL——原来页面判 10 分钟而服务端签 15 分钟，
    // 中间那 5 分钟里页面以为还新鲜、服务端已经准备拒了。
    quoteExpiresAtMs: 0,
    quoteError: '',
    blockReason: '',
    needTableware: false,
    remark: '',
    payAmount: 0,
    packingFee: 0,
    packingFeeText: '',
    // 会员优惠（M4）。四个值全部来自 checkout-benefits 组件，本页不自己算 discount。
    couponId: null,
    gifts: [],
    discount: 0,
    pointsUsed: 0,
    submitting: false,
    // 优惠券/赠品重算中：此刻合计不确定，锁住提交但金额继续显示
    benefitsLoading: false,
    // 底部按钮的唯一判定，来自 utils/local-checkout-state.checkoutAction
    action: { disabled: true, text: '请选择地址', amountState: 'pending', action: 'none' },
    feeFlash: false,
    subscribeTemplateIds: [],
    payTimeoutMin: 15,
  },

  onLoad: function(options) {
    var ids = (options.cartItemIds || '').split(',').filter(Boolean).map(Number)
    // 幂等键随页面而生，**整页只有这一个**：重试时沿用同一个才叫幂等。
    // 只在「确认下单成功」之后换新的（见 doSubmit）。
    this._clientRequestId = newClientRequestId()
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
      // 先作废再写地址：旧报价属于旧地址，这一刻起就不该再能提交
      this.invalidateCheckout('address')
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
      self.recomputePackingFee()
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
        self.recomputePackingFee()
        self._quotedOnce = true
        self.refreshQuote('load')
      })
      .catch(function() {
        self.setData({
          blockReason: '商品信息加载失败，请返回同城菜单重试',
          quoteToken: null, quoteExpiresAtMs: 0, payAmount: null, quoting: false,
        })
        self.syncAction()
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
      this.haltQuote('请选择收货地址')
      return
    }
    if (address.latE6 == null || address.lngE6 == null) {
      this.haltQuote('该地址缺少定位，请补充后再下单')
      return
    }
    if (!this.data.items.length) {
      this.haltQuote('请先选择同城商品')
      return
    }
    this.setData({ quoting: true, quoteToken: null, quoteExpiresAtMs: 0, quoteError: '' })
    this.syncAction()
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
          // 过期时刻由服务端随报价下发；解析不出来就按 0（不判过期），
          // 免得接口回滚到没有这个字段的版本时整页都提交不了。
          quoteExpiresAtMs: Date.parse(rawQuote.quoteExpiresAt) || 0,
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
          // 券只抵扣商品金额，不抵扣配送费。打包费与运费同层相加，不参与券封顶。
          // ⚠️ 传给 /local/quote 的 subtotal 仍是**券前**小计（见 refreshQuote 入口，一行没动）：
          // 服务端 `q.fee > quoted.fee` 那道防线依赖两边口径一致，起送线也按券前判。
          patch.payAmount = self.data.subtotal - self.data.discount + (quote.fee || 0) + self.data.packingFee
        }
        // m1: 报价成功后复位，后续 42901 仍可自动重试一次
        self._retriedRateLimit = false
        self.setData(patch)
        self.syncAction()
      })
      .catch(function(err) {
        if (seq !== self._quoteSeq) return
        if (err.code === 42223) {
          self.setData({ quoting: false, quoteToken: null, quoteExpiresAtMs: 0, quoteError: '', blockReason: err.message || '该地址缺少定位，请补充后再下单' })
          self.syncAction()
          return
        }
        if (err.code === 42226) {
          self.setData({ quoting: false, quoteToken: null, quoteExpiresAtMs: 0, quoteError: '', headNotice: err.message, headBlocking: true, blockReason: err.message })
          self.syncAction()
          return
        }
        var rateLimited = err.code === 42901 || err.code === 429
        if (rateLimited) wx.showToast({ title: '操作太频繁，请稍后再试', icon: 'none' })
        self.setData({
          quoting: false,
          quoteToken: null,
          quoteExpiresAtMs: 0,
          payAmount: null,
          quoteError: rateLimited ? '操作太频繁，请稍后再试' : '运费获取失败',
        })
        self.syncAction()
        if (rateLimited && !self._retriedRateLimit) {
          self._retriedRateLimit = true
          setTimeout(function() { self.refreshQuote('retry') }, 3000)
        }
      })
  },

  /**
   * 作废本次结算的一切「可提交」凭据。地址一换、数量一改、优惠一变都要先调它，
   * **而且要在发请求之前调**——等网络回来再作废的话，那一两秒里按钮上还写着旧金额，
   * 顾客完全来得及按下去，然后被服务端拿着过期的 quoteToken 报 42239。
   *
   * 递增 _quoteSeq 让在途的旧响应作废；清 timer 让 debounce 中的旧计划不再触发。
   */
  invalidateCheckout: function(reason) {
    this._quoteSeq = (this._quoteSeq || 0) + 1
    if (this._quoteTimer) {
      clearTimeout(this._quoteTimer)
      this._quoteTimer = null
    }
    this.setData({ quoting: true, quoteToken: null, quoteExpiresAtMs: 0, payAmount: null })
    this.syncAction()
  },

  // 三条早退分支（缺地址 / 缺坐标 / 购物车为空）共用：它们在发请求前就 return，
  // 走不到用报价结果算头条那一步，只能靠 loadMeta 记下的结论兜底，
  // 且只在它判定为阻塞（暂停/未开通/打烊）时才显示，不阻塞就留空。
  haltQuote: function(reason) {
    this.setData({
      quoting: false, quoteToken: null, quoteExpiresAtMs: 0, payAmount: null,
      quoteError: '', blockReason: reason,
      headNotice: (this._metaNotice && this._metaNotice.blocking) ? this._metaNotice.text : '',
      headBlocking: !!(this._metaNotice && this._metaNotice.blocking),
    })
    this.syncAction()
  },

  scheduleQuote: function() {
    var self = this
    this.invalidateCheckout('subtotal')
    this._quoteTimer = setTimeout(function() { self.refreshQuote('subtotal') }, 500)
  },

  /**
   * 底部按钮的状态只由 checkoutAction 决定，页面不再各处拼三元表达式。
   * 每一处改变 quoting / quoteToken / blockReason / payAmount / submitting 的地方
   * 都要跟着调一次——漏调的表现是「文案变了按钮还能点」这种半吊子状态。
   */
  syncAction: function() {
    var d = this.data
    this.setData({
      action: checkoutAction({
        hasAddress: !!d.address,
        hasLocation: !(d.address && (d.address.latE6 == null || d.address.lngE6 == null)),
        quoting: d.quoting,
        quoteError: !!d.quoteError,
        blockReason: d.blockReason,
        submitting: d.submitting,
        benefitsLoading: d.benefitsLoading,
        quoteToken: d.quoteToken,
        quoteExpiresAt: d.quoteExpiresAtMs,
        payAmount: d.payAmount,
      }),
    })
  },

  reloadCart: function() {
    var self = this
    return getCart('LOCAL').then(function(cart) {
      var items = selectedItems(cart || {}, self.data.cartItemIds)
      var subtotal = items.reduce(function(sum, item) { return sum + item.subtotal }, 0)
      self.setData({ items: items, subtotal: subtotal })
      self.recomputePackingFee()
      self.scheduleQuote()
    })
  },

  // 打包费预览（2026-09-13 打包费设计 §4.1）：Σ quantity × 单份打包费，总开关关时为 0。
  // items 与 meta 分两路异步拉回来，谁后到都要重算一次——只在其中一处调用会在另一路
  // 先回来的那一刻算出一个用着旧值的错误金额。真正影响应付金额的是 refreshQuote 成功分支
  // 与 onBenefitsChange 里再读一次 this.data.packingFee，这里只负责把它算对、存好。
  recomputePackingFee: function() {
    var d = this.data
    var meta = d.meta
    var enabled = !!(meta && meta.packing && meta.packing.enabled !== false)
    this.setData({
      packingFee: packingFeeOf(d.items, enabled),
      packingFeeText: packingFeeText(d.items),
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
    this.invalidateCheckout('quantity')
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
        self.invalidateCheckout('delete')
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
    // returnTo=checkout：地址列表会把它继续传给编辑页，
    // 顾客在编辑页保存后直接带着新地址回到本页，不必再回列表点一次
    wx.navigateTo({ url: '/pages/address/list?mode=select&channel=LOCAL&returnTo=checkout' })
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
      // 组件在重算优惠时报 loading=true：这段时间合计是不确定的，锁住提交。
      // 不锁的话顾客会按着一个旧的应付金额提交，服务端按新的券状态算出另一个数。
      benefitsLoading: !!d.loading,
    }
    if (this.data.quoteToken && !this.data.blockReason && !this.data.quoteError) {
      var fee = (this.data.quote && this.data.quote.fee) || 0
      var pay = this.data.subtotal - patch.discount + fee + this.data.packingFee
      patch.payAmount = pay < 0 ? 0 : pay
    }
    this.setData(patch)
    this.syncAction()
  },

  /**
   * 底部主按钮。**按 action 分派，绝不以「按钮没禁用」推断该提交**——
   * 报价失败时按钮是可点的（店主 2026-09-07 选的方案 B），那一刻没有有效的
   * quoteToken，照着提交会被服务端 42239 拒掉，顾客只会看到一句看不懂的报错。
   */
  onSubmit: function() {
    var act = this.data.action || {}
    if (act.action === 'retry') {
      // 同 onRetryQuote：重新报价前先刷一次 meta，免得头条还停在旧结论上
      this.loadMeta()
      this.refreshQuote('retry')
      return
    }
    if (act.disabled || act.action !== 'submit') {
      // 过期那一格会走到这里（action=none 且文案是「正在计算运费」）：顺手触发重算，
      // 顾客不必自己找哪里能重试。
      if (this.data.quoteExpiresAtMs && Date.now() > this.data.quoteExpiresAtMs) {
        this.refreshQuote('stale')
        wx.showToast({ title: '运费已重新计算，请确认后提交', icon: 'none' })
      }
      return
    }
    var self = this
    requestSubscribe(this.data.subscribeTemplateIds, function() { self.doSubmit() })
  },

  doSubmit: function() {
    if (this.data.submitting || !this.data.quoteToken || !this.data.address) return
    this.setData({ submitting: true })
    this.syncAction()
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
      // 幂等键。**失败时故意不换**：网络超时这一类失败，服务端很可能已经把单建好了，
      // 只是响应没回来。顾客再按一次时带着同一个 id，服务端把那张单原样还回来，
      // 而不是再建一张。换新 id 等于没有幂等。
      clientRequestId: this._clientRequestId,
    }, true)
      .then(function(res) {
        // 确认建单成功，这个 id 用完了：留着的话，顾客若返回本页再下一单，
        // 会命中幂等直接跳回上一张单，看起来像是「怎么点都下不了新单」。
        self._clientRequestId = newClientRequestId()
        wx.showToast({ title: '下单成功，请在 ' + self.data.payTimeoutMin + ' 分钟内完成支付', icon: 'none', duration: 1500 })
        setTimeout(function() {
          wx.redirectTo({ url: '/pages/order/detail?id=' + res.orderId + '&autopay=1' })
        }, 800)
      })
      .catch(function(err) {
        self.setData({ submitting: false })
        self.syncAction()
        self.handleSubmitError(err)
      })
  },

  handleSubmitError: function(err) {
    var self = this
    var code = err.code
    // createOrder 传的是 silent:true，request.js 不会替我们弹 toast，所以自己弹。
    // 42201 库存不足 / 42202 已下架 / 42224 渠道不符：问题出在**商品**上，
    // 刷购物车让顾客看到真实的库存与在售状态，比一句「无法下单」有用。
    // 刷完会走 scheduleQuote 重新报价（小计可能变了）。
    if (code === 42201 || code === 42202 || code === 42224) {
      wx.showToast({ title: err.message || '商品信息已变化，请确认后重试', icon: 'none', duration: 2500 })
      this.reloadCart().catch(function() {})
      return
    }
    // 42250 积分不足 / 42251 券不可用 / 42252 赠品不可用 / 42253 / 42254：
    // 优惠项在别处变了。只刷组件，**不清 quoteToken、不改 blockReason**——
    // 报价本身没问题，清掉会逼顾客重新走一遍报价（还可能因为限流被挡）。
    if (code === 42250 || code === 42251 || code === 42252 || code === 42253 || code === 42254) {
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
      this.setData({ blockReason: err.message, quoteToken: null, quoteExpiresAtMs: 0, payAmount: null, headNotice: err.message, headBlocking: true })
      this.syncAction()
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
    // 42210 未达起送：重新报价即可，服务端会在 belowMin 分支写出「还差 ¥X 起送」，
    // 顾客据此知道要加多少，比一句「无法下单 → 返回菜单」明确。
    if (code === 42210) {
      wx.showToast({ title: err.message || '未达起送金额', icon: 'none', duration: 2500 })
      this.refreshQuote('retry')
      return
    }
    wx.showToast({ title: err.message || '下单失败，请重试', icon: 'none', duration: 2500 })
  },

})
