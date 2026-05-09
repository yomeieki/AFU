App({
  globalData: {
    userInfo: null,
    token: null,
    cartCount: 0,
    // Stores a pending categoryId when navigating from homepage to product list via switchTab
    pendingCategoryId: null,
    pendingCategoryName: null,
  },
  onLaunch() {
    const token = wx.getStorageSync('token')
    if (token) {
      this.globalData.token = token
    }
  },
})
