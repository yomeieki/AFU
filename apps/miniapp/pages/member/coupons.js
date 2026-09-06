// 我的券：可用 / 已用 / 已过期 三个 Tab。
//
// 改这页前先看一眼这三条：
//  1. status 查询值只认 available|used|expired 三个**小写**串（服务端 zod enum），
//     不是库里的 UNUSED/USED/EXPIRED —— 传错了是 400，不是空列表。
//  2. 取数放在 onShow 而不是 onLoad：从领券中心领完券返回时，页面不会重新 onLoad，
//     只在 onLoad 拉一次的话，刚领到的券在「可用」里看不见，顾客会以为没领上。
//  3. 「加载失败」和「暂无券」是两块界面。接口挂了显示成「暂无可用券」，
//     顾客和店主都会当成真的没有券，然后来一通电话。
var memberApi = require('../../api/member')
var wechatLogin = require('../../api/auth').wechatLogin

// Tab 与查询值一一对应。空态文案跟着 Tab 走 ——「暂无可用券」和「暂无已用券」
// 对顾客是两件事，共用一句会让人以为券丢了。
var TABS = [
  { label: '可用', status: 'available', empty: '暂无可用券' },
  { label: '已用', status: 'used', empty: '暂无已用券' },
  { label: '已过期', status: 'expired', empty: '暂无过期券' },
]

// channel=ALL 不出标 —— 满屏「全渠道通用」是噪音，只有受限的券才需要提醒
var CHANNEL_LABEL = { LOCAL: '同城专享', EXPRESS: '邮寄专享' }

function pad2(n) {
  return n < 10 ? '0' + n : '' + n
}

// ISO 串 → 本地日期。expiresAt 是「发放时刻 + validDays 天」的精确时间戳，
// 但顾客只关心哪天作废，精确到分钟反而要在心里换算。
// 解析不了退回原串前 10 位，宁可显示 "2026-09-06" 也不能给顾客看 Invalid Date。
function dayText(v) {
  if (!v) return ''
  var d = new Date(v)
  if (isNaN(d.getTime())) return String(v).slice(0, 10)
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
}

// 门槛是一句话，不是价格排版：整元时不拖 .00，「满 ¥50 可用」比「满 ¥50.00 可用」好读
function thresholdText(threshold) {
  var fen = threshold || 0
  if (fen <= 0) return '无门槛'
  var yuan = fen % 100 === 0 ? '' + fen / 100 : (fen / 100).toFixed(2)
  return '满 ¥' + yuan + ' 可用'
}

// status 由所在 Tab 决定，不看 coupon.status —— 「可用」Tab 里的行库里是 UNUSED，
// 「已过期」Tab 里既有 EXPIRED 也有「UNUSED 但已过期」的行（服务端 listUserCoupons 的口径）。
function decorate(coupon, status) {
  var used = status === 'used'
  var expired = status === 'expired'
  return {
    id: coupon.id,
    code: coupon.code || '',
    name: coupon.name,
    amount: coupon.amount,
    // 只有已用券的 orderId 有意义；为空说明关联单查不到，那就不给点
    orderId: used ? coupon.orderId || '' : '',
    thresholdText: thresholdText(coupon.threshold),
    channelLabel: CHANNEL_LABEL[coupon.channel] || '',
    channelClass: coupon.channel === 'LOCAL' ? 'local' : 'express',
    expiresText: dayText(coupon.expiresAt),
    usedText: used ? dayText(coupon.usedAt) : '',
    isUsed: used,
    isExpired: expired,
    // 已用和已过期都没有面额可用了，面额区一起置灰；只有已过期整卡再灰一层
    dim: used || expired,
  }
}

Page({
  data: {
    tabs: TABS,
    activeTab: 0,
    emptyText: TABS[0].empty,
    list: [],
    needLogin: false,
    loading: true,
    loadFailed: false,
    loadFailedText: '',
  },

  // 登录门（房规 §5）。未登录既不是加载失败也不是空态，给一块能点登录的占位。
  onShow: function () {
    this.enter()
  },

  onPullDownRefresh: function () {
    this.enter()
  },

  enter: function () {
    var self = this
    getApp()
      ._tryLogin()
      .then(function () {
        self.setData({ needLogin: false })
        self.load()
      })
      .catch(function () {
        self.setData({ needLogin: true, loading: false, loadFailed: false, list: [] })
        wx.stopPullDownRefresh()
      })
  },

  load: function () {
    var self = this
    var tab = TABS[this.data.activeTab]
    // 快速切 Tab 时丢弃过期响应，否则「可用」的数据可能落在「已过期」页签下
    var seq = (this._seq = (this._seq || 0) + 1)
    this.setData({ loading: true, loadFailed: false, loadFailedText: '' })
    memberApi
      .getCoupons(tab.status)
      .then(function (data) {
        if (seq !== self._seq) return
        var raw = (data && data.list) || []
        var list = raw.map(function (coupon) {
          return decorate(coupon, tab.status)
        })
        self.setData({ list: list, loading: false })
        wx.stopPullDownRefresh()
      })
      .catch(function (err) {
        if (seq !== self._seq) return
        self.setData({
          list: [],
          loading: false,
          loadFailed: true,
          loadFailedText: (err && err.message) || '优惠券加载失败',
        })
        wx.stopPullDownRefresh()
      })
  },

  onRetry: function () {
    this.load()
  },

  onTabChange: function (e) {
    var idx = e.currentTarget.dataset.idx
    if (idx === this.data.activeTab) return
    this.setData({ activeTab: idx, emptyText: TABS[idx].empty, list: [] })
    if (this.data.needLogin) return
    this.load()
  },

  // 已用券整块可点进订单详情；orderId 为空（关联单查不到）时是死链，直接不响应
  goOrder: function (e) {
    var orderId = e.currentTarget.dataset.orderId
    if (!orderId) return
    wx.navigateTo({ url: '/pages/order/detail?id=' + orderId })
  },

  goClaim: function () {
    wx.navigateTo({ url: '/pages/member/claim' })
  },

  goMall: function () {
    wx.navigateTo({ url: '/pages/member/mall' })
  },

  // 照 pages/user/index.js 的 onLogin 抄进本页，不做跨页共享模块（YAGNI）
  onLogin: function () {
    var self = this
    if (this._logging) return
    this._logging = true
    wx.showLoading({ title: '登录中...' })
    wx.login({
      success: function (res) {
        if (!res.code) {
          wx.hideLoading()
          self._logging = false
          wx.showToast({ title: '获取登录码失败', icon: 'none' })
          return
        }
        wechatLogin(res.code)
          .then(function (data) {
            wx.hideLoading()
            self._logging = false
            var app = getApp()
            app.globalData.token = data.token
            app.globalData.userInfo = { nickname: data.nickname, avatarUrl: data.avatarUrl }
            wx.setStorageSync('token', data.token)
            wx.setStorageSync('userInfo', app.globalData.userInfo)
            self.setData({ needLogin: false })
            self.load()
          })
          .catch(function () {
            wx.hideLoading()
            self._logging = false
            wx.showToast({ title: '登录失败，请重试', icon: 'none' })
          })
      },
      fail: function () {
        wx.hideLoading()
        self._logging = false
        wx.showToast({ title: '登录失败', icon: 'none' })
      },
    })
  },
})
