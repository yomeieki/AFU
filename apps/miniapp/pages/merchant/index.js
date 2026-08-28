const { baseURL, adminUrl } = require('../../config/index')

Page({
  data: {
    loading: true,
    pendingCount: 0,
    adminUrl: adminUrl,
  },

  onShow() {
    this.checkAndLoad()
  },

  checkAndLoad() {
    var token = wx.getStorageSync('merchant_token')
    if (!token) {
      wx.redirectTo({ url: '/pages/merchant/login' })
      return
    }
    var self = this
    this.setData({ loading: true })
    // 用 pending-count 一石二鸟：校验 token 有效性 + 拿待发货数
    wx.request({
      url: baseURL + '/admin/orders/pending-count',
      header: { Authorization: 'Bearer ' + token },
      success(res) {
        var body = res.data
        if (body && body.code === 0) {
          self.setData({ loading: false, pendingCount: body.data.count })
        } else {
          // token 失效：清掉并回登录页
          wx.removeStorageSync('merchant_token')
          wx.redirectTo({ url: '/pages/merchant/login' })
        }
      },
      fail() {
        self.setData({ loading: false })
        wx.showToast({ title: '网络错误，请下拉重试', icon: 'none' })
      },
    })
  },

  onPullDownRefresh() {
    this.checkAndLoad()
    wx.stopPullDownRefresh()
  },

  onCopyLink() {
    wx.setClipboardData({
      data: this.data.adminUrl,
      success() {
        wx.showToast({ title: '已复制，请在浏览器打开', icon: 'none', duration: 2500 })
      },
    })
  },

  onLogout() {
    var self = this
    wx.showModal({
      title: '退出商家登录',
      content: '确认退出商家管理？',
      success(res) {
        if (res.confirm) {
          wx.removeStorageSync('merchant_token')
          wx.redirectTo({ url: '/pages/merchant/login' })
        }
      },
    })
  },
})
