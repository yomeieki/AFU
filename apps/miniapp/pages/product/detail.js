const { request } = require('../../utils/request')
const { formatPrice, formatStock } = require('../../utils/format')
const { addToCart } = require('../../api/cart')
const { recordScanLog } = require('../../api/scan')

Page({
  data: {
    product: null,
    loading: true,
    // 加载失败改为页内错误态：扫码冷启动时本页是页面栈第一层，navigateBack 必然失败
    loadError: false,
    loadErrorText: '',
    // GET /products/:id 只过滤软删不过滤 status，已下架商品详情照样返回；
    // 服务端要到加购/下单才拒（42202），这里提前把动作栏封掉
    offShelf: false,
    // 页面 push 转场约 300ms，转场结束前不渲染 position:fixed 底部栏，
    // 避免固定栏在滑动动画中提前落到屏幕底、盖在前一页上形成「闪现」
    entered: false,
    skuPopupShow: false,
    skuPopupMode: 'cart',
    selectedSkuText: '', // 「已选」行展示
  },

  onShareAppMessage() {
    var p = this.data.product || {}
    return {
      title: p.name ? p.name + ' · 阿福凉菜' : '阿福凉菜',
      path: '/pages/product/detail?id=' + (p.id || '') + '&source=share',
      imageUrl: p.coverImage || '',
    }
  },

  onLoad(options) {
    var self = this
    var id = options.id
    var scanScene = null
    var source = options.source || 'package'

    // 转场动画结束后再放出底部动作栏（带淡入）
    setTimeout(function() { self.setData({ entered: true }) }, 350)

    // Handle QR code scan entry: options.scene contains the encoded scene string
    if (options.scene) {
      var decoded = decodeURIComponent(options.scene)
      var match = decoded.match(/^p_(\d+)$/)
      if (match) {
        id = match[1]
        scanScene = decoded
      }
    }

    if (!id) {
      wx.showToast({ title: '商品不存在', icon: 'none' })
      setTimeout(function() { wx.navigateBack() }, 1500)
      return
    }

    if (scanScene) {
      recordScanLog(scanScene, source)
    }

    this.loadProduct(id)
  },

  loadProduct(id) {
    var self = this
    this._productId = id
    this.setData({ loading: true, loadError: false, loadErrorText: '' })
    wx.showLoading({ title: '加载中...' })
    // silent：错误信息放进页内错误态展示，不走请求层 toast——
    // showToast 与 showLoading 共用同一提示实例，hideLoading 会把 toast 一并关掉
    request({ url: '/products/' + id, silent: true })
      .then(function(product) {
        wx.hideLoading()
        var images = (product.images && product.images.length > 0)
          ? product.images.map(function(img) { return img.imageUrl })
          : (product.coverImage ? [product.coverImage] : [])
        var skus = product.skus || []
        var dims = product.specDimensions || []
        self.setData({
          product: Object.assign({}, product, {
            priceText: formatPrice(product.price),
            originalPriceText: product.originalPrice ? formatPrice(product.originalPrice) : null,
            stockLabel: formatStock(product.stock),
            images: images,
            skus: skus,
            specDimensions: dims,
            // 「选择规格」行的占位提示：辣度、骨型
            specHint: dims.length > 0 ? dims.map(function(d) { return d.name }).join('、') : '',
          }),
          offShelf: product.status !== 'ON_SHELF',
          loading: false,
        })
        wx.setNavigationBarTitle({ title: product.name })
      })
      .catch(function(err) {
        wx.hideLoading()
        self.setData({
          loading: false,
          loadError: true,
          loadErrorText: (err && err.message) || '商品加载失败',
        })
      })
  },

  onRetryLoad() {
    if (this.data.loading || !this._productId) return
    this.loadProduct(this._productId)
  },

  // 底部按钮 / 「已选」行：统一打开规格弹层（无规格商品弹层内只选数量）
  // 已下架时三个入口都不开弹层——「已选」行没有禁用态，只能在这里拦
  canOpenSku() {
    if (!this.data.product) return false
    if (this.data.offShelf) {
      wx.showToast({ title: '该商品已下架', icon: 'none' })
      return false
    }
    return true
  },

  onAddToCart() {
    if (!this.canOpenSku()) return
    this.setData({ skuPopupShow: true, skuPopupMode: 'cart' })
  },

  onBuyNow() {
    if (!this.canOpenSku()) return
    this.setData({ skuPopupShow: true, skuPopupMode: 'buy' })
  },

  onOpenSkuPopup() {
    if (!this.canOpenSku()) return
    this.setData({ skuPopupShow: true, skuPopupMode: 'cart' })
  },

  onSkuPopupClose() {
    this.setData({ skuPopupShow: false })
  },

  onSkuConfirm(e) {
    var self = this
    var product = this.data.product
    var skuId = e.detail.skuId
    var quantity = e.detail.quantity
    var specText = e.detail.specText
    var isLocal = product.channel === 'LOCAL'
    var isBuy = this.data.skuPopupMode === 'buy' && !isLocal
    var selectedSkuText = specText ? specText + ' ×' + quantity : '×' + quantity

    // 立即购买：不经购物车，直接带商品/规格/数量去确认页（避免与已加购数量合并）
    if (isBuy) {
      this.setData({ skuPopupShow: false, selectedSkuText: selectedSkuText })
      var url = '/pages/order/confirm?mode=direct&productId=' + product.id + '&quantity=' + quantity
      if (skuId) url += '&skuId=' + skuId
      wx.navigateTo({ url: url })
      return
    }

    wx.showLoading({ title: '加入中...' })
    addToCart(product.id, quantity, skuId)
      .then(function() {
        wx.hideLoading()
        self.setData({ skuPopupShow: false, selectedSkuText: selectedSkuText })
        wx.showToast({ title: isLocal ? '已加入同城购物车' : '已加入购物车', icon: 'success', duration: 1500 })
        if (!isLocal) getApp().updateCartCount()
      })
      .catch(function() {
        wx.hideLoading()
      })
  },

  goLocalCheckout: function() {
    // 与封面/购物车/「我的」的同城入口保持一致：先过位置许可，避免进到地图选点才被拦
    getApp().ensurePrivacyAuthorize()
      .then(function() {
        wx.navigateTo({ url: '/pages/local/index' })
      })
      .catch(function() {
        wx.showToast({ title: '需要同意位置许可才能使用同城配送', icon: 'none' })
      })
  },
})
