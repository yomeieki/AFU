const { wechatLogin } = require('./api/auth')
const { getCart } = require('./api/cart')
const channelUtil = require('./utils/channel')

// tabBar 中购物车的索引（主页/分类/购物车/我的）
var CART_TAB_INDEX = 2
// tabBar 页路由表——与 app.json 的 tabBar.list 一一对应，改那边记得改这里
var TAB_BAR_PAGES = ['pages/index/index', 'pages/product/list', 'pages/cart/index', 'pages/user/index']

App({
  globalData: {
    userInfo: null,
    token: null,
    cartCount: 0,
    // 当前购物渠道 'EXPRESS' | 'LOCAL'。四个 tabBar 页共用同一套壳，靠它决定加载哪边的内容。
    // **内存里这一份是权威值**；storage 只在冷启动/热重载时把它补回来（见 utils/channel.js）。
    shoppingChannel: 'EXPRESS',
    // 同城子模式 'DELIVERY' | 'PICKUP'。只对 LOCAL 渠道有意义；切到邮寄不清它，切回来还在。
    localMode: 'DELIVERY',
    // Stores a pending categoryId when navigating from homepage to product list via switchTab
    pendingCategoryId: null,
    pendingCategoryName: null,
    // 主页「全部商品」入口：置 true 后 switchTab，分类页 onShow 选中「全部」并复位
    pendingCategoryAll: false,
    // Stores address selected in address list for order confirm page
    selectedAddress: null,
    // 当前待决的官方隐私授权回调，由挂载的 privacy-popup 消费
    privacyResolve: null,
  },
  onLaunch() {
    // 渠道要在任何一次 getCart / 拉商品之前恢复好，否则冷启动第一屏会按错的渠道拉一轮。
    this.globalData.shoppingChannel = channelUtil.getShoppingChannel()
    this.globalData.localMode = channelUtil.getLocalMode()
    const token = wx.getStorageSync('token')
    if (token) {
      this.globalData.token = token
    }
    // pages/user/index 要 token 与 userInfo 同时在才算已登录；
    // 冷启动只恢复 token 的话，「我的」页在静默登录回来前（或离线时）会闪回未登录态
    var userInfo = wx.getStorageSync('userInfo')
    if (userInfo && typeof userInfo === 'object') {
      this.globalData.userInfo = userInfo
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
              wx.setStorageSync('userInfo', self.globalData.userInfo)
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
  // ── 渠道上下文 ──────────────────────────────────────────────
  getShoppingChannel() {
    return channelUtil.normalizeChannel(this.globalData.shoppingChannel)
  },

  getLocalMode() {
    return channelUtil.normalizeLocalMode(this.globalData.localMode)
  },
  // 定子模式：写内存 + 落盘。不动渠道、不清分类意图、不刷角标——两种模式共用同一个购物车。
  setLocalMode(value) {
    var mode = channelUtil.setLocalMode(value)
    this.globalData.localMode = mode
    return mode
  },

  // 定渠道。除了写内存与落盘，还要做两件收尾，漏了都会表现成「切了渠道但页面没跟上」：
  //   ① 清掉待决的分类意图——从同城切回邮寄时，globalData 里可能还压着一个同城分类 id，
  //      分类页 onShow 会照它去选中一个当前渠道根本没有的分类；
  //   ② 立刻刷新角标——角标只统计当前渠道，不刷的话顾客会看到上一个渠道的件数。
  setShoppingChannel(value) {
    var channel = channelUtil.setShoppingChannel(value)
    this.globalData.shoppingChannel = channel
    this.globalData.pendingCategoryId = null
    this.globalData.pendingCategoryName = null
    this.globalData.pendingCategoryAll = false
    this.updateCartCount()
    return channel
  },

  // 同城之门：位置许可 → 定渠道 LOCAL。只做这两步、不跳转，返回是否放行。
  // 拆出来的原因（2026-09-17）：封面底部四栏要进的是「分类 / 购物车」而不只是主页，
  // 分类页的渠道标识切到同城后要**留在本页重载**而不是跳主页——都要这道门，但门后去向各不相同。
  // 用两参数 then 而不是 .catch：调用方的后续失败不能掉进「拒绝许可」这条分支。
  gateLocalChannel() {
    var self = this
    return this.ensurePrivacyAuthorize().then(
      function() {
        self.setShoppingChannel('LOCAL')
        return true
      },
      function() {
        // PO 2026-09-11 定：进同城（含自取）一律要先同意位置许可，不同意就不放行——
        // 同城入口只有一个门，门口只问一次，比「自取免定位、外送到结算页再问」少一种状态
        wx.showToast({ title: '需要同意位置许可才能使用同城配送', icon: 'none' })
        return false
      }
    )
  },

  // 六个同城入口 + 封面四栏的统一出口（封面 / 购物车跨渠道提示 / 商品详情 / 会员商城 / 「我的」/ 旧路由）：
  // 过门 → switchTab 到目标 tab（缺省主页）。顺序不可换的理由见 gateLocalChannel；
  // 跳转失败给的是跳转的错，不是「需要同意位置许可」。
  enterLocalChannel(url) {
    var target = url || '/pages/index/index'
    return this.gateLocalChannel().then(function(ok) {
      if (!ok) return
      wx.switchTab({
        url: target,
        fail: function(err) {
          console.error('[channel] 进入同城失败', err)
          wx.showToast({ title: '页面暂时打不开，请稍后再试', icon: 'none' })
        },
      })
    })
  },

  // 刷新购物车数量并更新 tabBar 角标（登录成功、加购、购物车变更、下单/切渠道后调用）
  updateCartCount() {
    var self = this
    // 角标只统计**当前渠道**的车。两个渠道的件数加在一个角标上，顾客点进购物车会发现数字对不上；
    // 而两个车本身是分开的（服务端按 channel 隔离），合起来也没有任何一页能显示这个和。
    getCart(this.getShoppingChannel())
      .then(function(data) {
        var items = (data && data.items) || []
        var count = items.reduce(function(sum, item) {
          return sum + (item.quantity || 0)
        }, 0)
        self.globalData.cartCount = count
        self.applyCartBadge()
      })
      .catch(function() {
        // 未登录等场景静默忽略
      })
  },

  // 把 globalData.cartCount 写到 tabBar 角标上。
  // 必须先判当前页是不是 tabBar 页：封面页（pages[0]，非 tabBar）在 onLaunch 时就是当前页，
  // 此时调 setTabBarBadge 会 fail «not TabBar page»，且整个首次会话角标都不会出现
  // ——因为另外几个 updateCartCount 调用点都不在启动路径上。
  applyCartBadge() {
    var pages = getCurrentPages()
    var cur = pages[pages.length - 1]
    if (!cur || TAB_BAR_PAGES.indexOf(cur.route) === -1) return
    var count = this.globalData.cartCount
    if (count > 0) {
      wx.setTabBarBadge({ index: CART_TAB_INDEX, text: count > 99 ? '99+' : String(count), fail: function() {} })
    } else {
      wx.removeTabBarBadge({ index: CART_TAB_INDEX, fail: function() {} })
    }
  },
})
