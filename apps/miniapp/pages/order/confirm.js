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
    // 会员优惠（M4）。四个值全部来自 checkout-benefits 组件的 change 事件，
    // 本页**不自己算 discount**——封顶与门槛判定在服务端，前端复制一份就是两套口径。
    couponId: null,
    gifts: [],
    discount: 0,
    pointsUsed: 0,
    submitting: false,
    // 商品/地址（loadData）加载失败
    loadFailed: false,
    // 运费规则（/orders/meta）加载失败 —— 与 loadFailed 是两回事，别合并：
    // 商品能列出来但运费未知时，页面显示的合计就是错的，同样不能让顾客提交。
    metaFailed: false,
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
    this.loadMeta()
  },

  // 运费规则拉取。失败必须留痕：以前这里是个空 catch，shipping 就停在初始的
  // {fee:0,...} 上，页面照样渲染「免运费」和一个不含运费的合计，提交按钮也照样能点——
  // 服务端下单时按真实运费收款，顾客看到的合计和微信扣款对不上，是实打实的价格欺诈观感。
  // 现在失败就置 metaFailed，由 applyShipping 把提交拦住（request 已经 toast 过一次网络错误）。
  loadMeta() {
    var self = this
    return getOrderMeta()
      .then(function(meta) {
        self.setData({
          metaFailed: false,
          subscribeTemplateIds: (meta && meta.subscribeTemplateIds) || [],
          payTimeoutMin: (meta && meta.payTimeoutMin) || 15,
          shipping: (meta && meta.shipping) || { fee: 0, freeThreshold: 0, minOrderAmount: 0 },
        })
        self.applyShipping()
      })
      .catch(function() {
        self.setData({ metaFailed: true })
        self.applyShipping()
      })
  },

  // 失败提示行上的「重新加载」按钮绑这个，直接复用 loadMeta——不需要额外的加载态字段，
  // metaFailed 本身在 loadMeta 里会被清掉或再次置位。
  onRetryMeta() {
    this.loadMeta()
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

    // 运费规则没拉到就别装作「免运费」。metaFailed 有自己的一套绑定（confirm.wxml 的
    // meta-failed 提示行 + 「重新加载」按钮，走 onRetryMeta），不再借用 belowMinOrder/
    // minOrderTip——那两个字段只表示「未达起送门槛」，两个完全不同的失败状态不能混用同一套绑定。
    if (this.data.metaFailed) {
      this.setData({
        shippingFee: 0,
        payAmount: subtotal - this.data.discount,
        belowMinOrder: false,
        minOrderTip: '',
      })
      return
    }

    var fee = Number(s.fee) || 0
    var threshold = Number(s.freeThreshold) || 0
    var min = Number(s.minOrderAmount) || 0

    // ⚠️ 包邮线与起送线**都按券前小计 `subtotal` 判**，不减 discount。
    // 与服务端一致（M2 e2e 券①专门锁了这条）：顾客不该因为用了券而失去包邮、
    // 或者跌到起送线以下。判错了每一单都错。
    var shippingFee = 0
    if (fee > 0 && !(threshold > 0 && subtotal >= threshold)) shippingFee = fee

    var below = min > 0 && subtotal > 0 && subtotal < min
    // 券只抵扣商品金额，不抵扣运费（docs/member-terms-copy.md 明写）
    var pay = subtotal - this.data.discount + shippingFee
    this.setData({
      shippingFee: shippingFee,
      payAmount: pay < 0 ? 0 : pay,
      belowMinOrder: below,
      minOrderTip: below ? '还差 ¥' + formatPrice(min - subtotal) + ' 起送' : '',
    })
  },

  // 组件只抛四个值，本页不看它内部状态
  onBenefitsChange(e) {
    var d = e.detail || {}
    this.setData({
      couponId: d.couponId === undefined ? null : d.couponId,
      gifts: d.gifts || [],
      discount: d.discount || 0,
      pointsUsed: d.pointsUsed || 0,
    })
    this.applyShipping()
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
    // 运费未知：不放行，同时给一个能当场解决问题的出口（重新拉 /orders/meta），
    // 不让顾客卡在一个只会置灰的按钮上。
    if (this.data.metaFailed) {
      var page = this
      wx.showModal({
        title: '运费信息加载失败',
        content: '暂时算不出准确的合计金额，重新加载后再提交。',
        confirmText: '重新加载',
        cancelText: '取消',
        success: function(res) {
          if (res.confirm) page.loadMeta()
        },
      })
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
    // 没选券/没加赠品时这两个键是 undefined，不会被序列化——请求体与改前逐字节一致
    if (this.data.couponId) payload.couponId = this.data.couponId
    if (this.data.gifts && this.data.gifts.length) payload.gifts = this.data.gifts
    createOrder(payload)
      .then(function(res) {
        // 服务端 actualAmount 才是真金额。本地 payAmount 只是展示，两者不等说明口径漂了——
        // 以服务端为准并留个 warn，这是发现漂移的探针（对不上时顾客付的是服务端那个数）。
        if (typeof res.actualAmount === 'number' && res.actualAmount !== self.data.payAmount) {
          console.warn('[confirm] payAmount 与服务端 actualAmount 不一致', self.data.payAmount, res.actualAmount)
        }
        wx.showToast({ title: '下单成功，请在 ' + self.data.payTimeoutMin + ' 分钟内完成支付', icon: 'none', duration: 1500 })
        if (self.data.mode !== 'direct') getApp().updateCartCount()
        setTimeout(function() {
          wx.redirectTo({ url: '/pages/order/detail?id=' + res.orderId + '&autopay=1' })
        }, 800)
      })
      .catch(function(err) {
        self.setData({ submitting: false })
        // 42250 积分不足 / 42251 券不可用 / 42252 赠品不可用：这三种都是「优惠项在别处
        // 变了」，选择已经过期。request.js 已经把 message 弹过 toast 了，这里只负责
        // 让组件重新拉一次，顾客看到的就是刷新后的真实可选项，而不是一个反复失败的按钮。
        var code = err && err.code
        if (code === 42250 || code === 42251 || code === 42252) {
          var c = self.selectComponent('#benefits')
          if (c) c.refresh()
        }
      })
  },
})
