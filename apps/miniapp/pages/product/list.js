// 分类页（tabBar[1]）。同城与邮寄共用左分类 / 右商品这一套骨架，差别只有两处：
//   EXPRESS：顶部搜索框；点商品进详情页
//   LOCAL  ：顶部紧凑门店头；点圆形「+」直接加购 + 底部购物车条
//
// 加购流程与主页共用 components/local-sku-picker，本页只负责找到那件商品并把它交出去。

const { formatPrice, formatStock } = require('../../utils/format')
const catalogApi = require('../../api/catalog')
const { getLocalMeta } = require('../../api/local')
const { headNoticeOf, resolveLocalMode } = require('../../utils/local-catalog')
const app = getApp()

// 左侧分类栏首项：「全部」（id 为 null → 请求时不带 categoryId）
var ALL_CATEGORY = { id: null, name: '全部', iconUrl: '' }

Page({
  data: {
    channel: 'EXPRESS',
    // 同城专用
    meta: null,
    mode: 'DELIVERY',
    headBlocking: false,
    // 搜索（仅邮寄）
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
    this.reloadForChannel()
  },

  // 每次切到本 tab 都会触发。渠道变了就整页重来；否则只消费主页传来的分类意图。
  onShow() {
    if (app.getShoppingChannel() !== this.data.channel) {
      this.reloadForChannel()
      return
    }
    if (this.data.channel === 'LOCAL') {
      if (app.getLocalMode() !== this.data.mode) this.applyMode(app.getLocalMode())
      this.loadMeta()
      this.refreshCartBar()
    }
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

  // 切渠道时把分类、商品、搜索词、分页全部归零。
  // 不归零的话，新渠道的第一屏会先闪出上一个渠道的商品，而且 activeCategoryId
  // 可能指向一个当前渠道根本没有的分类，右侧会一直空着且看不出原因。
  reloadForChannel() {
    var channel = app.getShoppingChannel()
    this.setData({
      channel: channel,
      categories: [ALL_CATEGORY],
      activeCategoryId: null,
      keyword: '',
      searchKeyword: '',
      list: [],
      page: 1,
      total: 0,
      hasMore: true,
      meta: channel === 'LOCAL' ? this.data.meta : null,
      mode: channel === 'LOCAL' ? app.getLocalMode() : 'DELIVERY',
      headBlocking: false,
    })
    this.resetRightScroll()
    this.loadCategories()
    this.loadProducts(true)
    if (channel === 'LOCAL') this.loadMeta()
  },

  loadMeta() {
    var self = this
    getLocalMeta()
      .then(function(meta) {
        var mode = app.setLocalMode(resolveLocalMode(meta, app.getLocalMode()))
        self.setData({ meta: meta, mode: mode, headBlocking: headNoticeOf(meta, mode).blocking })
      })
      .catch(function() {
        // 保留上一次的 meta：拉不到状态时，把营业中的店显示成打烊比不刷新更糟
      })
  },

  loadCategories() {
    var self = this
    catalogApi.getCategories(this.data.channel)
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
    // 记录本次请求对应的筛选条件，响应回来时若条件已变则丢弃（防止快速切换分类时串数据）。
    // 渠道也进这把钥匙：切渠道那一刻可能还有一个在途请求，它带回来的是**另一个渠道的货**。
    var reqKey = this.buildQueryKey()
    this.setData({ loading: true })

    catalogApi.getProducts({
      channel: this.data.channel,
      page: page,
      pageSize: this.data.pageSize,
      categoryId: this.data.activeCategoryId,
      keyword: this.data.searchKeyword,
    })
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
    var base = this.data.channel + '|'
    return base + (this.data.searchKeyword
      ? 'k:' + this.data.searchKeyword
      : 'c:' + (this.data.activeCategoryId == null ? '' : this.data.activeCategoryId))
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

  // 同城「+」：整条加购流程（拉详情 → 弹规格 → 加购 → 提示）在
  // components/local-sku-picker 里，主页与本页共用同一份。
  onAddToCart(e) {
    var id = e.currentTarget.dataset.id
    var product = null
    for (var i = 0; i < this.data.list.length; i++) {
      if (this.data.list[i].id === id) { product = this.data.list[i]; break }
    }
    var picker = this.selectComponent('#local-sku-picker')
    if (product && picker) picker.open(product)
  },

  // 加购成功（含「加错了渠道」那一支）：刷购物车条与角标
  onAdded() {
    this.refreshCartBar()
    app.updateCartCount()
  },

  refreshCartBar() {
    var bar = this.selectComponent('#local-cart-bar')
    if (bar) bar.refresh()
  },

  onCartChange() {
    app.updateCartCount()
  },

  onGoExpress() {
    app.setShoppingChannel('EXPRESS')
    this.reloadForChannel()
  },

  // 子模式变了：阻塞态按新模式重算，购物车条的按钮跟着变（去向与起送线都不一样）
  applyMode(mode) {
    this.setData({ mode: mode, headBlocking: headNoticeOf(this.data.meta, mode).blocking })
    this.refreshCartBar()
  },
  onModeChange(e) {
    this.applyMode(app.setLocalMode(e.detail.mode))
  },
  // 页头通知里的「改用自取 / 改用外送」
  onSwitchMode(e) {
    this.applyMode(app.setLocalMode(e.detail.mode))
  },
})
