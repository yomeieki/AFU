const { getCart } = require('../../api/cart')
const { getAddresses } = require('../../api/address')
const { createOrder, getOrderMeta } = require('../../api/order')
const { requestSubscribe } = require('../../utils/subscribe')
const { request } = require('../../utils/request')
const { formatPrice } = require('../../utils/format')
const app = getApp()

Page({
  data: {
    // 购物车结算：cartItemIds；立即购买：mode=direct + directItem（不经购物车）
    mode: 'cart',
    cartItemIds: [],
    directItem: null,
    items: [],
    address: null,
    remark: '',
    totalAmount: 0,
    // 运费规则来自 /orders/meta；这里算出来只为展示，实际收费以服务端下单时重算为准
    shipping: { fee: 0, freeThreshold: 0, minOrderAmount: 0 },
    shippingFee: 0,
    payAmount: 0,
    belowMinOrder: false,
    minOrderTip: '',
    submitting: false,
    loadFailed: false,
    subscribeTemplateIds: [],
    payTimeoutMin: 15,
  },

  onLoad(options) {
    if (options.mode === 'direct' && options.productId) {
      this.setData({
        mode: 'direct',
        directItem: {
          productId: Number(options.productId),
          skuId: options.skuId ? Number(options.skuId) : undefined,
          quantity: Math.max(1, Number(options.quantity) || 1),
        },
      })
    } else {
      var ids = (options.cartItemIds || '').split(',').filter(Boolean).map(Number)
      this.setData({ cartItemIds: ids })
    }
    this.loadData()
    var self = this
    getOrderMeta()
      .then(function(meta) {
        self.setData({
          subscribeTemplateIds: (meta && meta.subscribeTemplateIds) || [],
          payTimeoutMin: (meta && meta.payTimeoutMin) || 15,
          shipping: (meta && meta.shipping) || { fee: 0, freeThreshold: 0, minOrderAmount: 0 },
        })
        self.applyShipping()
      })
      .catch(function() {})
  },

  onShow() {
    // Check if user selected a new address from address/list
    if (app.globalData.selectedAddress) {
      this.setData({ address: app.globalData.selectedAddress })
      app.globalData.selectedAddress = null
    }
  },

  // 运费与起送门槛都按**商品小计**判断，与服务端 services/settings.ts 口径一致。
  // 两边算法必须一样，否则顾客看到的合计和实际扣款对不上。
  applyShipping() {
    var s = this.data.shipping || {}
    var subtotal = this.data.totalAmount
    var fee = Number(s.fee) || 0
    var threshold = Number(s.freeThreshold) || 0
    var min = Number(s.minOrderAmount) || 0

    var shippingFee = 0
    if (fee > 0 && !(threshold > 0 && subtotal >= threshold)) shippingFee = fee

    var below = min > 0 && subtotal > 0 && subtotal < min
    this.setData({
      shippingFee: shippingFee,
      payAmount: subtotal + shippingFee,
      belowMinOrder: below,
      minOrderTip: below ? '还差 ¥' + formatPrice(min - subtotal) + ' 起送' : '',
    })
  },

  loadData() {
    var self = this
    var itemsPromise = this.data.mode === 'direct' ? this.loadDirectItem() : this.loadCartItems()
    this.setData({ loadFailed: false })
    Promise.all([itemsPromise, getAddresses()])
      .then(function(results) {
        var items = results[0]
        var addresses = results[1] || []
        var totalAmount = items.reduce(function(sum, item) { return sum + item.subtotal }, 0)
        var address = addresses.find(function(a) { return a.isDefault }) || addresses[0] || null
        self.setData({ items: items, totalAmount: totalAmount, address: address })
        self.applyShipping()
      })
      .catch(function() {
        // request 已 toast；标记失败禁止提交，避免空单/¥0 也能点提交
        self.setData({ items: [], totalAmount: 0, shippingFee: 0, payAmount: 0, loadFailed: true })
      })
  },

  loadCartItems() {
    var ids = this.data.cartItemIds
    return getCart().then(function(cartData) {
      return (cartData.items || [])
        .filter(function(item) { return ids.indexOf(item.id) !== -1 })
        .map(function(item) { return Object.assign({}, item, { priceText: formatPrice(item.price) }) })
    })
  },

  // 立即购买：按商品详情 + 所选规格现算一行（价格以服务端下单为准，这里仅展示）
  loadDirectItem() {
    var d = this.data.directItem
    return request({ url: '/products/' + d.productId }).then(function(product) {
      var sku = null
      if (d.skuId && product.skus) {
        sku = product.skus.find(function(s) { return s.id === d.skuId }) || null
      }
      var price = sku ? sku.price : product.price
      return [{
        id: 'direct',
        productId: product.id,
        productName: product.name,
        productImage: product.coverImage,
        specText: sku ? sku.specText : '',
        price: price,
        priceText: formatPrice(price),
        quantity: d.quantity,
        subtotal: price * d.quantity,
      }]
    })
  },

  onSelectAddress() {
    wx.navigateTo({ url: '/pages/address/list?mode=select' })
  },

  onRemarkInput(e) {
    this.setData({ remark: e.detail.value })
  },

  goLegal(e) {
    var type = e.currentTarget.dataset.type
    wx.navigateTo({ url: '/pages/legal/index?type=' + type })
  },

  onSubmit() {
    if (this.data.loadFailed) {
      wx.showToast({ title: '商品信息加载失败，请返回重试', icon: 'none' })
      return
    }
    if (!this.data.address) {
      wx.showToast({ title: '请选择收货地址', icon: 'none' })
      return
    }
    if (this.data.items.length === 0) {
      wx.showToast({ title: '请先选择商品', icon: 'none' })
      return
    }
    if (this.data.belowMinOrder) {
      wx.showToast({ title: this.data.minOrderTip, icon: 'none' })
      return
    }
    if (this.data.submitting) return

    // 订阅消息授权必须在点击手势内发起（发货/退款通知），完成后再创建订单
    var self = this
    requestSubscribe(this.data.subscribeTemplateIds, function() {
      self.doSubmit()
    })
  },

  doSubmit() {
    if (this.data.submitting) return
    this.setData({ submitting: true })
    var self = this
    var payload = {
      addressId: this.data.address.id,
      deliveryType: 'EXPRESS',
      remark: this.data.remark || undefined,
    }
    if (this.data.mode === 'direct') {
      payload.directItem = this.data.directItem
    } else {
      payload.cartItemIds = this.data.cartItemIds
    }
    createOrder(payload)
      .then(function(res) {
        wx.showToast({ title: '下单成功，请在 ' + self.data.payTimeoutMin + ' 分钟内完成支付', icon: 'none', duration: 1500 })
        if (self.data.mode !== 'direct') getApp().updateCartCount()
        setTimeout(function() {
          wx.redirectTo({ url: '/pages/order/detail?id=' + res.orderId + '&autopay=1' })
        }, 800)
      })
      .catch(function() {
        self.setData({ submitting: false })
      })
  },
})
