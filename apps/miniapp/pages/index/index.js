// 主页（tabBar[0]）。同城与邮寄共用这一个页面，靠 app.globalData.shoppingChannel 决定
// 加载哪边的内容——微信原生 tabBar 的 pagePath 是写死的，不可能给两个渠道各配四个页面。
//
// 两边的骨架相同（顶栏 → 一块头部 → 分类 → 商品网格），差别只在：
//   EXPRESS：轮播 Banner + 推荐商品，点进商品详情
//   LOCAL  ：门店头（营业状态/配送规则/阻塞通知）+ 今日现拌 + 底部购物车条
//
// 同城下商品卡带「+」快速加购，整条流程（拉详情 → 弹规格 → 加购 → 提示）
// 在 components/local-sku-picker 里，与分类页共用同一份。

const { request } = require('../../utils/request')
const { formatPrice } = require('../../utils/format')
const catalogApi = require('../../api/catalog')
const { getLocalMeta } = require('../../api/local')
const { headNoticeOf, resolveLocalMode } = require('../../utils/local-catalog')
const app = getApp()

Page({
  data: {
    // 自绘导航栏尺寸，onLoad 时按胶囊按钮实测值算出（见 computeNavBar）
    statusBarHeight: 0,
    navContent: 44,
    navTotal: 88,
    channel: 'EXPRESS',
    channelLabel: '全国邮寄',
    // LOCAL 专用
    meta: null,
    mode: 'DELIVERY',
    headBlocking: false,
    // 两个渠道共用
    banners: [],
    categories: [],
    products: [],
    loading: true,
  },

  onLoad() {
    this.computeNavBar()
    this.loadData()
  },

  // 让自绘导航栏与原生完全对齐：胶囊按钮的位置就是微信自己的排版基准，按它反推——
  // 内容区高度 = (胶囊上边距 − 状态栏高) × 2 + 胶囊高，胶囊在其中垂直居中，
  // 返回箭头也就落在与同城页原生箭头相同的中线上。
  // 取不到胶囊信息时退回 44px 常量，不至于把导航栏画塌。
  computeNavBar() {
    var info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
    var statusBarHeight = info.statusBarHeight || 20
    var navContent = 44
    if (wx.getMenuButtonBoundingClientRect) {
      var menu = wx.getMenuButtonBoundingClientRect()
      if (menu && menu.height && menu.top >= statusBarHeight) {
        navContent = (menu.top - statusBarHeight) * 2 + menu.height
      }
    }
    this.setData({
      statusBarHeight: statusBarHeight,
      navContent: navContent,
      navTotal: statusBarHeight + navContent,
    })
  },

  onBannerTap(e) {
    var banner = e.currentTarget.dataset.banner
    if (banner && banner.linkType === 'product' && banner.productId) {
      wx.navigateTo({ url: '/pages/product/detail?id=' + banner.productId })
    }
  },

  // 每次切到本 tab 都会触发。三件事：
  //   ① 补写购物车角标——onLaunch 那次写在非 tabBar 的封面页上会被跳过；
  //   ② 渠道变了就整页重来（顾客刚从封面换了渠道）；
  //   ③ 同城下：刷 meta 与购物车条——店主可能中途按了「暂停接单」，
  //      顾客从结算页返回时也要看到最新的车。
  onShow() {
    app.applyCartBadge()
    if (app.getShoppingChannel() !== this.data.channel) {
      this.loadData()
      return
    }
    if (this.data.channel === 'LOCAL') {
      if (app.getLocalMode() !== this.data.mode) this.applyMode(app.getLocalMode())
      this.loadMeta()
      this.refreshCartBar()
    }
  },

  onPullDownRefresh() {
    this.loadData()
  },

  onShareAppMessage() {
    return {
      title: '阿福凉菜 · 家的味道，三十年老店',
      path: '/pages/index/index',
    }
  },

  onShareTimeline() {
    return { title: '阿福凉菜 · 家的味道，三十年老店' }
  },

  loadData() {
    var channel = app.getShoppingChannel()
    // 先把上一个渠道的内容清空再拉。不清的话，切渠道后新数据回来之前，
    // 顾客会盯着一屏**另一个渠道的商品**看半秒——那半秒里他完全可能点进去。
    this.setData({
      channel: channel,
      channelLabel: channel === 'LOCAL' ? '同城配送' : '全国邮寄',
      loading: true,
      banners: [],
      categories: [],
      products: [],
      meta: channel === 'LOCAL' ? this.data.meta : null,
      mode: channel === 'LOCAL' ? app.getLocalMode() : 'DELIVERY',
      headBlocking: false,
    })
    return channel === 'LOCAL' ? this.loadLocal() : this.loadExpress()
  },

  loadExpress() {
    return Promise.all([
      catalogApi.getCategories('EXPRESS'),
      catalogApi.getProducts({ channel: 'EXPRESS', page: 1, pageSize: 6 }),
      request({ url: '/banners' }).catch(function() { return [] }),
    ])
      .then(([categories, productData, banners]) => {
        this.setData({
          banners: banners || [],
          categories: categories || [],
          products: this.decorate(productData),
          loading: false,
        })
        wx.stopPullDownRefresh()
      })
      .catch(() => {
        // 断网/接口失败：必须收起骨架屏，否则主页永远停在加载态。
        // 这里必须是箭头函数：写成 function 的话 this 是 undefined，setData 抛错被
        // Promise 吞掉，骨架屏反而永远收不起来——正是本行注释要防的事。
        this.setData({ loading: false })
        wx.stopPullDownRefresh()
      })
  },

  loadLocal() {
    // meta 单独一条 Promise 且允许失败：门店信息拿不到时，菜单本身仍应该看得见。
    return Promise.all([
      catalogApi.getCategories('LOCAL'),
      catalogApi.getProducts({ channel: 'LOCAL', page: 1, pageSize: 6 }),
      getLocalMeta().catch(function() { return null }),
    ])
      .then(([categories, productData, meta]) => {
        // 外送关了、自取开着（或反过来）时自动落到开着的那一侧；两边都开尊重顾客上次的选择
        var mode = app.setLocalMode(resolveLocalMode(meta, app.getLocalMode()))
        this.setData({
          categories: categories || [],
          products: this.decorate(productData),
          meta: meta,
          mode: mode,
          headBlocking: headNoticeOf(meta, mode).blocking,
          loading: false,
        })
        this.refreshCartBar()
        wx.stopPullDownRefresh()
      })
      .catch(() => {
        this.setData({ loading: false })
        wx.stopPullDownRefresh()
      })
  },

  decorate(productData) {
    return ((productData && productData.list) || []).map(function(p) {
      return Object.assign({}, p, { priceText: formatPrice(p.price) })
    })
  },

  loadMeta() {
    var self = this
    getLocalMeta()
      .then(function(meta) {
        var mode = app.setLocalMode(resolveLocalMode(meta, app.getLocalMode()))
        self.setData({ meta: meta, mode: mode, headBlocking: headNoticeOf(meta, mode).blocking })
      })
      .catch(function() {
        // 保留上一次的 meta：拉不到店铺状态时，把营业中的店显示成打烊比不刷新更糟
      })
  },

  refreshCartBar() {
    var bar = this.selectComponent('#local-cart-bar')
    if (bar) bar.refresh()
  },

  // 购物车条报告车变了 → 刷新当前渠道的 tabBar 角标
  onCartChange() {
    app.updateCartCount()
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

  // 同城被暂停/打烊时，页头那条通知里的「去全国邮寄」。
  // 不跳页——本页就是共享主页，换渠道重新加载即可，比 switchTab 到自己更直观。
  onGoExpress() {
    app.setShoppingChannel('EXPRESS')
    this.loadData()
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

  // 回封面重选渠道。reLaunch 会清空页面栈，正好符合「封面是起点」的语义；
  // navigateTo 会把封面叠在本页之上，返回时又掉回来，反而绕不出去。
  goCover() {
    wx.reLaunch({ url: '/pages/cover/index' })
  },

  goToAllProducts() {
    app.globalData.pendingCategoryId = null
    app.globalData.pendingCategoryName = null
    app.globalData.pendingCategoryAll = true
    wx.switchTab({ url: '/pages/product/list' })
  },

  goToDetail(e) {
    const id = e.currentTarget.dataset.id
    wx.navigateTo({ url: '/pages/product/detail?id=' + id })
  },

  // 同城「+」。列表项即可，规格由 local-sku-picker 自己去拉。
  onAddToCart(e) {
    const id = e.currentTarget.dataset.id
    var product = null
    for (var i = 0; i < this.data.products.length; i++) {
      if (this.data.products[i].id === id) { product = this.data.products[i]; break }
    }
    var picker = this.selectComponent('#local-sku-picker')
    if (product && picker) picker.open(product)
  },

  // 加购成功（含「加错了渠道」那一支）：刷购物车条与角标
  onAdded() {
    this.refreshCartBar()
    app.updateCartCount()
  },
})
