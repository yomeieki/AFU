// 会员中心首页：积分余额 / 到期提示 / 可用券数 + 四宫格入口 + 「规则说明」。
//
// 「规则说明」是 spec §2 的**合规公示项**，提审时审核员会逐条比对，也是纠纷时的依据。
// 文案唯一权威是 docs/member-terms-copy.md（PO 2026-09-05 定稿），下面一字照抄；
// 比例与有效期一律用 getSummary() 返回的 points.earnRatePerYuan / points.validDays
// 实时渲染，**不许写死数字**——写死了店家改设置后就会出现
// 「文案说 100 分、实际发 50 分」这种最难解释的场面。
//
// 到期口径是**滚动续期**（最后一次消费后 N 天，每次订单完成全部积分统一顺延），
// 不是「某批分将于某日过期」。summary 里的 expiringSoon 是滚动续期前的遗留字段，
// 语义已变，本页刻意不用它渲染「N 分即将过期」。

var memberApi = require('../../api/member')
var authApi = require('../../api/auth')

// 四宫格入口。图标复用 app.wxss 里已有的全局 icon 类，不新增素材。
var ENTRIES = [
  { label: '我的券', icon: 'icon-pay', url: '/pages/member/coupons' },
  { label: '积分商城', icon: 'icon-shop', url: '/pages/member/mall' },
  { label: '领券中心', icon: 'icon-done', url: '/pages/member/claim' },
  { label: '积分明细', icon: 'icon-doc', url: '/pages/member/points-log' },
]

// docs/member-terms-copy.md 一、②「固定文案段」——一字不改。
// 要改这里，先改定稿并经 PO 重新确认（那份文件开头就是这么写的）。
var FIXED_RULES = [
  {
    title: '积分怎么来',
    paragraphs: [
      { text: '订单完成后，按本单实付金额发放积分。实付金额包含运费。', strong: false },
    ],
  },
  {
    title: '积分能做什么',
    paragraphs: [
      { text: '用于兑换优惠券，或在下单时兑换随单赠品。', strong: false },
    ],
  },
  {
    title: '退款后积分怎么算',
    paragraphs: [
      { text: '订单发生退款时，按退款金额扣回相应积分。扣回不会超过本单发放过的积分，也不会让积分余额变成负数。', strong: false },
      { text: '若退款时该笔积分已过期或已使用，以实际可扣回的部分为准。', strong: false },
    ],
  },
  {
    title: '赠品退回',
    paragraphs: [
      { text: '若含赠品的订单被取消或退款，兑换赠品所用的积分退回账户。退回积分沿用原有的到期时间，不会因此延长。', strong: false },
    ],
  },
  {
    title: '优惠券',
    paragraphs: [
      { text: '优惠券只抵扣商品金额，不抵扣运费。', strong: false },
      { text: '每笔订单限用一张，不可叠加。', strong: false },
      { text: '是否达到使用门槛，按使用优惠券之前的商品金额判断——不会因为用了券而失去包邮或跌破起送金额。', strong: false },
      { text: '优惠券抵扣后订单金额不能为零；若券面额已超过本单可抵扣范围，请选择其他优惠券。', strong: false },
      { text: '部分优惠券限同城配送或全国邮寄使用，以券面标注为准。', strong: false },
      { text: '订单退款后，本单使用的优惠券不予退回。如对此有疑问，请联系门店。', strong: true },
    ],
  },
  {
    title: '其他',
    paragraphs: [
      { text: '积分与优惠券不可提现、不可转让、不可折现，不开具发票。', strong: false },
      { text: '本店不设积分抽奖、盲盒、签到等玩法。', strong: false },
      { text: '积分与优惠券规则如有调整，将在本页公示。', strong: false },
    ],
  },
]

// docs/member-terms-copy.md 一、①「系统自动生成段」——数字来自后台设置，实时渲染。
// 拿不到 points 时返回空数组（宁可少一段，也不写死一个可能是错的数字）。
function buildAutoRules(points) {
  var rate = points && points.earnRatePerYuan
  var days = points && points.validDays
  if (rate === null || rate === undefined || days === null || days === undefined) return []
  return [
    '每消费 1 元得 ' + rate + ' 分，不足 1 元的部分不计分。',
    '积分的有效期为最后一次消费后 ' + days + ' 天。在此期间内再次消费，全部积分的有效期自动顺延。',
    '若连续 ' + days + ' 天未消费，账户内积分将全部清零。',
    '使用积分时，优先扣除最早到期的那部分。',
  ]
}

// pointsExpireAt 是 ISO 串（服务端 maxExpiresAt.toISOString()），按本地时区取年月日
function formatDay(iso) {
  if (!iso) return ''
  var d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  return d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日'
}

Page({
  data: {
    // 四态：needLogin / loading / loadError / 正常（正常里再分空数据）
    needLogin: false,
    loading: true,
    loadError: false,
    loadErrorText: '',

    pointsBalance: 0,
    availableCoupons: 0,
    expireDate: '',
    showExpireTip: false,
    isEmpty: false,

    entries: ENTRIES,
    autoRules: [],
    fixedRules: FIXED_RULES,
    rulesText: '',
  },

  onShow: function () {
    var self = this
    var app = getApp()
    app._tryLogin()
      .then(function () {
        self.setData({ needLogin: false })
        self.load()
      })
      .catch(function () {
        self.setData({ needLogin: true, loading: false })
      })
  },

  onPullDownRefresh: function () {
    if (this.data.needLogin) {
      wx.stopPullDownRefresh()
      return
    }
    this.load()
  },

  load: function () {
    var self = this
    // 在途守卫：onShow 与下拉/重试可能叠在一起
    if (this._loading) {
      wx.stopPullDownRefresh()
      return
    }
    this._loading = true
    this.setData({ loading: true, loadError: false, loadErrorText: '' })
    // silent：失败时页内已有红字 + 「点此重试」，再弹一个全局 toast 是重复提示
    memberApi
      .getSummary(true)
      .then(function (data) {
        var d = data || {}
        var balance = d.pointsBalance || 0
        var coupons = d.availableCoupons || 0
        var expireDate = formatDay(d.pointsExpireAt)
        var extra = d.rulesText ? String(d.rulesText).replace(/^\s+|\s+$/g, '') : ''
        self._loading = false
        self.setData({
          loading: false,
          loadError: false,
          pointsBalance: balance,
          availableCoupons: coupons,
          expireDate: expireDate,
          // 余额为 0 或没有到期日时整行不显示（0 分说「将于某日全部过期」是废话）
          showExpireTip: !!expireDate && balance > 0,
          isEmpty: balance === 0 && coupons === 0,
          autoRules: buildAutoRules(d.points),
          rulesText: extra,
        })
        wx.stopPullDownRefresh()
      })
      .catch(function (err) {
        self._loading = false
        // 「加载失败」不能画成空态——把接口挂了显示成「暂无积分」，店主和顾客都会当成真的
        self.setData({
          loading: false,
          loadError: true,
          loadErrorText: (err && err.message) || '加载失败，请稍后重试',
        })
        wx.stopPullDownRefresh()
      })
  },

  onRetry: function () {
    this.load()
  },

  // 照 pages/user/index.js:34 的 onLogin，抽到本页一个方法里（不做跨页共享模块）
  onLogin: function () {
    var self = this
    if (this._logining) return
    this._logining = true
    wx.showLoading({ title: '登录中...' })
    wx.login({
      success: function (res) {
        if (!res.code) {
          wx.hideLoading()
          self._logining = false
          wx.showToast({ title: '获取登录码失败', icon: 'none' })
          return
        }
        authApi
          .wechatLogin(res.code)
          .then(function (data) {
            wx.hideLoading()
            self._logining = false
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
            self._logining = false
            wx.showToast({ title: '登录失败，请重试', icon: 'none' })
          })
      },
      fail: function () {
        wx.hideLoading()
        self._logining = false
        wx.showToast({ title: '登录失败', icon: 'none' })
      },
    })
  },

  goEntry: function (e) {
    var url = e.currentTarget.dataset.url
    if (!url) return
    wx.navigateTo({ url: url })
  },

  goShop: function () {
    wx.switchTab({ url: '/pages/index/index' })
  },
})
