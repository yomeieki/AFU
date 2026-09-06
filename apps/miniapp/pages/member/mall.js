// 积分商城。两个 Tab 共用一次 GET /member/mall：
//   Tab 一「换优惠券」——积分直接换券，成功后重拉列表刷新余额与置灰状态；
//   Tab 二「随单赠品」——**只展示不兑换**。赠品是「结算时用积分加购、随订单一起履约」
//   的东西，不是独立的 0 元兑换单；这里放「兑换」按钮会让顾客以为兑完就等收货，
//   所以按钮是「去下单」，把人送回对应渠道的商品页。
var memberApi = require('../../api/member')
var authApi = require('../../api/auth')
var formatUtil = require('../../utils/format')

// 券模板的 channel 是 ALL | LOCAL | EXPRESS；ALL 两个渠道都能用，不打标（打了反像限制）。
// 赠品的 channel 冗余自商品分类，服务端 GET /member/mall 里取的是 product.channel，
// 只会是 LOCAL | EXPRESS（apps/server/src/utils/channel.ts 的 CHANNELS）。
var CHANNEL_TAG = { LOCAL: '同城专享', EXPRESS: '邮寄专享' }
var CHANNEL_CLASS = { LOCAL: 'local', EXPRESS: 'express' }

// 兑换错误码 → 文案（房规 §4）。其余码（42251/42252 等）原样用服务端 message
var REDEEM_ERROR = {
  42250: '积分不足',
  42253: '该券已领完或已达上限',
  42254: '该活动已结束',
}

function decorateCoupon(tpl, balance) {
  var cost = tpl.pointsCost || 0
  return {
    id: tpl.id,
    name: tpl.name,
    description: tpl.description || '',
    amountText: formatUtil.formatPrice(tpl.amount),
    // threshold 为 0（或空）= 代金券，无门槛
    thresholdText: tpl.threshold ? '满 ¥' + formatUtil.formatPrice(tpl.threshold) + ' 可用' : '无门槛',
    channelTag: CHANNEL_TAG[tpl.channel] || '',
    channelClass: CHANNEL_CLASS[tpl.channel] || '',
    validText: '领取后 ' + tpl.validDays + ' 天内有效',
    pointsCost: cost,
    affordable: balance >= cost,
  }
}

function decorateGift(good) {
  return {
    id: good.id,
    name: good.name,
    image: good.image || '',
    specText: good.specText || '',
    pointsCost: good.pointsCost || 0,
    limitText: '每单限 ' + good.perOrderLimit + ' 件',
    // remaining 为 null = 不限量，不显示「仅剩」，免得顾客以为是 0
    remainingText: good.remaining === null || good.remaining === undefined ? '' : '仅剩 ' + good.remaining + ' 份',
    channelTag: CHANNEL_TAG[good.channel] || '',
    channelClass: CHANNEL_CLASS[good.channel] || '',
    // channel 缺失时按邮寄兜底（邮寄是 Product.channel 的默认值，也是 tabBar 主页）
    isLocal: good.channel === 'LOCAL',
  }
}

Page({
  data: {
    needLogin: false,
    loading: true,
    // 「加载失败」与「暂无」是两块界面：接口挂了显示成「暂无优惠券」，店主和顾客都会当真
    loadError: false,
    activeTab: 0,
    pointsBalance: 0,
    coupons: [],
    gifts: [],
  },

  onShow: function() {
    var self = this
    getApp()
      ._tryLogin()
      .then(function() {
        self.setData({ needLogin: false })
        self.load()
      })
      .catch(function() {
        self.setData({ needLogin: true, loading: false })
      })
  },

  // 登录门的按钮（照 pages/user/index.js 的 onLogin，本页自留一份，不做跨页共享模块）
  onLogin: function() {
    var self = this
    wx.showLoading({ title: '登录中...' })
    wx.login({
      success: function(res) {
        if (!res.code) {
          wx.hideLoading()
          wx.showToast({ title: '获取登录码失败', icon: 'none' })
          return
        }
        authApi
          .wechatLogin(res.code)
          .then(function(data) {
            wx.hideLoading()
            var app = getApp()
            app.globalData.token = data.token
            app.globalData.userInfo = { nickname: data.nickname, avatarUrl: data.avatarUrl }
            wx.setStorageSync('token', data.token)
            wx.setStorageSync('userInfo', app.globalData.userInfo)
            self.setData({ needLogin: false })
            self.load()
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

  load: function() {
    var self = this
    this.setData({ loading: true, loadError: false })
    memberApi
      .getMall()
      .then(function(data) {
        var payload = data || {}
        var balance = payload.pointsBalance || 0
        var coupons = (payload.coupons || []).map(function(tpl) {
          return decorateCoupon(tpl, balance)
        })
        var gifts = (payload.gifts || []).map(decorateGift)
        self.setData({
          pointsBalance: balance,
          coupons: coupons,
          gifts: gifts,
          loading: false,
          loadError: false,
        })
        wx.stopPullDownRefresh()
      })
      .catch(function() {
        self.setData({ loading: false, loadError: true })
        wx.stopPullDownRefresh()
      })
  },

  onPullDownRefresh: function() {
    if (this.data.needLogin) {
      wx.stopPullDownRefresh()
      return
    }
    this.load()
  },

  onRetry: function() {
    this.load()
  },

  onTabChange: function(e) {
    this.setData({ activeTab: Number(e.currentTarget.dataset.idx) })
  },

  onRedeem: function(e) {
    var self = this
    var item = this.data.coupons[e.currentTarget.dataset.idx]
    if (!item) return
    // 余额不足的按钮是置灰态，点了不该发请求
    if (!item.affordable) return
    if (this._redeeming) return
    wx.showModal({
      title: '兑换确认',
      content: '用 ' + item.pointsCost + ' 积分兑换「' + item.name + '」？',
      confirmText: '兑换',
      success: function(res) {
        if (!res.confirm) return
        // 连点两下会排两个 modal，第二个确认时这里已经是 true
        if (self._redeeming) return
        self._redeeming = true
        wx.showLoading({ title: '兑换中...', mask: true })
        memberApi
          .redeemCoupon(item.id)
          .then(function() {
            self._redeeming = false
            wx.hideLoading()
            wx.showToast({ title: '兑换成功', icon: 'success' })
            // 重拉：余额、按钮置灰状态、券种上下架一起刷新
            self.load()
          })
          .catch(function(err) {
            self._redeeming = false
            wx.hideLoading()
            var code = err && err.code
            var msg = REDEEM_ERROR[code] || (err && err.message) || '兑换失败，请重试'
            wx.showToast({ title: msg, icon: 'none', duration: 2000 })
            // 42250/42253/42254 都意味着页面上的数字已经过时，顺手重拉一次
            self.load()
          })
      },
    })
  },

  // 「去下单」：与封面 pages/cover/index.js 的 goLocal/goExpress 同一套契约。
  // 同城要先过位置许可（避免进到地图选点那一步才被拦）；邮寄主页是 tabBar[0]，只能 switchTab。
  onGoOrder: function(e) {
    var item = this.data.gifts[e.currentTarget.dataset.idx]
    if (!item) return
    if (item.isLocal) {
      getApp()
        .ensurePrivacyAuthorize()
        .then(function() {
          wx.navigateTo({ url: '/pages/local/index' })
        })
        .catch(function() {
          wx.showToast({ title: '需要同意位置许可才能使用同城配送', icon: 'none' })
        })
      return
    }
    wx.switchTab({ url: '/pages/index/index' })
  },
})
