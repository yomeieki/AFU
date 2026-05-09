Page({
  data: {
    isLoggedIn: false,
  },

  onLoad() {},

  onLogin() {
    wx.showToast({ title: '登录功能即将上线', icon: 'none', duration: 2000 })
  },

  goToOrders() {
    wx.navigateTo({ url: '/pages/order/list' })
  },

  goToOrdersByStatus(e) {
    var status = e.currentTarget.dataset.status
    wx.navigateTo({ url: '/pages/order/list?status=' + status })
  },

  goToAddresses() {
    wx.navigateTo({ url: '/pages/address/list' })
  },
})
