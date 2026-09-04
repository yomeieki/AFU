// 封面分流页（pages[0]，非 tabBar）。顾客冷启动看到它，选完渠道就进业务页。
//
// 为什么不能直接用 <image mode="aspectFill"> + 页面百分比定位热区：
// aspectFill 按 s = max(W/375, H/812) 缩放后居中裁剪，屏幕坐标 = s·设计坐标 + 偏移；
// 而 `left: 55%` 是页面宽高的百分比，没有那个偏移项，误差恰好等于裁剪量
// （iPhone SE 上纵向裁 ±62pt，热区就偏 62pt）。
// 所以这里改成：算一个「含被裁部分的完整缩放尺寸」的舞台，居中溢出到视口外，
// 热区放在舞台内用百分比——舞台比例恒为 750:1624，百分比与设计坐标 1:1 对应。

var DESIGN_W = 750
var DESIGN_H = 1624

// 可点带（设计坐标，已含 24px 余量）：最上是主按钮 y=902，最下是横幅底 y=1299；
// 横向最左主按钮 x=69，最右 x=703。极端比例下用它把可点区钳回视口内。
var BAND_TOP = 878
var BAND_BOTTOM = 1323
var BAND_LEFT = 45
var BAND_RIGHT = 727

var app = getApp()

Page({
  data: {
    stageStyle: '',
    // 开发期置 true 可显示热区虚线框，核对是否压在画上的按钮上。
    // 2026-09-05 PO 已在开发者工具核对通过，改回 false。
    debug: false,
  },

  onLoad: function () {
    this.layout()
  },

  // 折叠屏展开、iPad 分屏会触发；普通手机上不会调用，留着无副作用
  onResize: function () {
    this.layout()
  },

  layout: function () {
    var info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
    var W = info.windowWidth
    var H = info.windowHeight

    // 舞台 = 铺满视口所需的完整尺寸（等价于 aspectFill 缩放后的图，含被裁部分）
    var stageW = Math.max(W, (H * DESIGN_W) / DESIGN_H)
    var stageH = Math.max(H, (W * DESIGN_H) / DESIGN_W)
    var left = (W - stageW) / 2
    var top = (H - stageH) / 2

    // 纯居中在 H/W < 1.30 时会切掉冷链横幅、> 2.48 时会切掉按钮右缘。
    // 现役手机（1.78–2.33）上下面两句都是 no-op；平板/折叠屏上改为平移而不是切掉。
    top = Math.min(Math.max(top, -(BAND_TOP / DESIGN_H) * stageH), H - (BAND_BOTTOM / DESIGN_H) * stageH)
    left = Math.min(Math.max(left, -(BAND_LEFT / DESIGN_W) * stageW), W - (BAND_RIGHT / DESIGN_W) * stageW)

    this.setData({
      stageStyle:
        'left:' + left + 'px;top:' + top + 'px;width:' + stageW + 'px;height:' + stageH + 'px',
    })
  },

  goLocal: function () {
    // 与购物车/商品详情/「我的」同一套契约：先过位置许可再进，
    // 避免顾客进到地图选点那一步才被拦。
    app
      .ensurePrivacyAuthorize()
      .then(function () {
        wx.navigateTo({ url: '/pages/local/index' })
      })
      .catch(function () {
        wx.showToast({ title: '需要同意位置许可才能使用同城配送', icon: 'none' })
      })
  },

  // pages/index/index 是 tabBar[0]，只能 switchTab；switchTab 会销毁本页，
  // 顾客之后要换回同城走「我的 → 同城配送」那个常驻入口。
  goExpress: function () {
    wx.switchTab({ url: '/pages/index/index' })
  },

  // TODO(会员 M4)：三个页面做出来后把 toast 换成 navigateTo：
  //   member → /pages/member/index   coupon → /pages/member/coupons   points → /pages/member/mall
  // 提审前必须换完——「点了只弹 toast」是审核判「功能不完整」的典型模式。
  goMember: function () {
    wx.showToast({ title: '即将开通', icon: 'none' })
  },

  // 图是打进包里的本地资源，正常不会触发；真触发了说明路径写错，
  // 而 pages[0] 变成一整屏空白纸底是最糟的失败形态，必须让它在控制台可见。
  onImgError: function (e) {
    console.error('[cover] 封面图加载失败，检查 /assets/cover/cover.png', e && e.detail)
  },
})
