// 主页（tabBar[0]）。同城与邮寄共用这一个页面，靠 app.globalData.shoppingChannel 决定
// 加载哪边的内容——微信原生 tabBar 的 pagePath 是写死的，不可能给两个渠道各配四个页面。
//
// 两边的骨架相同（顶栏 → 一块头部 → 分类 → 商品网格），差别只在：
//   EXPRESS：轮播 Banner + 推荐商品，点进商品详情
//   LOCAL  ：门店头（营业状态/配送规则/阻塞通知）+ 今日推荐 + 底部购物车条
//
// 同城下商品卡带「+」快速加购，整条流程（拉详情 → 弹规格 → 加购 → 提示）
// 在 components/local-sku-picker 里，与分类页共用同一份。

const { request } = require('../../utils/request')
const { formatPrice } = require('../../utils/format')
const catalogApi = require('../../api/catalog')
const { getLocalMeta } = require('../../api/local')
const { headNoticeOf, resolveLocalMode } = require('../../utils/local-catalog')
var promoTypeOf = require('../../utils/promo').promoTypeOf
var share = require('../../utils/share')
const app = getApp()

Page({
  onShareAppMessage: share.onShareAppMessage,
  data: {
    cartSpacerPx: 0,
    promotion: null,
    promoType: 'EXPRESS',
    // 自绘导航栏尺寸，onLoad 时按胶囊按钮实测值算出（见 computeNavBar）
    statusBarHeight: 0,
    navContent: 44,
    navTotal: 88,
    channel: 'EXPRESS',
    channelLabel: '全国邮寄',
    channelRight: 0,
    channelSheetOpen: false,
    // 微信「单页模式」（朋友圈内打开分享卡片）：本页只浏览，隐私门/登录/加购全部
    // 关闭，见 onLoad 与 utils/share.js 头注释。
    singlePage: false,
    // LOCAL 专用
    meta: null,
    mode: 'DELIVERY',
    headBlocking: false,
    // 两个渠道共用
    banners: [],
    categories: [],
    products: [],
    loading: true,
  },

  onCartHeight: function(e) {
    var px = e.detail.px || 0
    if (px !== this.data.cartSpacerPx) {
      this.setData({ cartSpacerPx: px })
    }
  },

  // options 里可能带着分享落地的渠道参数——旧版分享卡片（调整前发出去的）指向
  // /pages/index/index?channel=X，这段解析逻辑仍要保留给这些旧链接用；新版
  // 「转发给好友」卡片已经改落封面（不带 channel），朋友圈（utils/share.js 的
  // homeTimeline）仍然落主页并带 channel，二者都可能带着这个参数走到这里。
  //   null    ：普通进入（tabBar 切换/冷启动），按现有渠道加载，不碰渠道；
  //   EXPRESS ：分享带的是邮寄——邮寄不需要位置许可，直接定渠道后照常加载；
  //   LOCAL   ：分享带的是同城——同城要先过位置许可这道门（gateLocalChannel），
  //             但门是异步的、还会弹隐私授权弹层，而隐私授权弹层是 app.js 的
  //             onNeedPrivacyAuthorization 通过 getCurrentPages() 取末页
  //             selectComponent('#privacy-popup') 找到的（app.js:56-61）——
  //             onLoad 这一刻本页刚开始渲染，取不到自己的弹层组件，找不到会静默
  //             disagree。所以这里只记一个「待开门」标记，等 onReady（首屏已渲染完）
  //             再开门；这段时间内既不 loadData，也不改 channel 数据以外的东西，
  //             避免顾客在门开着的时候看到一屏错渠道的骨架。
  //
  // rememberEntry 必须在判断 target 之前调用、且不管 target 是不是 null 都要调——
  // 它登记的是「这次 onLoad 见过的入口」，热启动时 wx.onAppShow 可能会把同一个
  // 入口（比如这次冷启动本身）又送一遍，要靠它去重（见 utils/share.js 头注释 R1）。
  onLoad(options) {
    // 单页模式下不弹隐私门（只浏览，位置许可放到进普通模式后再问，见
    // gateThenLoad 顶部短路与 utils/share.js 头注释）。
    this.setData({ singlePage: !!app.globalData.singlePage })
    this.computeNavBar()
    share.rememberEntry('pages/index/index', options)
    var self = this
    if (wx.onAppShow) {
      // 主页是 tabBar 页，热启动大概率不会重新执行 onLoad——分享/扫码带来的入口
      // 参数只保证经 App.onShow / wx.onAppShow 送达，所以在这里另外接一路监听，
      // 收到的参数只记下来（_pendingEntryChannel），真正的动作留给 onShow 做，
      // 理由与「隐私弹层要等首屏渲染完」一致：onAppShow 触发的时机不保证在
      // onShow 之前的哪一步，本页当前状态未必已经稳定到能立刻动手。
      this._onAppShow = function(opts) {
        var ch = share.noteEntry(opts && opts.path, opts && opts.query)
        if (ch) self._pendingEntryChannel = ch
      }
      wx.onAppShow(this._onAppShow)
    }
    var target = share.channelFromQuery(options)
    if (target === 'LOCAL') {
      this._shareGate = true
      this.setData({ channel: 'LOCAL', channelLabel: '同城配送' })
      return
    }
    if (target === 'EXPRESS') {
      app.setShoppingChannel('EXPRESS')
    }
    this.loadData()
  },

  // 页面卸载前解绑 App 级监听——tabBar 页正常不会被销毁，但测试环境、
  // 分包/异常重建等场景下 onUnload 仍可能触发；不解绑会让旧实例的监听器一直
  // 挂在 App 上，收到事件时操作的是一个已经不在页面栈里的 this。
  onUnload() {
    if (this._onAppShow && wx.offAppShow) wx.offAppShow(this._onAppShow)
    this._onAppShow = null
  },

  // 只有 onLoad 里立了「待开门」标记（分享链接带来的 LOCAL）才会做事；
  // 普通进入、以及分享带 EXPRESS/无参数的情形，onLoad 已经在处理 loadData，这里直接跳过。
  onReady() {
    if (this._shareGate) this.gateThenLoad()
  },

  // 同城之门 + 加载，合并成一步：冷启动分享落地（onReady 调）与热启动分享落地
  // （onShow 里 applyEntryChannel 调）共用这同一段逻辑，避免两处各写一遍「过门
  // 失败/拒绝都要落回邮寄」的收尾。
  gateThenLoad() {
    var self = this
    // 单页模式：不问位置许可（wx.requirePrivacyAuthorize 在单页模式下不可信，
    // 且这里本来就只是浏览），直接按 LOCAL 落地——冷启动（onReady）与热启动
    // （applyEntryChannel）共用这一个出口，见 utils/share.js 头注释。
    if (app.globalData.singlePage) {
      this._shareGate = false
      this._pendingEntryChannel = null
      app.setShoppingChannel('LOCAL')
      this.loadData()
      return
    }
    this._shareGate = true
    function settle(ok) {
      self._shareGate = false
      // 门未决期间（_shareGate 为 true）到达的入口由这里统一收口，不留给 onShow
      // 处理——onShow 的 _shareGate 短路会让 _pendingEntryChannel 一直没被消费，
      // 直到某次跟这次入口完全无关的 onShow 才被拿出来执行，那时候渠道会被
      // 静默切走，顾客完全对不上因果（复核 R4：门开着时又来一次 EXPRESS 入口，
      // 门开完之后一次无关的 onShow 才把渠道切成 EXPRESS）。
      var ch = self._pendingEntryChannel
      self._pendingEntryChannel = null
      // 以「拒绝/失败」与「门未决期间的最后一次入口是 EXPRESS」两种情形为准落到邮寄：
      // 前者是原有语义；后者是「门开着时顾客又点了一张邮寄卡片」，以最后一次入口
      // 为准。ch === 'LOCAL' 时忽略——门刚问过同一个问题，不再弹一次授权。
      if (ok !== true || ch === 'EXPRESS') app.setShoppingChannel('EXPRESS')
      self.loadData()
    }
    app.gateLocalChannel().then(settle, settle)
  },

  // 让自绘导航栏与原生完全对齐：胶囊按钮的位置就是微信自己的排版基准，按它反推——
  // 内容区高度 = (胶囊上边距 − 状态栏高) × 2 + 胶囊高，胶囊在其中垂直居中，
  // 返回箭头也就落在与同城页原生箭头相同的中线上。
  // 取不到胶囊信息时退回 44px 常量，不至于把导航栏画塌。
  computeNavBar() {
    var info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
    var statusBarHeight = info.statusBarHeight || 20
    var navContent = 44
    var menu = null
    if (wx.getMenuButtonBoundingClientRect) {
      menu = wx.getMenuButtonBoundingClientRect()
      if (menu && menu.height && menu.top >= statusBarHeight) {
        navContent = (menu.top - statusBarHeight) * 2 + menu.height
      }
    }
    // 渠道标识（现在只有邮寄渠道会渲染，见 index.wxml 的 wx:if）的右边距：胶囊左沿再往左 10px；
    // 桩/低版本库拿不到 left 时这里算出 0，交给 wxss 的 115px 兜底（不写 style）。
    // 同城不渲染这颗标识，但 computeNavBar 在 onLoad 就跑、loadData 还没定下渠道，无从短路，
    // 算出来的值对同城只是空转，不是遗留死代码。
    var channelRight = 0
    if (menu && menu.left > 0 && menu.left < info.windowWidth) channelRight = info.windowWidth - menu.left + 10
    this.setData({
      statusBarHeight: statusBarHeight,
      navContent: navContent,
      navTotal: statusBarHeight + navContent,
      channelRight: channelRight,
    })
  },

  onBannerTap(e) {
    var banner = e.currentTarget.dataset.banner
    if (banner && banner.linkType === 'product' && banner.productId) {
      wx.navigateTo({ url: '/pages/product/detail?id=' + banner.productId })
    }
  },

  // 每次切到本 tab 都会触发。三件事：
  //   ① 补写购物车角标——onLaunch 那次写在非 tabBar 的封面页上会被跳过；
  //   ② 渠道变了就整页重来（顾客刚从封面换了渠道）；
  //   ③ 同城下：刷 meta 与购物车条——店主可能中途按了「暂停接单」，
  //      顾客从结算页返回时也要看到最新的车。
  onShow() {
    app.applyCartBadge()
    // 分享落地的门还没开（onLoad 设了 _shareGate，onReady/gateThenLoad 还没
    // settle）：渠道此刻是临时摆着的 LOCAL，跟真实的 app.getShoppingChannel()
    // 未必一致，下面「渠道变了就整页重来」会误判成要重新加载，把在途的那次
    // 加载也带出一次多余的闪烁。
    if (this._shareGate) return
    // 热启动带来的入口渠道（wx.onAppShow 记的，见 onLoad）：消费一次就清掉，
    // 避免下一次单纯切 tab 触发的 onShow 又把它当一次新的分享落地重放。
    var ch = this._pendingEntryChannel
    if (ch) {
      this._pendingEntryChannel = null
      this.applyEntryChannel(ch)
      return
    }
    if (app.getShoppingChannel() !== this.data.channel) {
      this.loadData()
      return
    }
    if (this.data.channel === 'LOCAL') {
      if (app.getLocalMode() !== this.data.mode) this.applyMode(app.getLocalMode())
    }
    this.loadMeta()
    this.refreshCartBar()
  },

  // 热启动分享落地的动作（冷启动那一支在 onLoad/onReady 里，见上）。
  // 不预先清空内容、不预设 channel: 'LOCAL'——本页此刻已经在正常展示中，
  // 直接按目标渠道走一次完整的 loadData/gateThenLoad 收尾即可。
  applyEntryChannel(ch) {
    if (ch === 'LOCAL') {
      this.gateThenLoad()
      return
    }
    app.setShoppingChannel('EXPRESS')
    this.loadData()
  },

  onPullDownRefresh() {
    this.loadData()
  },

  // 朋友圈只在主页保留（其余 24 页不挂 onShareTimeline，见 utils/share.js 头注释）。
  onShareTimeline() {
    return share.homeTimeline(app.getShoppingChannel())
  },

  loadData() {
    var channel = app.getShoppingChannel()
    // 先把上一个渠道的内容清空再拉。不清的话，切渠道后新数据回来之前，
    // 顾客会盯着一屏**另一个渠道的商品**看半秒——那半秒里他完全可能点进去。
    this.setData({
      channel: channel,
      channelLabel: channel === 'LOCAL' ? '同城配送' : '全国邮寄',
      loading: true,
      banners: [],
      categories: [],
      products: [],
      meta: channel === 'LOCAL' ? this.data.meta : null,
      mode: channel === 'LOCAL' ? app.getLocalMode() : 'DELIVERY',
      promoType: promoTypeOf(channel, app.getLocalMode()),
      headBlocking: false,
      promotion: null,
    })
    return channel === 'LOCAL' ? this.loadLocal() : this.loadExpress()
  },

  loadExpress() {
    var self = this
    return Promise.all([
      catalogApi.getCategories('EXPRESS'),
      catalogApi.getProducts({ channel: 'EXPRESS', page: 1, pageSize: 6 }),
      request({ url: '/banners' }).catch(function() { return [] }),
      getLocalMeta().catch(function() { return null }),
    ])
      .then(function(r) {
        if (self.data.channel !== 'EXPRESS') return
        self.setData({
          banners: r[2] || [],
          categories: r[0] || [],
          products: self.decorate(r[1]),
          promotion: r[3] ? r[3].promotion : null,
          loading: false,
        })
        self.refreshCartBar()
        wx.stopPullDownRefresh()
      })
      .catch(() => {
        // 断网/接口失败：必须收起骨架屏，否则主页永远停在加载态。
        // 这里必须是箭头函数：写成 function 的话 this 是 undefined，setData 抛错被
        // Promise 吞掉，骨架屏反而永远收不起来——正是本行注释要防的事。
        this.setData({ loading: false })
        wx.stopPullDownRefresh()
      })
  },

  loadLocal() {
    // meta 单独一条 Promise 且允许失败：门店信息拿不到时，菜单本身仍应该看得见。
    return Promise.all([
      catalogApi.getCategories('LOCAL'),
      catalogApi.getProducts({ channel: 'LOCAL', page: 1, pageSize: 6 }),
      getLocalMeta().catch(function() { return null }),
    ])
      .then(([categories, productData, meta]) => {
        // 外送关了、自取开着（或反过来）时自动落到开着的那一侧；两边都开尊重顾客上次的选择
        var mode = app.setLocalMode(resolveLocalMode(meta, app.getLocalMode()))
        this.setData({
          categories: categories || [],
          products: this.decorate(productData),
          meta: meta,
          promotion: meta && meta.promotion,
          mode: mode,
          promoType: promoTypeOf('LOCAL', mode),
          headBlocking: headNoticeOf(meta, mode).blocking,
          loading: false,
        })
        this.refreshCartBar()
        wx.stopPullDownRefresh()
      })
      .catch(() => {
        this.setData({ loading: false })
        wx.stopPullDownRefresh()
      })
  },

  decorate(productData) {
    return ((productData && productData.list) || []).map(function(p) {
      return Object.assign({}, p, { priceText: formatPrice(p.price) })
    })
  },

  // 模式回落只在进同城（loadLocal）那一次做；onShow 触发的刷新不改顾客已经选定的模式
  loadMeta() {
    var self = this
    var channel = this.data.channel
    getLocalMeta()
      .then(function(meta) {
        if (channel !== self.data.channel) return
        if (channel === 'EXPRESS') {
          self.setData({ promotion: meta.promotion })
          return
        }
        var mode = app.getLocalMode()
        self.setData({ meta: meta, promotion: meta.promotion, mode: mode, promoType: promoTypeOf('LOCAL', mode), headBlocking: headNoticeOf(meta, mode).blocking })
      })
      .catch(function() {
        // 保留上一次的 meta：拉不到店铺状态时，把营业中的店显示成打烊比不刷新更糟
      })
  },

  refreshCartBar() {
    var bar = this.selectComponent('#local-cart-bar')
    if (bar) bar.refresh()
  },

  // 购物车条报告车变了 → 刷新当前渠道的 tabBar 角标
  onCartChange() {
    app.updateCartCount()
  },

  // 子模式变了：阻塞态按新模式重算，购物车条的按钮跟着变（去向与起送线都不一样）
  applyMode(mode) {
    this.setData({ mode: mode, promoType: promoTypeOf(this.data.channel, mode), headBlocking: headNoticeOf(this.data.meta, mode).blocking })
    this.refreshCartBar()
  },
  onModeChange(e) {
    this.applyMode(app.setLocalMode(e.detail.mode))
  },
  // 页头通知里的「改用自取 / 改用外送」
  onSwitchMode(e) {
    this.applyMode(app.setLocalMode(e.detail.mode))
  },

  // 同城被暂停/打烊时，页头那条通知里的「去全国邮寄」。
  // 不跳页——本页就是共享主页，换渠道重新加载即可，比 switchTab 到自己更直观。
  onGoExpress() {
    app.setShoppingChannel('EXPRESS')
    this.loadData()
  },

  // ── 渠道标识与切换弹层（门店头右端，与分类页共用同一个 channel-sheet 组件）────────
  // 选中即切渠道并重新拉本页数据（不跳页）。去同城走 app.gateLocalChannel()（位置许可 → 定渠道），
  // 本页不自己问许可；去邮寄与 onGoExpress 同一条路。
  openChannelSheet() {
    this.setData({ channelSheetOpen: true })
  },
  closeChannelSheet() {
    this.setData({ channelSheetOpen: false })
  },
  noop() {},
  onPickChannel(e) {
    var target = e.detail && e.detail.channel
    this.closeChannelSheet()
    if (!target || target === this.data.channel) return
    if (target === 'EXPRESS') { this.onGoExpress(); return }
    var self = this
    app.gateLocalChannel().then(function(ok) { if (ok) self.loadData() })
  },

  // Navigate to product list filtered by categoryId.
  // pages/product/list is a tabBar page — must use switchTab,
  // which doesn't support query params, so we pass via globalData.
  goToList(e) {
    const id = e.currentTarget.dataset.id
    const name = e.currentTarget.dataset.name
    app.globalData.pendingCategoryId = id
    app.globalData.pendingCategoryName = name
    wx.switchTab({ url: '/pages/product/list' })
  },

  // 回封面重选渠道。reLaunch 会清空页面栈，正好符合「封面是起点」的语义；
  // navigateTo 会把封面叠在本页之上，返回时又掉回来，反而绕不出去。
  goCover() {
    wx.reLaunch({ url: '/pages/cover/index' })
  },

  goToAllProducts() {
    app.globalData.pendingCategoryId = null
    app.globalData.pendingCategoryName = null
    app.globalData.pendingCategoryAll = true
    wx.switchTab({ url: '/pages/product/list' })
  },

  goToDetail(e) {
    const id = e.currentTarget.dataset.id
    wx.navigateTo({ url: '/pages/product/detail?id=' + id })
  },

  // 同城「+」。列表项即可，规格由 local-sku-picker 自己去拉。
  onAddToCart(e) {
    // 单页模式只浏览：POST /cart 会因为没有登录态而必然失败（见 utils/request.js），
    // 且加购弹层本身在单页模式也不该出现，见 index.wxml 的 add-btn wx:if。
    if (this.data.singlePage) return
    const id = e.currentTarget.dataset.id
    var product = null
    for (var i = 0; i < this.data.products.length; i++) {
      if (this.data.products[i].id === id) { product = this.data.products[i]; break }
    }
    var picker = this.selectComponent('#local-sku-picker')
    if (product && picker) picker.open(product)
  },

  // 加购成功（含「加错了渠道」那一支）：刷购物车条与角标
  onAdded() {
    this.refreshCartBar()
    app.updateCartCount()
  },
})
