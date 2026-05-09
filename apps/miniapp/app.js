App({
  globalData: {
    userInfo: null,
    token: null,
    cartCount: 0,
  },
  onLaunch() {
    const token = wx.getStorageSync('token')
    if (token) {
      this.globalData.token = token
    }
  },
})
