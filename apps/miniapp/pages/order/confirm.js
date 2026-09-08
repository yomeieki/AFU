const { getCart } = require('../../api/cart')
const { getAddresses } = require('../../api/address')
const { createOrder, getOrderMeta } = require('../../api/order')
const { quoteExpress } = require('../../api/express')
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
    shippingFee: 0,
    payAmount: 0,
    // 服务端报价（/express/quote）。小程序不再自己算运费——两端各写一遍的口径迟早漂
    quote: null,
    quoteToken: null,
    quoteExpiresAtMs: 0,
    // 初值 true：商品与地址解析完成前运费行显示「计算中…」，不闪一下「免运费」
    quoting: true,
    quoteError: '',
    // 阻塞下单的原因（不寄送 / 未达起送 / 缺地址）；空串 = 可提交
    blockReason: '',
    // 会员优惠（M4）。四个值全部来自 checkout-benefits 组件的 change 事件，
    // 本页**不自己算 discount**——封顶与门槛判定在服务端，前端复制一份就是两套口径。
    couponId: null,
    gifts: [],
    discount: 0,
    pointsUsed: 0,
    submitting: false,
    // 商品/地址（loadData）加载失败
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
    this.loadMeta()
  },

  loadMeta() {
    var self = this
    return getOrderMeta()
      .then(function(meta) {
        self.setData({
          subscribeTemplateIds: (meta && meta.subscribeTemplateIds) || [],
          payTimeoutMin: (meta && meta.payTimeoutMin) || 15,
        })
      })
      .catch(function() {})
  },

  onShow() {
    // Check if user selected a new address from address/list
    if (app.globalData.selectedAddress) {
      this.setData({ address: app.globalData.selectedAddress })
      app.globalData.selectedAddress = null
      this.refreshQuote('address')
    }
  },

  // 组装与下单同形的清单参数（cartItemIds 或 directItem + gifts）——凭证按这份清单签，
  // 下单时服务端会比对指纹，所以两处必须传同一份
  quotePayload() {
    var p = { addressId: this.data.address.id }
    if (this.data.mode === 'direct') p.directItem = this.data.directItem
    else p.cartItemIds = this.data.cartItemIds
    if (this.data.gifts && this.data.gifts.length) p.gifts = this.data.gifts
    return p
  },

  /**
   * 向服务端报价。地址、清单、赠品任一变都要重来；换券**不**重来（包邮按券前小计判，运费不随券动），
   * 只在本地重算合计。序号 _quoteSeq 让在途的旧响应作废。
   */
  refreshQuote(reason) {
    var self = this
    var seq = (this._quoteSeq = (this._quoteSeq || 0) + 1)
    if (!this.data.address) {
      this.setData({ quote: null, quoteToken: null, quoteExpiresAtMs: 0, quoting: false, quoteError: '', shippingFee: 0, blockReason: '请选择收货地址' })
      this.recalcPay()
      return
    }
    if (!this.data.items.length) {
      this.setData({ quote: null, quoteToken: null, quoteExpiresAtMs: 0, quoting: false, quoteError: '', shippingFee: 0, blockReason: '' })
      this.recalcPay()
      return
    }
    this.setData({ quoting: true, quoteToken: null, quoteExpiresAtMs: 0, quoteError: '', blockReason: '', shippingFee: 0 })
    // 报价在途时合计不能还含着上一个地址的运费：先按 0 重算，拿到新报价再算一次
    this.recalcPay()
    quoteExpress(this.quotePayload())
      .then(function(q) {
        if (seq !== self._quoteSeq) return
        var block = ''
        if (q.belowMin) block = '还差 ¥' + formatPrice(q.minOrderAmountFen - q.subtotalFen) + ' 起送'
        self.setData({
          quoting: false,
          quote: q,
          quoteToken: block ? null : q.quoteToken,
          quoteExpiresAtMs: Date.parse(q.quoteExpiresAt) || 0,
          shippingFee: q.feeFen,
          blockReason: block,
          quoteError: '',
        })
        self.recalcPay()
      })
      .catch(function(err) {
        if (seq !== self._quoteSeq) return
        var code = err && err.code
        if (code === 42260) {
          // 不寄送：页面内提示 + 禁付款，不 toast
          self.setData({ quoting: false, quote: null, quoteToken: null, quoteExpiresAtMs: 0, shippingFee: 0, quoteError: '', blockReason: err.message || '该地区暂不支持邮寄' })
        } else if (code === 42262 || code === 42224 || code === 42202 || code === 42201) {
          self.setData({ quoting: false, quote: null, quoteToken: null, quoteExpiresAtMs: 0, shippingFee: 0, quoteError: '', blockReason: err.message })
        } else {
          var rateLimited = code === 42901 || code === 429
          self.setData({ quoting: false, quote: null, quoteToken: null, quoteExpiresAtMs: 0, shippingFee: 0, blockReason: '', quoteError: rateLimited ? '操作太频繁，请稍后再试' : '运费获取失败' })
          if (rateLimited && !self._retriedRateLimit) { self._retriedRateLimit = true; setTimeout(function() { self.refreshQuote('retry') }, 3000) }
        }
        self.recalcPay()
      })
  },

  onRetryQuote() { this.refreshQuote('retry') },

  // 合计 = 小计 − 券 + 运费（券只抵商品，不抵运费）
  recalcPay() {
    var pay = this.data.totalAmount - this.data.discount + (this.data.shippingFee || 0)
    this.setData({ payAmount: pay < 0 ? 0 : pay })
  },

  // 组件只抛四个值，本页不看它内部状态。换券不打接口——包邮/运费按券前小计判，
  // 与服务端一致；赠品变了要重报价（重量变、清单指纹变）。
  onBenefitsChange(e) {
    var d = e.detail || {}
    var giftsChanged = JSON.stringify(d.gifts || []) !== JSON.stringify(this.data.gifts || [])
    this.setData({
      couponId: d.couponId === undefined ? null : d.couponId,
      gifts: d.gifts || [],
      discount: d.discount || 0,
      pointsUsed: d.pointsUsed || 0,
    })
    if (giftsChanged) this.refreshQuote('gifts')
    else this.recalcPay()
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
        self.refreshQuote('load')
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
    if (this.data.quoting) { wx.showToast({ title: '运费计算中，请稍候', icon: 'none' }); return }
    if (this.data.quoteError) { wx.showToast({ title: '运费获取失败，请重试', icon: 'none' }); this.refreshQuote('submit'); return }
    if (this.data.blockReason) { wx.showToast({ title: this.data.blockReason, icon: 'none' }); return }
    // 凭证过期就先重报价再让顾客点一次——服务端会拒 42261，但那句报错顾客看不懂
    if (this.data.quoteExpiresAtMs && Date.now() > this.data.quoteExpiresAtMs) {
      wx.showToast({ title: '运费已刷新，请再次确认', icon: 'none' })
      this.refreshQuote('expired')
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
      quoteToken: this.data.quoteToken || undefined,
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
        var code = err && err.code
        if (code === 42261 || code === 42260 || code === 42210 || code === 42262) {
          // 运费/地区/起送在服务端变了：重报价，页面会显示新的运费或阻塞原因
          self.refreshQuote('rejected')
          return
        }
        // 42250 积分不足 / 42251 券不可用 / 42252 赠品不可用：这三种都是「优惠项在别处
        // 变了」，选择已经过期。request.js 已经把 message 弹过 toast 了，这里只负责
        // 让组件重新拉一次，顾客看到的就是刷新后的真实可选项，而不是一个反复失败的按钮。
        if (code === 42250 || code === 42251 || code === 42252) {
          var c = self.selectComponent('#benefits')
          if (c) c.refresh()
        }
      })
  },
})
