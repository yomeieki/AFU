// 积分明细：顶部余额 + 到期提示（滚动续期口径），下面是分页流水。
//
// 分页/防重复加载/「没有更多了」的体例照 pages/order/list.js，登录门照 pages/user/index.js。
//
// 两个容易搞反的点，改这页前先看一眼：
//  1. 行里 refType='ORDER' 时，**refId 才是 Order.id**（跳详情用它），orderNo 只是给人看的单号；
//     orderNo 为 null 表示服务端没联查到「本人的」单，这时既不显示单号也不让点。
//  2. typeLabel 是服务端拼好的中文，页面不再 map 一遍——两边各存一份映射，日后必然改漏一处。
var memberApi = require('../../api/member')
var wechatLogin = require('../../api/auth').wechatLogin

var PAGE_SIZE = 20

function pad2(n) {
  return n < 10 ? '0' + n : '' + n
}

// ISO 串 → 本地时间文案。withTime=false 只要日期。
// 解析不了就退回原串的前半段，宁可显示 "2026-09-06" 也不能给顾客看 Invalid Date。
function formatTime(v, withTime) {
  if (!v) return ''
  var d = new Date(v)
  if (isNaN(d.getTime())) {
    return String(v).slice(0, withTime ? 16 : 10).replace('T', ' ')
  }
  var text = d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
  if (!withTime) return text
  return text + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes())
}

function decorate(row) {
  var delta = row.delta || 0
  var isOrder = row.refType === 'ORDER'
  return {
    typeLabel: row.typeLabel,
    createdAtText: formatTime(row.createdAt, true),
    // delta 自带负号，负数原样显示；只有正数要补 '+'
    deltaText: (delta > 0 ? '+' : '') + delta,
    positive: delta > 0,
    remark: row.remark || '',
    orderNo: isOrder ? row.orderNo || '' : '',
    // 可点的前提是「有本人的那张单」——orderNo 联查不到时 refId 也不值得信
    linkId: isOrder && row.orderNo ? row.refId : '',
    // 「有效期至」只有入账行有意义
    expiresAtText: delta > 0 && row.expiresAt ? formatTime(row.expiresAt, false) : '',
  }
}

/**
 * 有效期的自然表述：365 天说「1 年」，其余说「N 天」。
 *
 * 定稿文案是「若 **1 年** 内无消费…」，而规则说明那一段是按后台 validDays 实时渲染的
 * （定稿开篇就禁止写死数字）。这行若也写死「1 年」，店主把有效期改成 180 天之后，
 * 同一个页面上就会一处说 1 年、一处说 180 天。PO 2026-09-06 确认「有效期就是一年」，
 * 所以默认渲染出来仍是「1 年」，一个字都没变；变的只是它不再可能与规则说明打架。
 */
function validDaysText(days) {
  var n = Number(days)
  if (!n || n <= 0) return ''
  return n === 365 ? '1 年' : n + ' 天'
}

Page({
  data: {
    needLogin: false,
    loading: true,
    loadFailed: false,
    summaryReady: false,
    balance: 0,
    expireAtText: '',
    validDaysText: '',
    showExpireTip: false,
    list: [],
    page: 1,
    hasMore: true,
    loadingMore: false,
  },

  onShow: function () {
    var self = this
    var app = getApp()
    app._tryLogin()
      .then(function () {
        self.setData({ needLogin: false })
        self.loadPage(true)
      })
      .catch(function () {
        self.setData({ needLogin: true, loading: false })
      })
  },

  onReachBottom: function () {
    if (this.data.needLogin || this.data.loading || this.data.loadingMore) return
    if (this.data.loadFailed || !this.data.hasMore) return
    this.loadPage(false)
  },

  // reset=true 重拉第一页（连同顶部汇总）；false 追加下一页
  loadPage: function (reset) {
    var self = this
    var page = reset ? 1 : this.data.page + 1
    // onShow 重拉时可能还有一次翻页在途，用序号把过期响应丢掉
    var seq = (this._seq = (this._seq || 0) + 1)

    if (reset) {
      this.setData({ loading: true, loadFailed: false })
      // 汇总挂了不该把整页判成失败——列表才是本页的正文。
      // 所以 silent 拉（不弹 toast），失败就不显示顶部那一行。
      memberApi.getSummary(true)
        .then(function (data) {
          if (seq !== self._seq) return
          self.applySummary(data)
        })
        .catch(function () {})
    } else {
      this.setData({ loadingMore: true })
    }

    memberApi.getPointsLedger(page, PAGE_SIZE)
      .then(function (data) {
        if (seq !== self._seq) return
        var rows = (data.list || []).map(decorate)
        var list = reset ? rows : self.data.list.concat(rows)
        self.setData({
          list: list,
          page: page,
          // 空页也当到底，避免 total 偏大时一直往下翻
          hasMore: rows.length > 0 && list.length < (data.total || 0),
          loading: false,
          loadingMore: false,
          loadFailed: false,
        })
      })
      .catch(function () {
        if (seq !== self._seq) return
        if (reset) {
          // 失败态和空态必须是两块界面：接口挂了显示成「暂无积分记录」，顾客会当成真的没有
          self.setData({ loading: false, loadingMore: false, loadFailed: true, list: [] })
        } else {
          // 追加失败不推翻已经拉到的几页，回到「还能再拉」的状态就行
          self.setData({ loadingMore: false })
        }
      })
  },

  applySummary: function (data) {
    var balance = (data && data.pointsBalance) || 0
    var expireAt = data && data.pointsExpireAt
    var validText = validDaysText(data && data.points && data.points.validDays)
    this.setData({
      summaryReady: true,
      balance: balance,
      expireAtText: formatTime(expireAt, false),
      validDaysText: validText,
      // 滚动续期口径：这行说的是「全部积分」统一的到期日，取 pointsExpireAt。
      // summary 里还有个 expiringSoon，那是按批算的旧口径，续期后语义已变，
      // 不能拿它渲染「N 分即将过期」（docs/member-terms-copy.md 已定稿改口径）。
      showExpireTip: balance > 0 && !!expireAt && !!validText,
    })
  },

  onRetry: function () {
    this.loadPage(true)
  },

  goShop: function () {
    wx.switchTab({ url: '/pages/index/index' })
  },

  goOrderDetail: function (e) {
    // 空串 = 非 ORDER 行，或联查不到本人的单
    var id = e.currentTarget.dataset.id
    if (!id) return
    wx.navigateTo({ url: '/pages/order/detail?id=' + id })
  },

  // 照 pages/user/index.js 的 onLogin，另加一道在途守卫
  onLogin: function () {
    var self = this
    if (this._logging) return
    this._logging = true
    wx.showLoading({ title: '登录中...' })
    wx.login({
      success: function (res) {
        if (!res.code) {
          self._logging = false
          wx.hideLoading()
          wx.showToast({ title: '获取登录码失败', icon: 'none' })
          return
        }
        wechatLogin(res.code)
          .then(function (data) {
            self._logging = false
            wx.hideLoading()
            var app = getApp()
            app.globalData.token = data.token
            app.globalData.userInfo = { nickname: data.nickname, avatarUrl: data.avatarUrl }
            wx.setStorageSync('token', data.token)
            self.setData({ needLogin: false })
            self.loadPage(true)
          })
          .catch(function () {
            self._logging = false
            wx.hideLoading()
            wx.showToast({ title: '登录失败，请重试', icon: 'none' })
          })
      },
      fail: function () {
        self._logging = false
        wx.hideLoading()
        wx.showToast({ title: '登录失败', icon: 'none' })
      },
    })
  },
})
