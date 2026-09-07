// 同城配送的**兼容跳转页**。
//
// 双渠道改版之前，这个页面自己是一份完整的同城菜单（左分类 / 右商品 / 底部购物车条）。
// 改版后同城与邮寄共用「主页 / 分类 / 购物车 / 我的」四个 tabBar 页，菜单搬去了那边，
// 这里只剩一件事：把渠道切成 LOCAL，然后转到共享主页。
//
// 为什么不直接从 app.json 里删掉这个页面：
//   ① 顾客手机里可能还压着旧版本的页面栈；
//   ② 分享卡片、商品小程序码、外部链接都可能指向 /pages/local/index。
// 删了就是白屏，比多转一次糟糕得多。
//
// 这里**不问位置许可**（与封面等主动入口不同）：许可是为了「别让顾客填完一路才被拦」，
// 而菜单本身不需要定位，真正需要的是结算页选地址那一步，那里自己会问。
// 旧链接进来的顾客只是想看菜单，先弹一个许可框反而突兀。
//
// 旧版菜单逻辑（headNoticeOf / 分类分页 / SKU 弹层 / 购物车条）见本提交的父提交：
//   git show aef94f1:apps/miniapp/pages/local/index.js
// Task 5 把它搬进 pages/index 与 pages/product/list 时以那份为准。

var app = getApp()

Page({
  data: {
    // 只有 switchTab 失败时才显示——正常情况下这一屏一闪而过。
    failed: false,
  },

  onLoad: function() {
    this.go()
  },

  go: function() {
    var self = this
    app.setShoppingChannel('LOCAL')
    self.setData({ failed: false })
    wx.switchTab({
      url: '/pages/index/index',
      fail: function(err) {
        // 静默失败就是一片空白，顾客不知道发生了什么，也没有下一步可走。
        console.error('[local] 转共享主页失败', err)
        self.setData({ failed: true })
      },
    })
  },
})
