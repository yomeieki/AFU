const { baseURL } = require('../../config/index')
var share = require('../../utils/share')

Page({
  onShareAppMessage: share.onShareAppMessage,
  data: {
    username: '',
    password: '',
    submitting: false,
  },

  onInputUsername(e) {
    this.setData({ username: e.detail.value })
  },

  onInputPassword(e) {
    this.setData({ password: e.detail.value })
  },

  onSubmit() {
    var username = this.data.username.trim()
    var password = this.data.password
    if (!username || !password) {
      wx.showToast({ title: '请输入账号和密码', icon: 'none' })
      return
    }
    if (this.data.submitting) return
    this.setData({ submitting: true })
    var self = this
    // 直调 wx.request：商家登录用独立 merchant_token，不走顾客端 request 工具
    wx.request({
      url: baseURL + '/admin/login',
      method: 'POST',
      data: { username: username, password: password },
      header: { 'Content-Type': 'application/json' },
      success(res) {
        var body = res.data
        if (body && body.code === 0 && body.data && body.data.token) {
          wx.setStorageSync('merchant_token', body.data.token)
          wx.redirectTo({ url: '/pages/merchant/index' })
        } else {
          wx.showToast({ title: (body && body.message) || '登录失败', icon: 'none' })
        }
      },
      fail() {
        wx.showToast({ title: '网络错误，请稍后重试', icon: 'none' })
      },
      complete() {
        self.setData({ submitting: false })
      },
    })
  },
})
