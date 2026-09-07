// 封面分流页（pages[0]，非 tabBar）。顾客冷启动看到它，选完渠道就进业务页。
//
// 2026-09-07 从「亭子版整屏位图 + 透明热区」换成方案 C 青瓦简约版的三层结构：
// 背景层 + Logo 图片层 + 原生交互层。旧版把按钮画进位图里，换背景就得重切热区；
// 现在换背景只动 assets/cover 里的图，热区与路由不受影响。
//
// 版式基准 750 × 1333（旧版是 750 × 1624）。热区与跳转契约见 config/cover-entries.js。

var ENTRIES = require('../../config/cover-entries.js')

var DESIGN_W = 750           // 设计画板宽
var BG_W = 941               // 背景原图尺寸
var BG_H = 1672
var WALL_START_ROW = 1216    // 实测：这一行以上全是宣纸底纹，青瓦线稿从这里开始
var BG_H_RPX = (DESIGN_W * BG_H) / BG_W                      // 背景按宽铺满后的高 ≈ 1332.6rpx
var WALL_TOP_IN_BG_RPX = (BG_H_RPX * WALL_START_ROW) / BG_H  // 青瓦顶边距图顶 ≈ 969.5rpx

var CONTENT_TOP = 135        // Logo 顶边
var CONTENT_BOTTOM = 964     // 冷链热区底边
var CLEARANCE = 24           // 内容与青瓦之间至少留出的间距
var MIN_SCALE = 0.86
var CAPSULE_GAP = 8          // 胶囊按钮下方额外留白（px）

var app = getApp()

Page({
  data: {
    entries: ENTRIES,
    stageOffset: 0,
    stageScale: 1,
  },

  onLoad: function () {
    this.layout()
  },

  // 折叠屏展开、iPad 分屏会触发；普通手机上不会调用，留着无副作用
  onResize: function () {
    this.layout()
  },

  // 版式只有两个自由度，都作用在 .cover-stage 上，六个热区随之一起变换，
  // 不会出现「视觉动了热区没动」：
  //   stageOffset —— 整体下移，让开微信胶囊按钮，保证 Logo 不被遮挡；
  //   stageScale  —— 只有极短屏（如 iPhone SE）内容仍会压到青瓦时才启用的等比兜底。
  layout: function () {
    var info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
    var rpx = DESIGN_W / info.windowWidth       // 1px = rpx 个 rpx
    var screenH = info.windowHeight * rpx
    var wallTop = screenH - BG_H_RPX + WALL_TOP_IN_BG_RPX

    var capsuleBottom
    try {
      capsuleBottom = (wx.getMenuButtonBoundingClientRect().bottom + CAPSULE_GAP) * rpx
    } catch (err) {
      // 低版本基础库拿不到胶囊位置时，按状态栏 + 44px 导航条估算
      capsuleBottom = ((info.statusBarHeight || 20) + 44 + CAPSULE_GAP) * rpx
    }

    var maxOffset = Math.max(0, wallTop - CLEARANCE - CONTENT_BOTTOM)
    var stageOffset = Math.min(Math.max(0, capsuleBottom - CONTENT_TOP), maxOffset)

    var stageScale = 1
    var room = wallTop - CLEARANCE - (CONTENT_TOP + stageOffset)
    var needed = CONTENT_BOTTOM - CONTENT_TOP
    if (room < needed) {
      stageScale = Math.max(MIN_SCALE, room / needed)
    }

    this.setData({
      stageOffset: Math.round(stageOffset * 100) / 100,
      stageScale: Math.round(stageScale * 10000) / 10000,
    })
  },

  // 六个入口共用。跳转方式按 config 里的 action 分流。
  //
  // 这里**不做登录判断**：本页是 pages[0]，冷启动时 app._tryLogin() 可能还没回来，
  // 在这儿判会把已登录的人误判成未登录。会员三页各自有登录门。
  onTapEntry: function (e) {
    var id = e.currentTarget.dataset.id
    var entry = null
    for (var i = 0; i < ENTRIES.length; i++) {
      if (ENTRIES[i].id === id) { entry = ENTRIES[i]; break }
    }
    if (!entry) {
      // 只可能是 wxml 的 data-id 写错/漏写，属于开发期错误，别静默吞掉
      console.error('[cover] 未知的热区 data-id：', id)
      return
    }

    this.track(entry.event, entry.id)

    if (entry.action === 'local') {
      // 与购物车/商品详情/「我的」同一套契约：先过位置许可再进，
      // 避免顾客进到地图选点那一步才被拦。
      var route = entry.route
      var self = this
      app
        .ensurePrivacyAuthorize()
        .then(function () {
          wx.navigateTo({ url: route, fail: function (err) { self.onNavFail(entry, err) } })
        })
        .catch(function () {
          wx.showToast({ title: '需要同意位置许可才能使用同城配送', icon: 'none' })
        })
      return
    }

    // pages/index/index 是 tabBar[0]，只能 switchTab；switchTab 会销毁本页，
    // 顾客之后要换回同城走「我的 → 同城配送」那个常驻入口。
    var open = entry.action === 'switchTab' ? wx.switchTab : wx.navigateTo
    var that = this
    open({
      url: entry.route,
      fail: function (err) { that.onNavFail(entry, err) },
    })
  },

  // 旧版跳转失败是静默的。热区压在位图上，顾客点了没反应会以为是自己没点准，
  // 所以这里必须给可见反馈 + 控制台线索。
  onNavFail: function (entry, err) {
    console.error('[cover] 跳转失败', entry.id, entry.route, err)
    wx.showToast({ title: '页面暂时打不开，请稍后再试', icon: 'none' })
  },

  // 「我的订单」：navigateTo 而不是 switchTab —— 订单列表不是 tabBar 页，
  // 而且 switchTab 会把封面页栈销毁掉。
  // 同样不做登录判断，理由见 onTapEntry。
  goOrders: function () {
    wx.navigateTo({ url: '/pages/order/list' })
  },

  // 埋点出口。本仓库目前没有统一埋点层，先收敛成这一个函数：
  // 平台定了（wx.reportEvent 或自建后端）只改这里，不用回头翻页面代码。
  // 事件名沿用设计交付包的约定，见 config/cover-entries.js。
  track: function (event, id) {
    console.log('[track]', event, { id: id, page: 'cover', ts: Date.now() })
  },

  // 图是打进包里的本地资源，正常不会触发；真触发了说明路径写错，
  // 而 pages[0] 变成一整屏空白纸底是最糟的失败形态，必须让它在控制台可见。
  onImgError: function (e) {
    console.error('[cover] 封面素材加载失败，检查 /assets/cover/', e && e.detail)
  },
})
