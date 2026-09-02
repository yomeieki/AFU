const { baseURL } = require('../../config/index')

Page({
  data: {
    loading: true,
    pendingCount: 0,
    refundingCount: 0,
    afterSaleCount: 0,
    opening: false,
  },

  onShow() {
    this.checkAndLoad()
  },

  _token() {
    return wx.getStorageSync('merchant_token')
  },

  _backToLogin() {
    wx.removeStorageSync('merchant_token')
    wx.redirectTo({ url: '/pages/merchant/login' })
  },

  checkAndLoad() {
    var token = this._token()
    if (!token) {
      wx.redirectTo({ url: '/pages/merchant/login' })
      return
    }
    var self = this
    this.setData({ loading: true })
    // 用 pending-count 一石二鸟：校验 token 有效性 + 拿待处理数
    wx.request({
      url: baseURL + '/admin/orders/pending-count',
      header: { Authorization: 'Bearer ' + token },
      success(res) {
        var body = res.data
        if (body && body.code === 0) {
          self.setData({
            loading: false,
            pendingCount: body.data.count || 0,
            refundingCount: body.data.refundingCount || 0,
            afterSaleCount: body.data.afterSaleCount || 0,
          })
        } else if (res.statusCode === 401 || (body && (body.code === 40101 || body.code === 40102))) {
          self._backToLogin()
        } else {
          self.setData({ loading: false })
          wx.showToast({ title: (body && body.message) || '加载失败', icon: 'none' })
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

  // 进入管理后台：换一次性 code 后打开内嵌网页（code 60 秒内单次有效，token 不进 URL）
  onOpenAdmin(e) {
    var token = this._token()
    if (!token) {
      this._backToLogin()
      return
    }
    if (this.data.opening) return
    var self = this
    var target = (e && e.currentTarget && e.currentTarget.dataset.target) || ''
    this.setData({ opening: true })
    wx.request({
      url: baseURL + '/admin/webview-code',
      method: 'POST',
      header: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      success(res) {
        var body = res.data
        if (body && body.code === 0 && body.data && body.data.code) {
          wx.navigateTo({
            url: '/pages/merchant/webview?code=' + body.data.code + (target ? '&target=' + encodeURIComponent(target) : ''),
          })
        } else if (res.statusCode === 401) {
          self._backToLogin()
        } else {
          wx.showToast({ title: (body && body.message) || '打开失败，请重试', icon: 'none' })
        }
      },
      fail() {
        wx.showToast({ title: '网络错误，请稍后重试', icon: 'none' })
      },
      complete() {
        self.setData({ opening: false })
      },
    })
  },

  onLogout() {
    var self = this
    wx.showModal({
      title: '退出商家登录',
      content: '确认退出商家管理？',
      success(res) {
        if (res.confirm) self._backToLogin()
      },
    })
  },
})
