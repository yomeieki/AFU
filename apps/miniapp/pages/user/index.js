Page({
  data: {
    isLoggedIn: false,
  },

  onLoad() {},

  onLogin() {
    wx.showToast({ title: '登录功能即将上线', icon: 'none', duration: 2000 })
  },

  onMenuTap(e) {
    wx.showToast({ title: e.currentTarget.dataset.title + '即将上线', icon: 'none', duration: 2000 })
  },
})
