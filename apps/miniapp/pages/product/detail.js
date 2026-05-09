const { request } = require('../../utils/request')
const { formatPrice, formatStock } = require('../../utils/format')
const { addToCart } = require('../../api/cart')

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
    if (options.scene) {
      var scene = decodeURIComponent(options.scene)
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
    var product = this.data.product
    if (!product) return
    wx.showLoading({ title: '加入中...' })
    addToCart(product.id, 1)
      .then(function() {
        wx.hideLoading()
        wx.showToast({ title: '已加入购物车', icon: 'success', duration: 1500 })
      })
      .catch(function() {
        wx.hideLoading()
      })
  },

  onBuyNow() {
    var product = this.data.product
    if (!product) return
    wx.showLoading({ title: '处理中...' })
    addToCart(product.id, 1)
      .then(function(res) {
        wx.hideLoading()
        wx.navigateTo({
          url: '/pages/order/confirm?cartItemIds=' + res.id,
        })
      })
      .catch(function() {
        wx.hideLoading()
      })
  },
})
