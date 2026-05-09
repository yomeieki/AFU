const { request } = require('../../utils/request')
const { formatPrice, formatStock } = require('../../utils/format')

Page({
  data: {
    product: null,
    loading: true,
  },

  onLoad(options) {
    var id = options.id
    if (!id) {
      wx.showToast({ title: '商品不存在', icon: 'none' })
      setTimeout(function() { wx.navigateBack() }, 1500)
      return
    }
    // Try to parse scene parameter (scan from QR code)
    if (options.scene) {
      var scene = decodeURIComponent(options.scene)
      // scene format: "p_<id>"
      var match = scene.match(/^p_(\d+)$/)
      if (match) id = match[1]
    }
    this.loadProduct(id)
  },

  loadProduct(id) {
    var self = this
    wx.showLoading({ title: '加载中...' })
    request({ url: '/products/' + id })
      .then(function(product) {
        wx.hideLoading()
        var images = (product.images && product.images.length > 0)
          ? product.images.map(function(img) { return img.imageUrl })
          : (product.coverImage ? [product.coverImage] : [])
        self.setData({
          product: Object.assign({}, product, {
            priceText: formatPrice(product.price),
            originalPriceText: product.originalPrice ? formatPrice(product.originalPrice) : null,
            stockLabel: formatStock(product.stock),
            images: images,
          }),
          loading: false,
        })
        wx.setNavigationBarTitle({ title: product.name })
      })
      .catch(function() {
        wx.hideLoading()
        self.setData({ loading: false })
        setTimeout(function() { wx.navigateBack() }, 1500)
      })
  },

  onAddToCart() {
    wx.showToast({ title: '购物车功能即将上线', icon: 'none', duration: 2000 })
  },

  onBuyNow() {
    wx.showToast({ title: '下单功能即将上线', icon: 'none', duration: 2000 })
  },
})
