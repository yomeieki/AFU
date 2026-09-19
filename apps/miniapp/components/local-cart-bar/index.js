// 同城 / 邮寄购物车条：底部合计条 + 展开后的明细面板（改数量 / 删除 / 去结算）。
//
// 抽成组件是因为主页和分类页都要有它。两页各写一遍的话，迟早有一边忘了
// 「暂停接单时也要挡住去结算」——而那一边看上去完全正常，只有顾客真按下去、
// 走到服务端 42226 那一刻才炸。
//
// 自己拉车、自己算合计；页面只在「加购成功」「onShow」时喊一声 refresh()。
// 车变了会 triggerEvent('change')，页面据此刷新 tabBar 角标。

var promo = require('../../utils/promo')
var getPromoPreview = require('../../api/local').getPromoPreview

var cartApi = require('../../api/cart')
var localCatalog = require('../../utils/local-catalog')
var formatPrice = require('../../utils/format').formatPrice

Component({
  options: { addGlobalClass: true },
  properties: {
    channel: { type: String, value: 'LOCAL' },
    promotion: { type: null, value: null },
    meta: { type: null, value: null },
    // 业务阻塞（未开通/暂停/打烊）。由页面从 headNoticeOf 拿，避免组件重复请求 meta。
    blocking: { type: Boolean, value: false },
    mode: { type: String, value: 'DELIVERY' },
  },
  data: {
    promoFen: 0,
    tip: { show: false, text: '', tone: 'hint' },
    dockPx: 0,
    subText: '',
    amountText: '',
    origText: '',
    items: [],
    count: 0,
    amount: 0,
    expanded: false,
    disabled: true,
    actionText: '去结算',
  },
  observers: {
    // meta 或阻塞态变了要重算结算按钮：店主中途按下「暂停接单」时，
    // 顾客那一屏的按钮必须当场变灰，而不是等他点下去才被服务端拒绝。
    'meta, blocking, mode, promotion': function() { this.recompute(); this.loadPromo() },
    channel: function() {
      this._promoSeq = (this._promoSeq || 0) + 1
      this.setData({ items: [], count: 0, amount: 0, promoFen: 0, tip: { show: false }, expanded: false })
      this.measureDock()
      this.refresh()
    },
  },
  lifetimes: {
    attached: function() { this._detached = false; this.refresh() },
    detached: function() { this._detached = true; this._cartSeq = (this._cartSeq || 0) + 1; this._promoSeq = (this._promoSeq || 0) + 1 },
  },
  methods: {
    refresh: function() {
      var self = this
      var channel = this.properties.channel
      var seq = (this._cartSeq = (this._cartSeq || 0) + 1)
      return cartApi.getCart(channel)
        .then(function(data) {
          if (seq !== self._cartSeq || channel !== self.properties.channel) return
          var items = (data.items || []).map(function(item) {
            return Object.assign({}, item, { priceText: formatPrice(item.price) })
          })
          var selected = channel === 'EXPRESS' ? items.filter(function(item) { return item.isSelected === 1 }) : items
          var summary = localCatalog.summarizeCart(selected)
          self.setData({
            items: items,
            count: summary.count,
            amount: summary.amount,
            // 车空了就把面板收起来，否则会留下一个空白浮层盖住菜单
            expanded: summary.count ? self.data.expanded : false,
          })
          self.recompute()
          self.measureDock()
          self.loadPromo()
          self.triggerEvent('change', { count: summary.count, amount: summary.amount })
        })
        .catch(function() {
          // 未登录等错误由统一请求层提示；不影响顾客继续浏览菜单
        })
    },

    recompute: function() {
      var mode = this.properties.mode
      var express = this.properties.channel === 'EXPRESS'
      var s = localCatalog.checkoutStateOf(this.properties.meta, this.data.count, this.data.amount, this.properties.blocking, mode)
      // 可结算时把去向写在按钮上：两种模式共用一个车，顾客要知道按下去是外送还是自取
      var text = (!s.disabled && !this.properties.blocking && s.gap === 0) ? ('去结算 · ' + (mode === 'PICKUP' ? '自取' : '外送')) : s.text
      var discount = this.data.promoFen || 0
      this.setData({
        disabled: express ? this.data.count === 0 : s.disabled,
        actionText: express ? '去结算 · 邮寄' : text,
        amountText: '¥' + formatPrice(this.data.amount - discount),
        origText: discount ? '¥' + formatPrice(this.data.amount) : '',
        subText: '共 ' + this.data.count + ' 件' + (discount ? ' · 已减 ¥' + promo.yuanShort(discount) : '') + (express ? ' · 运费结算时算' : ''),
      })
    },

    loadPromo: function() {
      var self = this
      var seq = (this._promoSeq = (this._promoSeq || 0) + 1)
      var type = promo.promoTypeOf(this.properties.channel, this.properties.mode)
      var promotion = this.properties.promotion
      function apply(res) {
        if (seq !== self._promoSeq || self._detached) return
        var meta = self.properties.meta || {}
        self.setData({ promoFen: res && res.active ? (res.discountFen || 0) : 0,
          tip: promo.progressTipOf(res, { deliveryType: type, subtotal: self.data.amount,
            freeShipTiers: (meta.fee || {}).freeShipTiers, radiusKm: meta.radiusKm }) })
        self.recompute()
        self.measureDock()
      }
      if (!this.data.count || (promotion && (!promotion.active || (promotion.channels || {})[type] === false))) {
        apply(null)
        return Promise.resolve()
      }
      return getPromoPreview(type, this.data.amount).then(apply, function() { apply(null) })
    },

    measureDock: function() {
      var self = this
      if (this._detached) return
      var seq = (this._measureSeq = (this._measureSeq || 0) + 1)
      function report(px) {
        if (seq !== self._measureSeq || self._detached || px === self.data.dockPx) return
        self.setData({ dockPx: px })
        self.triggerEvent('height', { px: px })
      }
      if (!this.data.count) { report(0); return }
      if (!wx.createSelectorQuery) return
      wx.nextTick(function() {
        if (seq !== self._measureSeq || self._detached) return
        wx.createSelectorQuery().in(self).select('.cart-dock').boundingClientRect().exec(function(res) {
          report(res[0] ? res[0].height : 0)
        })
      })
    },

    toggle: function() {
      if (!this.data.count) return
      this.setData({ expanded: !this.data.expanded })
      this.measureDock()
    },

    onDecrease: function(e) {
      var item = this.findItem(e.currentTarget.dataset.id)
      if (!item || item.quantity <= 1) return
      this.mutate(item.id, item.quantity - 1)
    },

    onIncrease: function(e) {
      var item = this.findItem(e.currentTarget.dataset.id)
      if (!item) return
      this.mutate(item.id, item.quantity + 1)
    },

    findItem: function(id) {
      var list = this.data.items
      for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i]
      return null
    },

    // _mutating 是防连点：加减号连点两下会发两个请求，后到的那个带着旧数量，
    // 把前一次的结果覆盖回去——顾客看到数字自己往回跳。
    mutate: function(id, quantity) {
      if (this._mutating) return
      var self = this
      this._mutating = true
      cartApi.updateCartItem(id, { quantity: quantity })
        .then(function() { self._mutating = false; return self.refresh() })
        .catch(function() { self._mutating = false })
    },

    onDelete: function(e) {
      if (this._mutating) return
      var self = this
      var id = e.currentTarget.dataset.id
      wx.showModal({
        title: '提示',
        content: '确认删除该商品？',
        success: function(res) {
          if (!res.confirm) return
          self._mutating = true
          cartApi.deleteCartItem(id)
            .then(function() { self._mutating = false; return self.refresh() })
            .catch(function() { self._mutating = false })
        },
      })
    },

    goCheckout: function() {
      if (this.data.disabled) return
      var express = this.properties.channel === 'EXPRESS'
      var ids = this.data.items.filter(function(item) { return !express || item.isSelected === 1 }).map(function(item) { return item.id })
      if (!ids.length) return
      // 结算页不是 tabBar 页，用 navigateTo：顾客从结算返回时应当回到这份菜单。
      // 自取与外送各自一个结算页——两套状态机（时段/手机号 vs 地址/报价）硬塞进一个页面只会互相绊。
      var page = express ? '/pages/order/confirm' : (this.properties.mode === 'PICKUP' ? '/pages/local/pickup' : '/pages/local/confirm')
      wx.navigateTo({ url: page + '?cartItemIds=' + ids.join(',') })
    },
  },
})
