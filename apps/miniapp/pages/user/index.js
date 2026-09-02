const { wechatLogin } = require('../../api/auth')
const { callShop } = require('../../utils/contact')

Page({
  data: {
    isLoggedIn: false,
    nickname: '',
    avatarUrl: '',
  },

  onLoad() {
    this._syncLoginState()
  },

  onShow() {
    this._syncLoginState()
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
