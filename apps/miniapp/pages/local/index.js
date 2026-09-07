const { request } = require('../../utils/request')
const { getLocalMeta } = require('../../api/local')
const { getCart, addToCart, updateCartItem, deleteCartItem } = require('../../api/cart')
const { getProductDetail } = require('../../api/product')
const { formatPrice, formatStock } = require('../../utils/format')

// 左侧分类栏首项：id 为 null 时请求不带 categoryId。
var ALL_CATEGORY = { id: null, name: '全部', iconUrl: '' }

// 菜单页与确认页都按这三个服务端状态阻止下单；商品仍可在暂停、打烊时加入购物车。
function headNoticeOf(meta) {
  if (!meta) return { text: '', blocking: false }
  if (!meta.enabled) return { text: '同城配送即将开通', blocking: true }
  if (meta.paused) {
    return {
      text: '暂停接单' + (meta.paused.reason ? '：' + meta.paused.reason : ''),
      blocking: true,
    }
  }
  if (!meta.isOpen) {
    return { text: meta.nextOpenText || '当前非营业时间', blocking: true }
  }
  return { text: '', blocking: false }
}

function summarizeCart(items) {
  return (items || []).reduce(function(summary, item) {
    summary.count += item.quantity || 0
    summary.amount += item.subtotal || 0
    return summary
  }, { count: 0, amount: 0 })
}

Page({
  data: {
    meta: null,
    metaError: false,
    headNotice: '',
    headBlocking: false,
    categories: [ALL_CATEGORY],
    activeCategoryId: null,
    list: [],
    page: 1,
    pageSize: 20,
    hasMore: true,
    loading: false,
    rightScrollTop: 0,
    cartItems: [],
    cartCount: 0,
    cartAmount: 0,
    cartExpanded: false,
    cartMinGap: 0,
    checkoutDisabled: true,
    checkoutText: '去结算',
    skuShow: false,
    skuProduct: null,
  },

  onLoad: function() {
    this.loadCategories()
    this.loadProducts(true)
  },

  // 从确认页返回或店主临时暂停接单时，都要立刻刷新店头和独立购物车。
  onShow: function() {
    this.loadMeta()
    this.loadCart()
  },

  loadMeta: function() {
    var self = this
    getLocalMeta()
      .then(function(meta) {
        var notice = headNoticeOf(meta)
        self.setData({
          meta: meta,
          metaError: false,
          headNotice: notice.text,
          headBlocking: notice.blocking,
        })
        self.refreshCheckoutState(meta, self.data.cartCount, self.data.cartAmount, notice.blocking)
      })
      .catch(function() {
        self.setData({ metaError: true })
      })
  },

  loadCategories: function() {
    var self = this
    request({ url: '/categories?channel=LOCAL' })
      .then(function(data) {
        var categories = (data || []).map(function(category) {
          return {
            id: category.id,
            name: category.name,
            iconUrl: category.iconUrl || '',
          }
        })
        self.setData({ categories: [ALL_CATEGORY].concat(categories) })
      })
      .catch(function() {
        // 保留「全部」和商品请求；分类接口故障时顾客仍能浏览同城菜单。
      })
  },

  applyCategory: function(id) {
    var activeId = id == null ? null : Number(id)
    if (this.data.activeCategoryId === activeId) return
    this.setData({
      activeCategoryId: activeId,
      list: [],
      page: 1,
      hasMore: true,
    })
    this.resetRightScroll()
    this.loadProducts(true)
  },

  onSelectCategory: function(e) {
    var id = e.currentTarget.dataset.id
    if (id === undefined || id === '') id = null
    this.applyCategory(id)
  },

  resetRightScroll: function() {
    this.setData({ rightScrollTop: this.data.rightScrollTop === 0 ? 0.5 : 0 })
  },

  buildQueryKey: function() {
    return this.data.activeCategoryId == null ? '' : String(this.data.activeCategoryId)
  },

  loadProducts: function(reset) {
    if (this.data.loading) return
    if (!reset && !this.data.hasMore) return

    var page = reset ? 1 : this.data.page
    var self = this
    var reqKey = this.buildQueryKey()
    var url = '/products?channel=LOCAL&page=' + page + '&pageSize=' + this.data.pageSize
    if (this.data.activeCategoryId != null) url += '&categoryId=' + this.data.activeCategoryId
    this.setData({ loading: true })

    request({ url: url })
      .then(function(data) {
        if (self.buildQueryKey() !== reqKey) {
          self.setData({ loading: false })
          self.loadProducts(true)
          return
        }
        var incoming = (data.list || []).map(function(product) {
          return Object.assign({}, product, {
            priceText: formatPrice(product.price),
            stockLabel: formatStock(product.stock),
            hasSkus: !!product.hasSkus,
          })
        })
        var list = reset ? incoming : self.data.list.concat(incoming)
        var total = data.total || 0
        self.setData({
          list: list,
          page: page + 1,
          hasMore: list.length < total,
          loading: false,
        })
      })
      .catch(function() {
        self.setData({ loading: false })
      })
  },

  onScrollToLower: function() {
    this.loadProducts(false)
  },

  onAddToCart: function(e) {
    var id = e.currentTarget.dataset.id
    var product = this.data.list.find(function(item) { return item.id === id })
    if (!product || product.stock <= 0) return
    if (this._loadingSku) return
    var self = this
    this._loadingSku = true
    // 列表项只有 hasSkus 没有 skus/specDimensions，直接喂给 sku-popup 会当成无规格商品，
    // 多规格商品加购时服务端必报 40001「请选择商品规格」且顾客没有任何绕过路径。
    // 用导航栏 loading 而非 showLoading：后者会和请求层的错误 toast 抢同一个提示实例。
    wx.showNavigationBarLoading()
    getProductDetail(id)
      .then(function(full) {
        self._loadingSku = false
        wx.hideNavigationBarLoading()
        if (!full || full.status !== 'ON_SHELF') {
          wx.showToast({ title: '该商品已下架', icon: 'none' })
          return
        }
        self.setData({
          skuShow: true,
          skuProduct: Object.assign({}, full, {
            skus: full.skus || [],
            specDimensions: full.specDimensions || [],
          }),
        })
      })
      .catch(function() {
        // 失败提示由统一请求层弹出；这里只放开重入
        self._loadingSku = false
        wx.hideNavigationBarLoading()
      })
  },

  onSkuClose: function() {
    this.setData({ skuShow: false, skuProduct: null })
  },

  onSkuConfirm: function(e) {
    if (this._adding) return
    var self = this
    var product = this.data.skuProduct
    if (!product) return
    this._adding = true
    addToCart(product.id, e.detail.quantity, e.detail.skuId)
      .then(function(result) {
        // 商品渠道由服务端按商品本身确定；菜单页只接受 LOCAL，避免混入邮寄车。
        if (result && result.channel !== 'LOCAL') {
          wx.showToast({ title: '该商品不属于同城菜单', icon: 'none' })
          // 已落入邮寄车：刷新 tabBar 角标，避免角标与真实邮寄车不一致
          getApp().updateCartCount()
          self._adding = false
          return
        }
        self.onSkuClose()
        // 服务端叠加超库存会静默按库存封顶（cart.ts 的 Math.min）：如果这里一律弹
        // 「已加入」，顾客会以为按自己选的数量全加上了，实际只加了差额，只能到
        // 结算页逐行核对才发现。result.capped 时改用带真实件数的提示。
        if (result && result.capped) {
          wx.showToast({ title: '库存不足，已按最多 ' + result.quantity + ' 件加入', icon: 'none' })
        } else {
          wx.showToast({ title: '已加入同城购物车', icon: 'none' })
        }
        self.loadCart()
        self._adding = false
      })
      .catch(function() {
        self._adding = false
      })
  },

  loadCart: function() {
    var self = this
    getCart('LOCAL')
      .then(function(data) {
        var items = (data.items || []).map(function(item) {
          return Object.assign({}, item, { priceText: formatPrice(item.price) })
        })
        var summary = summarizeCart(items)
        self.setData({
          cartItems: items,
          cartCount: summary.count,
          cartAmount: summary.amount,
          cartExpanded: summary.count ? self.data.cartExpanded : false,
        })
        self.refreshCheckoutState(self.data.meta, summary.count, summary.amount, self.data.headBlocking)
      })
      .catch(function() {
        // 登录态失效等错误继续交给统一请求层提示；不影响正在浏览的菜单。
      })
  },

  refreshCheckoutState: function(meta, count, amount, headBlocking) {
    var minimum = meta && meta.fee ? meta.fee.minOrderAmount || 0 : 0
    var gap = Math.max(0, minimum - amount)
    var disabled = !meta || !!headBlocking || count <= 0 || gap > 0
    var text = gap > 0 ? '还差 ¥' + formatPrice(gap) + ' 起送' : '去结算'
    if (headBlocking) text = '暂不可结算'
    this.setData({
      cartMinGap: gap,
      checkoutDisabled: disabled,
      checkoutText: text,
    })
  },

  toggleCart: function() {
    if (!this.data.cartCount) return
    this.setData({ cartExpanded: !this.data.cartExpanded })
  },

  onDecrease: function(e) {
    var id = e.currentTarget.dataset.id
    var item = this.data.cartItems.find(function(cartItem) { return cartItem.id === id })
    if (!item || item.quantity <= 1 || this._cartMutating) return
    this.updateCartQuantity(id, item.quantity - 1)
  },

  onIncrease: function(e) {
    var id = e.currentTarget.dataset.id
    var item = this.data.cartItems.find(function(cartItem) { return cartItem.id === id })
    if (!item || this._cartMutating) return
    this.updateCartQuantity(id, item.quantity + 1)
  },

  updateCartQuantity: function(id, quantity) {
    var self = this
    this._cartMutating = true
    updateCartItem(id, { quantity: quantity })
      .then(function() {
        self.loadCart()
        self._cartMutating = false
      })
      .catch(function() { self._cartMutating = false })
  },

  onDelete: function(e) {
    if (this._cartMutating) return
    var self = this
    var id = e.currentTarget.dataset.id
    wx.showModal({
      title: '提示',
      content: '确认删除该商品？',
      success: function(res) {
        if (!res.confirm) return
        self._cartMutating = true
        deleteCartItem(id)
          .then(function() {
            self.loadCart()
            self._cartMutating = false
          })
          .catch(function() { self._cartMutating = false })
      },
    })
  },

  goCheckout: function() {
    if (this.data.checkoutDisabled) return
    var ids = this.data.cartItems.map(function(item) { return item.id })
    if (!ids.length) return
    wx.navigateTo({ url: '/pages/local/confirm?cartItemIds=' + ids.join(',') })
  },

  goExpress: function() {
    wx.switchTab({ url: '/pages/index/index' })
  },

  // 顶部「我的订单 ›」。navigateTo：订单列表不是 tabBar 页，而且 switchTab 会销毁本页页栈
  // （顾客从订单页返回时应当回到这份菜单，而不是回到封面）。
  goOrders: function() {
    wx.navigateTo({ url: '/pages/order/list' })
  },
})
