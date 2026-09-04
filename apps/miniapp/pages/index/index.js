const { request } = require('../../utils/request')
const { formatPrice } = require('../../utils/format')
const app = getApp()

Page({
  data: {
    // 自绘导航栏尺寸，onLoad 时按胶囊按钮实测值算出（见 computeNavBar）
    statusBarHeight: 0,
    navContent: 44,
    navTotal: 88,
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

  // 从封面 switchTab 进来时补写购物车角标：onLaunch 那次写在非 tabBar 的封面页上会被跳过
  onShow() {
    app.applyCartBadge()
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
    this.setData({ loading: true })
    Promise.all([
      request({ url: '/categories' }),
      request({ url: '/products?page=1&pageSize=6' }),
      request({ url: '/banners' }).catch(function() { return [] }),
    ])
      .then(([categories, productData, banners]) => {
        this.setData({
          banners: banners || [],
          categories,
          products: (productData.list || []).map(function(p) {
            return Object.assign({}, p, { priceText: formatPrice(p.price) })
          }),
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
})
