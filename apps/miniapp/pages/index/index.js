const { request } = require('../../utils/request')
const { formatPrice } = require('../../utils/format')
const app = getApp()

Page({
  data: {
    categories: [],
    products: [],
    loading: true,
  },

  onLoad() {
    this.loadData()
  },

  onPullDownRefresh() {
    this.loadData()
  },

  loadData() {
    this.setData({ loading: true })
    Promise.all([
      request({ url: '/categories' }),
      request({ url: '/products?page=1&pageSize=6' }),
    ])
      .then(([categories, productData]) => {
        this.setData({
          categories,
          products: (productData.list || []).map(function(p) {
            return Object.assign({}, p, { priceText: formatPrice(p.price) })
          }),
          loading: false,
        })
        wx.stopPullDownRefresh()
      })
      .catch(function() {
        wx.stopPullDownRefresh()
      })
  },

  // Navigate to product list filtered by categoryId.
  // pages/product/list is a tabBar page — must use switchTab,
  // which doesn't support query params, so we pass via globalData.
  goToList(e) {
    const id = e.currentTarget.dataset.id
    const name = e.currentTarget.dataset.name
    app.globalData.pendingCategoryId = id
    app.globalData.pendingCategoryName = name
    wx.switchTab({ url: '/pages/product/list' })
  },

  goToAllProducts() {
    app.globalData.pendingCategoryId = null
    app.globalData.pendingCategoryName = null
    wx.switchTab({ url: '/pages/product/list' })
  },

  goToDetail(e) {
    const id = e.currentTarget.dataset.id
    wx.navigateTo({ url: '/pages/product/detail?id=' + id })
  },
})
