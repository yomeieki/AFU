// 购物车（tabBar[2]）。两个渠道共用这一页，但**两个车在服务端是分开的**——
// 同一个商品不会出现在两边，件数也不合并。
//
// 骨架完全相同（勾选 / 图 / 名 / 规格 / 数量 / 删除 / 底部合计），差别只有三处：
//   ① 拉哪个车：显式带当前渠道，缺省会拉回邮寄的货；
//   ② 起送线：同城有、邮寄没有。没到线就放行的话，顾客要走完地址、报价、点提交，
//      才在服务端撞上 42210——前面全白填；
//   ③ 结算去哪：同城 → /pages/local/confirm，邮寄 → /pages/order/confirm。
//      走错的表现是没有地址定位、没有配送费，提交时被 42224 拒掉而顾客不知道为什么。

const { getCart, updateCartItem, deleteCartItem } = require('../../api/cart')
const { getLocalMeta } = require('../../api/local')
const { formatPrice } = require('../../utils/format')
const { headNoticeOf, checkoutStateOf } = require('../../utils/local-catalog')

var promo = require('../../utils/promo')
var getPromoPreview = require('../../api/local').getPromoPreview
var share = require('../../utils/share')

Page({
  onShareAppMessage: share.onShareAppMessage,
  data: {
    promotion: null,
    promoTip: { show: false, text: '', tone: 'hint' },
    channel: 'EXPRESS',
    channelLabel: '全国邮寄',
    items: [],
    totalAmount: 0,
    selectedCount: 0,
    loading: true,
    // 同城专用
    meta: null,
    mode: 'DELIVERY',
    headNotice: '',
    headBlocking: false,
    // 底部按钮
    checkoutDisabled: true,
    checkoutText: '结算（0）',
    // 本渠道车空时，提示另一个渠道还挂着几件
    otherChannelCount: 0,
    otherChannelLabel: '',
  },

  onShow() {
    var channel = getApp().getShoppingChannel()
    var mode = channel === 'LOCAL' ? getApp().getLocalMode() : 'DELIVERY'
    if (channel !== this.data.channel) {
      // 切渠道：**先清空再拉**。不清的话，新车回来之前屏幕上还是上一个渠道的
      // 商品与合计，顾客可能对着邮寄的合计按下同城的结算。
      this.setData({
        channel: channel,
        channelLabel: channel === 'LOCAL' ? '同城配送' : '全国邮寄',
        items: [],
        totalAmount: 0,
        selectedCount: 0,
        otherChannelCount: 0,
        otherChannelLabel: '',
        meta: null,
        promotion: null,
        promoTip: { show: false },
        mode: mode,
        headNotice: '',
        headBlocking: false,
      })
    }
    if (mode !== this.data.mode) this.setData({ mode: mode })
    this._promoSeq = (this._promoSeq || 0) + 1
    this.loadMeta()
    this.loadCart()
  },

  loadMeta() {
    var self = this
    var channel = this.data.channel
    getLocalMeta()
      .then(function(meta) {
        if (channel !== self.data.channel) return
        if (channel === 'EXPRESS') {
          self.setData({ promotion: meta.promotion })
          self.loadPromo()
          return
        }
        var notice = headNoticeOf(meta, self.data.mode)
        self.setData({ meta: meta, promotion: meta.promotion, headNotice: notice.text, headBlocking: notice.blocking })
        self.refreshCheckout()
        self.loadPromo()
      })
      .catch(function() {
        // 拉不到门店状态不挡浏览；结算那一步服务端还会再判一次
      })
  },

  loadCart() {
    var self = this
    var channel = this.data.channel
    this.setData({ loading: true })
    getCart(channel)
      .then(function(data) {
        // 迟到的响应：切渠道后旧请求才回来，直接 setData 会把另一个渠道的货铺上去
        if (self.data.channel !== channel) return
        var items = (data.items || []).map(function(item) {
          return Object.assign({}, item, { priceText: formatPrice(item.price) })
        })
        self.setData({
          items: items,
          totalAmount: data.totalAmount || 0,
          selectedCount: data.selectedCount || 0,
          loading: false,
        })
        self.refreshCheckout()
        self.loadPromo()
        self.checkOtherChannel(items.length === 0)
        getApp().updateCartCount()
      })
      .catch(function() {
        self.setData({ loading: false })
      })
  },

  loadPromo: function() {
    var self = this
    var seq = (this._promoSeq = (this._promoSeq || 0) + 1)
    var type = promo.promoTypeOf(this.data.channel, this.data.mode)
    var promotion = this.data.promotion
    var meta = this.data.meta || {}
    var opts = { deliveryType: type, subtotal: this.data.totalAmount, freeShipTiers: (meta.fee || {}).freeShipTiers, radiusKm: meta.radiusKm }
    if (!this.data.selectedCount) {
      this.setData({ promoTip: { show: false } })
      return Promise.resolve()
    }
    // 满减关闭 / 本渠道未勾：与 local-cart-bar 的 apply(null) 同一处理——不请求，
    // 但仍经 progressTipOf(null, opts) 走一遍，好让免运费进度显示出来（统筹裁定 Q3）。
    if (promotion && (!promotion.active || (promotion.channels || {})[type] === false)) {
      this.setData({ promoTip: promo.progressTipOf(null, opts) })
      return Promise.resolve()
    }
    return getPromoPreview(type, this.data.totalAmount).then(function(res) {
      if (seq !== self._promoSeq) return
      self.setData({ promoTip: promo.progressTipOf(res, opts) })
    }, function() {
      // M12（复审建议，纳入本批）：请求失败与「满减关闭/本渠道未勾」同一处理——
      // 不请求不代表没有免运费进度可显示，仍经 progressTipOf(null, opts) 走一遍
      // （与上面 :129 满减关闭分支、local-cart-bar/index.js:120 的 apply(null) 同一口径）。
      // 原来直接 {show:false} 会把免运费进度也一起抹掉，一次网络抖动就让顾客看到的
      // 提示条消失又重新出现。
      if (seq === self._promoSeq) self.setData({ promoTip: promo.progressTipOf(null, opts) })
    })
  },

  onUnload: function() { this._promoSeq = (this._promoSeq || 0) + 1 },

  // 两个车分开，顾客很容易在一边看到空车、忘了另一边还挂着东西。
  // 只在本渠道车空时才去数另一边——有货时这条提示是噪音，也白费一次请求。
  checkOtherChannel(isEmpty) {
    var self = this
    if (!isEmpty) {
      this.setData({ otherChannelCount: 0, otherChannelLabel: '' })
      return
    }
    var other = this.data.channel === 'LOCAL' ? 'EXPRESS' : 'LOCAL'
    getCart(other)
      .then(function(data) {
        var n = (data.items || []).reduce(function(s, i) { return s + (i.quantity || 0) }, 0)
        self.setData({
          otherChannelCount: n,
          otherChannelLabel: other === 'LOCAL' ? '同城配送' : '全国邮寄',
        })
      })
      .catch(function() { self.setData({ otherChannelCount: 0, otherChannelLabel: '' }) })
  },

  // 底部按钮的文案与可点性。同城多一道起送线，邮寄只看有没有勾选。
  refreshCheckout() {
    if (this.data.channel !== 'LOCAL') {
      this.setData({
        checkoutDisabled: this.data.selectedCount === 0,
        checkoutText: '结算（' + this.data.selectedCount + '）',
      })
      return
    }
    // 起送线按**勾选的**小计判（totalAmount 就是勾选项之和，见 routes/cart.ts:57-58），
    // 与下单时服务端的判定口径一致——按全车判会出现「页面说够了、提交被拒」。
    var mode = this.data.mode
    var s = checkoutStateOf(this.data.meta, this.data.selectedCount, this.data.totalAmount, this.data.headBlocking, mode)
    var text = (!s.disabled && !this.data.headBlocking && s.gap === 0) ? ('去结算 · ' + (mode === 'PICKUP' ? '自取' : '外送')) : s.text
    this.setData({ checkoutDisabled: s.disabled, checkoutText: text })
  },

  onToggleSelect(e) {
    var self = this
    var id = e.currentTarget.dataset.id
    var item = this.findItem(id)
    if (!item || item.status !== 'ON_SHELF') return
    var newVal = item.isSelected === 1 ? 0 : 1
    updateCartItem(id, { isSelected: newVal })
      .then(function() { self.loadCart() })
  },

  onDecrease(e) {
    var self = this
    var item = this.findItem(e.currentTarget.dataset.id)
    if (!item || item.status !== 'ON_SHELF' || item.quantity <= 1) return
    updateCartItem(item.id, { quantity: item.quantity - 1 })
      .then(function() { self.loadCart() })
  },

  onIncrease(e) {
    var self = this
    var item = this.findItem(e.currentTarget.dataset.id)
    if (!item || item.status !== 'ON_SHELF') return
    updateCartItem(item.id, { quantity: item.quantity + 1 })
      .then(function() { self.loadCart() })
  },

  findItem(id) {
    var list = this.data.items
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i]
    return null
  },

  onDelete(e) {
    var self = this
    var id = e.currentTarget.dataset.id
    wx.showModal({
      title: '提示',
      content: '确认删除该商品？',
      success: function(res) {
        if (!res.confirm) return
        deleteCartItem(id).then(function() { self.loadCart() })
      },
    })
  },

  onCheckout() {
    if (this.data.checkoutDisabled) {
      // 说清为什么点不动。同城下 checkoutText 本身就是原因（「还差 ¥25.00 起送」），
      // 直接拿它当提示，比一句通用的「不可结算」有用得多。
      var why = this.data.selectedCount === 0 ? '请选择商品'
        : this.data.channel === 'LOCAL' ? this.data.checkoutText : '请选择商品'
      wx.showToast({ title: why, icon: 'none' })
      return
    }
    var ids = this.data.items
      .filter(function(i) { return i.isSelected === 1 })
      .map(function(i) { return i.id })
      .join(',')
    if (!ids) return
    var page = this.data.channel !== 'LOCAL' ? '/pages/order/confirm' : this.data.mode === 'PICKUP' ? '/pages/local/pickup' : '/pages/local/confirm'
    wx.navigateTo({ url: page + '?cartItemIds=' + ids })
  },

  // 空车时的「去逛逛」。进**当前渠道**的分类页而不是固定的邮寄主页——
  // 同城模式下的空车顾客被甩去看邮寄的货，是这次改版要治的那类问题。
  goShopping() {
    wx.switchTab({ url: '/pages/product/list' })
  },

  // 空车提示里的「去看看」：切到另一个渠道的分类页。
  // 同城要过位置许可，走 app 的统一出口；邮寄直接定渠道 + switchTab。
  goOtherChannel() {
    var app = getApp()
    if (this.data.channel === 'LOCAL') {
      app.setShoppingChannel('EXPRESS')
      wx.switchTab({ url: '/pages/product/list' })
      return
    }
    app.enterLocalChannel()
  },

  formatTotal() {
    return formatPrice(this.data.totalAmount)
  },
})
