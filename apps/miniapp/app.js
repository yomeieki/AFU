const { wechatLogin } = require('./api/auth')
const { getCart } = require('./api/cart')

// tabBar 中购物车的索引（首页/分类/购物车/我的）
var CART_TAB_INDEX = 2

App({
  globalData: {
    userInfo: null,
    token: null,
    cartCount: 0,
    // Stores a pending categoryId when navigating from homepage to product list via switchTab
    pendingCategoryId: null,
    pendingCategoryName: null,
    // 首页「全部商品」入口：置 true 后 switchTab，分类页 onShow 选中「全部」并复位
    pendingCategoryAll: false,
    // Stores address selected in address list for order confirm page
    selectedAddress: null,
    // 当前待决的官方隐私授权回调，由挂载的 privacy-popup 消费
    privacyResolve: null,
  },
  onLaunch() {
    const token = wx.getStorageSync('token')
    if (token) {
      this.globalData.token = token
    }
    var self = this
    this._tryLogin()
      .then(function() { self.updateCartCount() })
      .catch(function(err) { console.warn('[app] wechatLogin failed', err) })
    if (wx.onNeedPrivacyAuthorization) {
      wx.onNeedPrivacyAuthorization(function(resolve) {
        // 小程序没有全局事件机制；同一时刻只可能有一个待决的授权请求。
        // 新请求覆盖前先 disagree 掉旧的，避免上一轮 Promise 永远悬着。
        var app = getApp()
        var pending = app.globalData.privacyResolve
        if (pending) pending({ event: 'disagree' })
        app.globalData.privacyResolve = resolve
        var pages = getCurrentPages()
        var cur = pages[pages.length - 1]
        var popup = cur && cur.selectComponent && cur.selectComponent('#privacy-popup')
        if (popup) popup.show()
        else {
          app.globalData.privacyResolve = null
          resolve({ event: 'disagree' })
        }
      })
    }
  },
  // 登录（返回 Promise；并发调用共享同一次登录，避免重复 wx.login）
  _tryLogin() {
    if (this._loginPromise) return this._loginPromise
    var self = this
    var p = new Promise(function(resolve, reject) {
      wx.login({
        success: function(res) {
          if (!res.code) return reject(new Error('wx.login: no code'))
          wechatLogin(res.code)
            .then(function(data) {
              self.globalData.token = data.token
              self.globalData.userInfo = {
                nickname: data.nickname,
                avatarUrl: data.avatarUrl,
              }
              wx.setStorageSync('token', data.token)
              resolve(data)
            })
            .catch(reject)
        },
        fail: reject,
      })
    })
    this._loginPromise = p
    var clear = function() {
      if (self._loginPromise === p) self._loginPromise = null
    }
    p.then(clear, clear)
    return p
  },
  // 主动拉起官方隐私授权（未授权时会走到 onNeedPrivacyAuthorization → privacy-popup）。
  // 同城入口提前问，避免顾客进到选点才被拦。
  ensurePrivacyAuthorize() {
    return new Promise(function(resolve, reject) {
      if (!wx.requirePrivacyAuthorize) {
        resolve()
        return
      }
      wx.requirePrivacyAuthorize({
        success: function() { resolve() },
        fail: function(err) { reject(err || new Error('privacy denied')) },
      })
    })
  },
  // 刷新购物车数量并更新 tabBar 角标（登录成功、加购、购物车变更、下单后调用）
  updateCartCount() {
    var self = this
    // tabBar 角标只统计邮寄购物车——同城购物车的件数由 pages/local/index 底部条自己显示。
    // 两个渠道的件数加在一个角标上，顾客点进购物车会发现数字对不上。
    getCart('EXPRESS')
      .then(function(data) {
        var items = (data && data.items) || []
        var count = items.reduce(function(sum, item) {
          return sum + (item.quantity || 0)
        }, 0)
        self.globalData.cartCount = count
        if (count > 0) {
          wx.setTabBarBadge({ index: CART_TAB_INDEX, text: count > 99 ? '99+' : String(count) })
        } else {
          wx.removeTabBarBadge({ index: CART_TAB_INDEX })
        }
      })
      .catch(function() {
        // 未登录等场景静默忽略
      })
  },
})
