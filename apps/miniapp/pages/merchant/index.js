const { baseURL } = require('../../config/index')
var share = require('../../utils/share')

Page({
  onShareAppMessage: share.onShareAppMessage,
  data: {
    loading: true,
    pendingCount: 0,
    refundingCount: 0,
    afterSaleCount: 0,
    opening: false,
    locating: false,
  },

  onShow() {
    this.checkAndLoad()
  },

  _token() {
    return wx.getStorageSync('merchant_token')
  },

  _backToLogin() {
    wx.removeStorageSync('merchant_token')
    wx.redirectTo({ url: '/pages/merchant/login' })
  },

  checkAndLoad() {
    var token = this._token()
    if (!token) {
      wx.redirectTo({ url: '/pages/merchant/login' })
      return
    }
    var self = this
    this.setData({ loading: true })
    // 用 pending-count 一石二鸟：校验 token 有效性 + 拿待处理数
    wx.request({
      url: baseURL + '/admin/orders/pending-count',
      header: { Authorization: 'Bearer ' + token },
      success(res) {
        var body = res.data
        if (body && body.code === 0) {
          self.setData({
            loading: false,
            pendingCount: body.data.count || 0,
            refundingCount: body.data.refundingCount || 0,
            afterSaleCount: body.data.afterSaleCount || 0,
          })
        } else if (res.statusCode === 401 || (body && (body.code === 40101 || body.code === 40102))) {
          self._backToLogin()
        } else {
          self.setData({ loading: false })
          wx.showToast({ title: (body && body.message) || '加载失败', icon: 'none' })
        }
      },
      fail() {
        self.setData({ loading: false })
        wx.showToast({ title: '网络错误，请下拉重试', icon: 'none' })
      },
    })
  },

  onPullDownRefresh() {
    this.checkAndLoad()
    wx.stopPullDownRefresh()
  },

  // 进入管理后台：换一次性 code 后打开内嵌网页（code 60 秒内单次有效，token 不进 URL）
  onOpenAdmin(e) {
    var token = this._token()
    if (!token) {
      this._backToLogin()
      return
    }
    if (this.data.opening) return
    var self = this
    var target = (e && e.currentTarget && e.currentTarget.dataset.target) || ''
    this.setData({ opening: true })
    wx.request({
      url: baseURL + '/admin/webview-code',
      method: 'POST',
      header: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      success(res) {
        var body = res.data
        if (body && body.code === 0 && body.data && body.data.code) {
          wx.navigateTo({
            url: '/pages/merchant/webview?code=' + body.data.code + (target ? '&target=' + encodeURIComponent(target) : ''),
          })
        } else if (res.statusCode === 401) {
          self._backToLogin()
        } else {
          wx.showToast({ title: (body && body.message) || '打开失败，请重试', icon: 'none' })
        }
      },
      fail() {
        wx.showToast({ title: '网络错误，请稍后重试', icon: 'none' })
      },
      complete() {
        self.setData({ opening: false })
      },
    })
  },

  // 设置门店坐标：用 wx.chooseLocation 打开地图选点（而非 wx.getLocation 自动定位）——
  // 店主能亲眼看到图钉是否落在自家店门口再确认，比盲取 GPS 更可靠，也是当前唯一已
  // 申请到接口权限的方式（getLocation 未申请，见 docs/miniapp-release-checklist.md）。
  // 取消（cancel）静默返回；拒绝授权才引导去设置，两者 errMsg 不同，不能混着处理。
  onSetStoreLocation() {
    var token = this._token()
    if (!token) { this._backToLogin(); return }
    if (this.data.locating) return
    var self = this
    this.setData({ locating: true })
    wx.chooseLocation({
      success(loc) {
        var label = loc.name || loc.address || (loc.latitude + ',' + loc.longitude)
        wx.showModal({
          title: '确认门店位置',
          content: '将保存为门店坐标：\n' + label + '\n\n请确认地图上的图钉落在本店门口。',
          // 缺 fail 的话，弹窗调起失败时 locating 会永远停在 true，按钮此后一直禁用
          fail() { self.setData({ locating: false }) },
          success(m) {
            if (!m.confirm) { self.setData({ locating: false }); return }
            wx.request({
              url: baseURL + '/admin/settings/local-delivery/store-location',
              method: 'PATCH',
              header: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
              data: { latE6: Math.round(loc.latitude * 1e6), lngE6: Math.round(loc.longitude * 1e6) },
              success(res) {
                var body = res.data
                if (body && body.code === 0) {
                  // 门店坐标是报价凭证的签名字段之一（服务端 signQuote 的 sla/sln）：一改，所有在途
                  // 报价立刻作废，正在结算页的顾客提交时会收到「配送费已更新，请刷新后重新提交」。
                  // 别只说「已保存」——店主得知道这一下会打断正在下单的人，才不会在高峰期随手点它。
                  wx.showModal({
                    title: '门店坐标已保存',
                    content: '配送距离与运费都按新坐标重新计算。正在结算页的顾客需要刷新后重新报价。',
                    showCancel: false,
                  })
                } else if (res.statusCode === 401 || (body && (body.code === 40101 || body.code === 40102))) {
                  self._backToLogin()
                } else {
                  wx.showToast({ title: (body && body.message) || '保存失败', icon: 'none' })
                }
              },
              fail() { wx.showToast({ title: '网络错误，请重试', icon: 'none' }) },
              complete() { self.setData({ locating: false }) },
            })
          },
        })
      },
      fail(err) {
        self.setData({ locating: false })
        var msg = (err && err.errMsg) || ''
        if (msg.indexOf('cancel') !== -1) return
        if (msg.indexOf('auth deny') !== -1 || msg.indexOf('auth denied') !== -1 || msg.indexOf('authorize') !== -1) {
          wx.showModal({
            title: '需要位置权限',
            content: '设置门店位置需要使用地图，请在设置中允许「位置信息」后重试',
            confirmText: '去设置',
            success(r) { if (r.confirm) wx.openSetting() },
          })
          return
        }
        wx.showToast({ title: '地图打开失败，请稍后重试', icon: 'none' })
      },
    })
  },

  onLogout() {
    var self = this
    wx.showModal({
      title: '退出商家登录',
      content: '确认退出商家管理？',
      success(res) {
        if (res.confirm) self._backToLogin()
      },
    })
  },
})
