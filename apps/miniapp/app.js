const { wechatLogin } = require('./api/auth')

App({
  globalData: {
    userInfo: null,
    token: null,
    cartCount: 0,
    // Stores a pending categoryId when navigating from homepage to product list via switchTab
    pendingCategoryId: null,
    pendingCategoryName: null,
    // Stores address selected in address list for order confirm page
    selectedAddress: null,
  },
  onLaunch() {
    const token = wx.getStorageSync('token')
    if (token) {
      this.globalData.token = token
    }
    this._tryLogin()
  },
  _tryLogin() {
    var self = this
    wx.login({
      success: function(res) {
        if (!res.code) return
        wechatLogin(res.code)
          .then(function(data) {
            self.globalData.token = data.token
            self.globalData.userInfo = {
              nickname: data.nickname,
              avatarUrl: data.avatarUrl,
            }
            wx.setStorageSync('token', data.token)
          })
          .catch(function(err) {
            console.warn('[app] wechatLogin failed', err)
          })
      },
    })
  },
})
