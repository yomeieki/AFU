const { request } = require('../../utils/request')
const { formatPrice } = require('../../utils/format')
const { getLocalMeta } = require('../../api/local')
const app = getApp()

Page({
  data: {
    banners: [],
    categories: [],
    products: [],
    loading: true,
    localEntry: null,
  },

  onLoad() {
    this.loadData()
    this.loadLocalEntry()
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
    this.loadLocalEntry()
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
        // 断网/接口失败：必须收起骨架屏，否则首页永远停在加载态。
        // 这里必须是箭头函数：写成 function 的话 this 是 undefined，setData 抛错被
        // Promise 吞掉，骨架屏反而永远收不起来——正是本行注释要防的事。
        this.setData({ loading: false })
        wx.stopPullDownRefresh()
      })
  },

  // 临时入口：封面落地后整块删除（见 M3 计划 §临时入口决定）
  loadLocalEntry() {
    var self = this
    getLocalMeta()
      .then(function(m) {
        var sub = ''
        var clickable = true
        if (!m.enabled) { sub = '即将开通'; clickable = false }
        else if (m.paused) { sub = '暂停接单' + (m.paused.reason ? ' · ' + m.paused.reason : ''); clickable = false }
        else if (!m.isOpen) { sub = m.nextOpenText || '已打烊' }
        else { sub = m.radiusKm + ' km 内送达 · 满 ¥' + formatPrice(m.fee.minOrderAmount) + ' 起送' }
        self.setData({ localEntry: { sub: sub, clickable: clickable } })
      })
      .catch(function() {
        // 同城接口挂了不影响首页：入口不显示，顾客照常买邮寄
        self.setData({ localEntry: null })
      })
  },

  goLocal() {
    if (!this.data.localEntry || !this.data.localEntry.clickable) return
    var self = this
    // 一点同城就先过位置许可，避免进到地图选点才弹窗
    app.ensurePrivacyAuthorize()
      .then(function() {
        wx.navigateTo({ url: '/pages/local/index' })
      })
      .catch(function() {
        wx.showToast({ title: '需要同意位置许可才能使用同城配送', icon: 'none' })
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
    app.globalData.pendingCategoryAll = true
    wx.switchTab({ url: '/pages/product/list' })
  },

  goToDetail(e) {
    const id = e.currentTarget.dataset.id
    wx.navigateTo({ url: '/pages/product/detail?id=' + id })
  },
})
