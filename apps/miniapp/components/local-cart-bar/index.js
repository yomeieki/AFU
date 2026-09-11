// 同城购物车条：底部合计条 + 展开后的明细面板（改数量 / 删除 / 去结算）。
//
// 抽成组件是因为主页和分类页都要有它。两页各写一遍的话，迟早有一边忘了
// 「暂停接单时也要挡住去结算」——而那一边看上去完全正常，只有顾客真按下去、
// 走到服务端 42226 那一刻才炸。
//
// 自己拉车、自己算合计；页面只在「加购成功」「onShow」时喊一声 refresh()。
// 车变了会 triggerEvent('change')，页面据此刷新 tabBar 角标。

var cartApi = require('../../api/cart')
var localCatalog = require('../../utils/local-catalog')
var formatPrice = require('../../utils/format').formatPrice

Component({
  options: { addGlobalClass: true },
  properties: {
    meta: { type: null, value: null },
    // 业务阻塞（未开通/暂停/打烊）。由页面从 headNoticeOf 拿，避免组件重复请求 meta。
    blocking: { type: Boolean, value: false },
    mode: { type: String, value: 'DELIVERY' },
  },
  data: {
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
    'meta, blocking, mode': function() { this.recompute() },
  },
  lifetimes: {
    attached: function() { this.refresh() },
  },
  methods: {
    refresh: function() {
      var self = this
      return cartApi.getCart('LOCAL')
        .then(function(data) {
          var items = (data.items || []).map(function(item) {
            return Object.assign({}, item, { priceText: formatPrice(item.price) })
          })
          var summary = localCatalog.summarizeCart(items)
          self.setData({
            items: items,
            count: summary.count,
            amount: summary.amount,
            // 车空了就把面板收起来，否则会留下一个空白浮层盖住菜单
            expanded: summary.count ? self.data.expanded : false,
          })
          self.recompute()
          self.triggerEvent('change', { count: summary.count, amount: summary.amount })
        })
        .catch(function() {
          // 未登录等错误由统一请求层提示；不影响顾客继续浏览菜单
        })
    },

    recompute: function() {
      var mode = this.properties.mode
      var s = localCatalog.checkoutStateOf(this.properties.meta, this.data.count, this.data.amount, this.properties.blocking, mode)
      // 可结算时把去向写在按钮上：两种模式共用一个车，顾客要知道按下去是外送还是自取
      var text = (!s.disabled && !this.properties.blocking && s.gap === 0) ? ('去结算 · ' + (mode === 'PICKUP' ? '自取' : '外送')) : s.text
      this.setData({ disabled: s.disabled, actionText: text })
    },

    toggle: function() {
      if (!this.data.count) return
      this.setData({ expanded: !this.data.expanded })
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
      var ids = this.data.items.map(function(item) { return item.id })
      if (!ids.length) return
      // 结算页不是 tabBar 页，用 navigateTo：顾客从结算返回时应当回到这份菜单。
      // 自取与外送各自一个结算页——两套状态机（时段/手机号 vs 地址/报价）硬塞进一个页面只会互相绊。
      var page = this.properties.mode === 'PICKUP' ? '/pages/local/pickup' : '/pages/local/confirm'
      wx.navigateTo({ url: page + '?cartItemIds=' + ids.join(',') })
    },
  },
})
