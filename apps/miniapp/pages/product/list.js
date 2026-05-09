const { request } = require('../../utils/request')
const { formatPrice, formatStock } = require('../../utils/format')
const app = getApp()

Page({
  data: {
    list: [],
    page: 1,
    pageSize: 20,
    total: 0,
    hasMore: true,
    loading: false,
    keyword: '',
    categoryId: null,
    categoryName: '',
  },

  onLoad() {
    this.loadProducts(true)
  },

  // Called every time this tab is shown (including category navigation from index).
  onShow() {
    if (app.globalData.pendingCategoryId != null) {
      const id = app.globalData.pendingCategoryId
      const name = app.globalData.pendingCategoryName || '商品列表'
      app.globalData.pendingCategoryId = null
      app.globalData.pendingCategoryName = null
      wx.setNavigationBarTitle({ title: name })
      this.setData({
        categoryId: id,
        categoryName: name,
        keyword: '',
        list: [],
        page: 1,
        hasMore: true,
      })
      this.loadProducts(true)
    }
  },

  loadProducts(reset) {
    if (this.data.loading) return
    if (!reset && !this.data.hasMore) return

    var page = reset ? 1 : this.data.page
    var self = this
    this.setData({ loading: true })

    var url = '/products?page=' + page + '&pageSize=' + this.data.pageSize
    if (this.data.categoryId) url += '&categoryId=' + this.data.categoryId
    if (this.data.keyword) url += '&keyword=' + encodeURIComponent(this.data.keyword)

    request({ url: url })
      .then(function(data) {
        var newItems = (data.list || []).map(function(p) {
          return Object.assign({}, p, {
            priceText: formatPrice(p.price),
            stockLabel: formatStock(p.stock),
          })
        })
        var list = reset ? newItems : self.data.list.concat(newItems)
        self.setData({
          list: list,
          page: page + 1,
          total: data.total,
          hasMore: list.length < data.total,
          loading: false,
        })
        wx.stopPullDownRefresh()
      })
      .catch(function() {
        self.setData({ loading: false })
        wx.stopPullDownRefresh()
      })
  },

  onReachBottom() {
    this.loadProducts(false)
  },

  onPullDownRefresh() {
    this.loadProducts(true)
  },

  onSearchInput(e) {
    this.setData({ keyword: e.detail.value })
  },

  onSearchConfirm() {
    this.setData({ list: [], page: 1, hasMore: true })
    this.loadProducts(true)
  },

  clearCategory() {
    wx.setNavigationBarTitle({ title: '商品列表' })
    this.setData({
      categoryId: null,
      categoryName: '',
      list: [],
      page: 1,
      hasMore: true,
    })
    this.loadProducts(true)
  },

  goToDetail(e) {
    var id = e.currentTarget.dataset.id
    wx.navigateTo({ url: '/pages/product/detail?id=' + id })
  },
})
