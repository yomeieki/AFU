// 领券中心：列 CAMPAIGN 券模板，点「领取」发一张到自己名下。
//
// 两个坑，改这页前先看一眼：
//  1. 在途守卫按**券 id** 分别挂（this._claiming 是个 map），不是一把全局锁。
//     全局锁会把整页按钮一起锁死，顾客点完第一张再点第二张会以为页面卡了。
//  2. remaining === null 表示不限量，不是 0 —— 拿它当假值判会把不限量的券判成已领完。
var memberApi = require('../../api/member')
var wechatLogin = require('../../api/auth').wechatLogin

// channel=ALL 不出标 —— 只有受限的券才需要提醒
var CHANNEL_LABEL = { LOCAL: '同城专享', EXPRESS: '邮寄专享' }

function isNil(v) {
  return v === null || v === undefined
}

// 门槛是一句话，不是价格排版：整元时不拖 .00
function thresholdText(threshold) {
  var fen = threshold || 0
  if (fen <= 0) return '无门槛'
  var yuan = fen % 100 === 0 ? '' + fen / 100 : (fen / 100).toFixed(2)
  return '满 ¥' + yuan + ' 可用'
}

function decorate(t) {
  var remaining = t.remaining
  var perUserLimit = t.perUserLimit
  var claimedByMe = t.claimedByMe || 0
  // remaining 为 null = 不限量；只有明确给了数且为 0 才是领完了
  var soldOut = !isNil(remaining) && remaining <= 0
  // 达上限时按钮也要停下来。不拦的话点一次必定吃 42253，顾客只会以为系统坏了
  var limitReached = !isNil(perUserLimit) && claimedByMe >= perUserLimit

  var claimedText = ''
  if (!isNil(perUserLimit)) claimedText = '本人已领 ' + claimedByMe + '/' + perUserLimit
  else if (claimedByMe > 0) claimedText = '本人已领 ' + claimedByMe + ' 张'

  var btnText = '领取'
  if (soldOut) btnText = '已领完'
  else if (limitReached) btnText = '已达上限'

  return {
    id: t.id,
    name: t.name,
    description: t.description || '',
    amount: t.amount,
    thresholdText: thresholdText(t.threshold),
    channelLabel: CHANNEL_LABEL[t.channel] || '',
    channelClass: t.channel === 'LOCAL' ? 'local' : 'express',
    validText: '领取后 ' + t.validDays + ' 天内有效',
    // 领完了就别再写「仅剩 0 张」，按钮已经说了
    remainingText: soldOut || isNil(remaining) ? '' : '仅剩 ' + remaining + ' 张',
    claimedText: claimedText,
    disabled: soldOut || limitReached,
    btnText: btnText,
    claiming: false,
  }
}
var share = require('../../utils/share')

Page({
  onShareAppMessage: share.onShareAppMessage,
  data: {
    list: [],
    needLogin: false,
    loading: true,
    loadFailed: false,
    loadFailedText: '',
  },

  // 登录门（房规 §5）
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

  // quiet=true：领完券后的回拉。不翻 loading，否则刚领到就闪一屏「加载中」
  load: function (quiet) {
    var self = this
    var seq = (this._seq = (this._seq || 0) + 1)
    this.setData(quiet ? { loadFailed: false } : { loading: true, loadFailed: false, loadFailedText: '' })
    memberApi
      .getCampaign()
      .then(function (data) {
        if (seq !== self._seq) return
        var raw = (data && data.list) || []
        self.setData({ list: raw.map(decorate), loading: false })
        wx.stopPullDownRefresh()
      })
      .catch(function (err) {
        if (seq !== self._seq) return
        // 静默回拉失败：列表还在，不要把顾客已经看到的活动换成一屏错误
        // （request 已经弹过 toast 了，这里不再重复说一遍）
        if (quiet) {
          self.setData({ loading: false })
          wx.stopPullDownRefresh()
          return
        }
        self.setData({
          list: [],
          loading: false,
          loadFailed: true,
          loadFailedText: (err && err.message) || '活动加载失败',
        })
        wx.stopPullDownRefresh()
      })
  },

  onRetry: function () {
    this.load()
  },

  onClaim: function (e) {
    var idx = e.currentTarget.dataset.idx
    var item = this.data.list[idx]
    if (!item || item.disabled) return
    var id = item.id

    // 在途守卫按券 id 分开（房规 §6）。挂在 this 上不进 data —— 它不参与渲染，
    // 渲染用的是 list[idx].claiming，两者各管各的。
    if (!this._claiming) this._claiming = {}
    if (this._claiming[id]) return
    this._claiming[id] = true

    var self = this
    var busy = {}
    busy['list[' + idx + '].claiming'] = true
    this.setData(busy)

    // 回拉可能已经把 list 换掉，索引对不上就别乱打补丁
    var release = function () {
      self._claiming[id] = false
      var cur = self.data.list[idx]
      if (!cur || cur.id !== id) return
      var done = {}
      done['list[' + idx + '].claiming'] = false
      self.setData(done)
    }

    memberApi
      .claimCoupon(id)
      .then(function () {
        release()
        wx.showToast({ title: '领取成功', icon: 'success' })
        // 剩余量和「本人已领」都变了，回拉一次让卡片跟上
        self.load(true)
      })
      .catch(function (err) {
        release()
        var code = err && err.code
        var msg = (err && err.message) || '领取失败，请稍后再试'
        if (code === 42253) msg = '该券已领完或已达上限'
        else if (code === 42254) msg = '该活动已结束'
        wx.showToast({ title: msg, icon: 'none', duration: 2000 })
        // 这两个码说明这张券的状态已经跟页面不一致了，回拉一次把按钮改对
        if (code === 42253 || code === 42254) self.load(true)
      })
  },

  goCoupons: function () {
    // 多半就是从「我的券」点进来的，那就退回去。一路 navigateTo 会在栈里叠出
    // 第二个「我的券」，来回几次就顶到 10 层上限打不开新页了。
    var pages = getCurrentPages()
    var prev = pages.length > 1 ? pages[pages.length - 2] : null
    if (prev && prev.route && prev.route.indexOf('pages/member/coupons') !== -1) {
      wx.navigateBack()
      return
    }
    wx.navigateTo({ url: '/pages/member/coupons' })
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
