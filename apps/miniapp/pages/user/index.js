const { wechatLogin } = require('../../api/auth')
const { callShop } = require('../../utils/contact')
var memberApi = require('../../api/member')

Page({
  data: {
    isLoggedIn: false,
    nickname: '',
    avatarUrl: '',
    // 页头积分/券条。'—' 既是初值也是「拉取失败」态：条目仍可点，
    // 点进会员页会自己重拉并显示自己的失败态，这里不该拦人。
    pointsText: '—',
    couponText: '—',
  },

  onLoad() {
    this._syncLoginState()
  },

  onShow() {
    this._syncLoginState()
    if (this.data.isLoggedIn) {
      this._loadMemberSummary()
    } else {
      this.setData({ pointsText: '—', couponText: '—' })
    }
  },

  // silent：这是页头的附属信息，拉不到就显示「—」，不该在「我的」页盖一层全局 toast
  _loadMemberSummary: function() {
    var self = this
    if (this._summaryLoading) return
    this._summaryLoading = true
    memberApi
      .getSummary(true)
      .then(function(data) {
        var d = data || {}
        self._summaryLoading = false
        self.setData({
          pointsText: d.pointsBalance == null ? '—' : String(d.pointsBalance),
          couponText: d.availableCoupons == null ? '—' : String(d.availableCoupons),
        })
      })
      .catch(function() {
        self._summaryLoading = false
        self.setData({ pointsText: '—', couponText: '—' })
      })
  },

  goMemberCenter: function() {
    wx.navigateTo({ url: '/pages/member/index' })
  },

  goCoupons: function() {
    wx.navigateTo({ url: '/pages/member/coupons' })
  },

  _syncLoginState() {
    var app = getApp()
    var userInfo = app.globalData.userInfo
    var token = app.globalData.token
    if (token && userInfo) {
      this.setData({
        isLoggedIn: true,
        nickname: userInfo.nickname || '微信用户',
        avatarUrl: userInfo.avatarUrl || '',
      })
    } else {
      this.setData({ isLoggedIn: false, nickname: '', avatarUrl: '' })
    }
  },

  onLogin() {
    var self = this
    wx.showLoading({ title: '登录中...' })
    wx.login({
      success: function(res) {
        if (!res.code) {
          wx.hideLoading()
          wx.showToast({ title: '获取登录码失败', icon: 'none' })
          return
        }
        wechatLogin(res.code)
          .then(function(data) {
            wx.hideLoading()
            var app = getApp()
            app.globalData.token = data.token
            app.globalData.userInfo = { nickname: data.nickname, avatarUrl: data.avatarUrl }
            wx.setStorageSync('token', data.token)
            self.setData({
              isLoggedIn: true,
              nickname: data.nickname || '微信用户',
              avatarUrl: data.avatarUrl || '',
            })
            wx.showToast({ title: '登录成功', icon: 'success' })
            // 本页登录不会再触发 onShow，不补这一下积分/券条会一直停在「—」
            self._loadMemberSummary()
          })
          .catch(function() {
            wx.hideLoading()
            wx.showToast({ title: '登录失败，请重试', icon: 'none' })
          })
      },
      fail: function() {
        wx.hideLoading()
        wx.showToast({ title: '登录失败', icon: 'none' })
      },
    })
  },

  goToOrders() {
    wx.navigateTo({ url: '/pages/order/list' })
  },

  goToOrdersByStatus(e) {
    var status = e.currentTarget.dataset.status
    wx.navigateTo({ url: '/pages/order/list?status=' + status })
  },

  goToMerchant() {
    // 有商家 token 直接进入口页（该页会自行校验有效性兜底），否则先登录
    var url = wx.getStorageSync('merchant_token')
      ? '/pages/merchant/index'
      : '/pages/merchant/login'
    wx.navigateTo({ url: url })
  },

  goLocal() {
    // 与封面/购物车/商品详情的同城入口同一套契约：先过位置许可再进
    getApp().ensurePrivacyAuthorize()
      .then(function() {
        wx.navigateTo({ url: '/pages/local/index' })
      })
      .catch(function() {
        wx.showToast({ title: '需要同意位置许可才能使用同城配送', icon: 'none' })
      })
  },

  goToAddresses() {
    wx.navigateTo({ url: '/pages/address/list' })
  },

  goToAbout() {
    wx.navigateTo({ url: '/pages/about/index' })
  },

  onContactShop() {
    callShop()
  },
})
