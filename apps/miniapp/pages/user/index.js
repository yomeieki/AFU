const { wechatLogin } = require('../../api/auth')
const { callShop } = require('../../utils/contact')
var memberApi = require('../../api/member')
var share = require('../../utils/share')

Page({
  onShareAppMessage: share.onShareAppMessage,
  data: {
    isLoggedIn: false,
    nickname: '',
    avatarUrl: '',
    // 页头积分/券条。'—' 既是初值也是「拉取失败」态：条目仍可点，
    // 点进会员页会自己重拉并显示自己的失败态，这里不该拦人。
    pointsText: '—',
    couponText: '—',
    // 渠道切换入口的文案。指向**另一个**渠道，不是当前渠道——
    // 写死成「同城配送」的话，顾客已经在同城里时点它等于原地不动。
    otherChannelLabel: '同城配送',
  },

  onLoad() {
    this._syncLoginState()
  },

  onShow() {
    this.setData({
      otherChannelLabel: getApp().getShoppingChannel() === 'LOCAL' ? '全国邮寄' : '同城配送',
    })
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

  // 订单入口带上当前渠道：顾客在同城模式下点「我的订单」，看到的应该是同城的单。
  // 列表页可以切「全部订单」，所以这只是默认视角，不是过滤死。
  orderListUrl: function(status) {
    var url = '/pages/order/list?deliveryType=' + getApp().getShoppingChannel()
    if (status) url += '&status=' + encodeURIComponent(status)
    return url
  },

  goToOrders() {
    wx.navigateTo({ url: this.orderListUrl('') })
  },

  goToOrdersByStatus(e) {
    wx.navigateTo({ url: this.orderListUrl(e.currentTarget.dataset.status) })
  },

  goToMerchant() {
    // 有商家 token 直接进入口页（该页会自行校验有效性兜底），否则先登录
    var url = wx.getStorageSync('merchant_token')
      ? '/pages/merchant/index'
      : '/pages/merchant/login'
    wx.navigateTo({ url: url })
  },

  // 渠道切换。**去的是另一边**：在邮寄里点它进同城，在同城里点它回邮寄。
  // 原来这里写死成「进同城」，顾客已经在同城时点了等于原地不动——
  // 与购物车页跨渠道提示同一类毛病（那条在 Task 6 已改成双向，这条漏了）。
  //
  // 去同城要过位置许可，走 app 的统一出口；回邮寄不需要，定渠道后 switchTab 即可。
  goSwitchChannel() {
    var app = getApp()
    if (app.getShoppingChannel() === 'LOCAL') {
      app.setShoppingChannel('EXPRESS')
      wx.switchTab({ url: '/pages/index/index' })
      return
    }
    app.enterLocalChannel()
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
