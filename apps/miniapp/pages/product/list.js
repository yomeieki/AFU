const { request } = require('../../utils/request')
const { formatPrice, formatStock } = require('../../utils/format')
const app = getApp()

// 左侧分类栏首项：「全部」（id 为 null → 请求时不带 categoryId）
var ALL_CATEGORY = { id: null, name: '全部', iconUrl: '' }

Page({
  data: {
    // 搜索
    keyword: '',          // 输入框实时值
    searchKeyword: '',    // 已确认的搜索词（非空 = 搜索模式，右侧展示跨分类结果）
    // 分类
    categories: [ALL_CATEGORY],
    activeCategoryId: null,
    // 商品
    list: [],
    page: 1,
    pageSize: 20,
    total: 0,
    hasMore: true,
    loading: false,
    // 右侧 scroll-view 回顶用（值变化才生效，故在 0 / 0.5 间交替）
    rightScrollTop: 0,
  },

  onLoad() {
    this.loadCategories()
    this.loadProducts(true)
  },

  // 每次切到本 tab 都会触发：消费主页通过 globalData 传来的分类意图
  onShow() {
    var g = app.globalData
    if (g.pendingCategoryAll === true) {
      g.pendingCategoryAll = false
      g.pendingCategoryId = null
      g.pendingCategoryName = null
      this.applyCategory(null)
      return
    }
    if (g.pendingCategoryId != null) {
      var id = g.pendingCategoryId
      g.pendingCategoryId = null
      g.pendingCategoryName = null
      this.applyCategory(id)
    }
  },

  loadCategories() {
    var self = this
    request({ url: '/categories' })
      .then(function(data) {
        var cats = (data || []).map(function(c) {
          return { id: c.id, name: c.name, iconUrl: c.iconUrl || '' }
        })
        self.setData({ categories: [ALL_CATEGORY].concat(cats) })
      })
      .catch(function() {
        // 分类拉取失败时仅保留「全部」，商品列表仍可用
      })
  },

  // 切换分类并重置列表（id 为 null 表示「全部」）；同时退出搜索模式
  applyCategory(id) {
    var activeId = id == null ? null : Number(id)
    this.setData({
      activeCategoryId: activeId,
      searchKeyword: '',
      keyword: '',
      list: [],
      page: 1,
      total: 0,
      hasMore: true,
    })
    this.resetRightScroll()
    this.loadProducts(true)
  },

  onSelectCategory(e) {
    var id = e.currentTarget.dataset.id
    if (id === undefined || id === '') id = null
    // 搜索模式下点分类：退出搜索；同分类重复点击不重复请求
    if (!this.data.searchKeyword && this.data.activeCategoryId === (id == null ? null : Number(id))) return
    this.applyCategory(id)
  },

  resetRightScroll() {
    this.setData({ rightScrollTop: this.data.rightScrollTop === 0 ? 0.5 : 0 })
  },

  loadProducts(reset) {
    if (this.data.loading) return
    if (!reset && !this.data.hasMore) return

    var page = reset ? 1 : this.data.page
    var self = this
    // 记录本次请求对应的筛选条件，响应回来时若条件已变则丢弃（防止快速切换分类时串数据）
    var reqKey = this.buildQueryKey()
    this.setData({ loading: true })

    var url = '/products?page=' + page + '&pageSize=' + this.data.pageSize
    if (this.data.searchKeyword) {
      url += '&keyword=' + encodeURIComponent(this.data.searchKeyword)
    } else if (this.data.activeCategoryId != null) {
      url += '&categoryId=' + this.data.activeCategoryId
    }

    request({ url: url })
      .then(function(data) {
        if (self.buildQueryKey() !== reqKey) {
          // 条件已变化：本次结果作废，让新条件的请求重新发起
          self.setData({ loading: false })
          self.loadProducts(true)
          return
        }
        var newItems = (data.list || []).map(function(p) {
          return Object.assign({}, p, {
            priceText: formatPrice(p.price),
            stockLabel: formatStock(p.stock),
            hasSkus: !!p.hasSkus,
          })
        })
        var list = reset ? newItems : self.data.list.concat(newItems)
        var total = data.total || 0
        self.setData({
          list: list,
          page: page + 1,
          total: total,
          hasMore: list.length < total,
          loading: false,
        })
      })
      .catch(function() {
        self.setData({ loading: false })
      })
  },

  buildQueryKey() {
    return this.data.searchKeyword
      ? 'k:' + this.data.searchKeyword
      : 'c:' + (this.data.activeCategoryId == null ? '' : this.data.activeCategoryId)
  },

  onScrollToLower() {
    this.loadProducts(false)
  },

  onSearchInput(e) {
    this.setData({ keyword: e.detail.value })
  },

  onSearchConfirm() {
    var kw = (this.data.keyword || '').trim()
    if (!kw) {
      if (this.data.searchKeyword) this.clearSearch()
      return
    }
    if (kw === this.data.searchKeyword) return
    this.setData({
      searchKeyword: kw,
      keyword: kw,
      list: [],
      page: 1,
      total: 0,
      hasMore: true,
    })
    this.resetRightScroll()
    this.loadProducts(true)
  },

  // 清除搜索，回到分类模式（保留当前选中分类）
  clearSearch() {
    this.setData({
      searchKeyword: '',
      keyword: '',
      list: [],
      page: 1,
      total: 0,
      hasMore: true,
    })
    this.resetRightScroll()
    this.loadProducts(true)
  },

  goToDetail(e) {
    var id = e.currentTarget.dataset.id
    wx.navigateTo({ url: '/pages/product/detail?id=' + id })
  },
})
