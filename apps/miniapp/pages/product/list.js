// 分类页（tabBar[1]）。同城与邮寄共用左分类 / 右商品这一套骨架，差别只有两处：
//   EXPRESS：顶部搜索框；点商品进详情页
//   LOCAL  ：顶部完整门店头（与主页一致）；点圆形「+」直接加购 + 底部购物车条
//
// 2026-09-17 起改成左右联动（分组锚点）：右侧不再翻页，一次拉全本渠道的菜、按分类
// 分段展示；左侧点分类滚到该段，右侧滚动时左侧高亮跟随；不再有「全部」项。
// 搜索（仅邮寄）保留，右侧切成平铺结果 + 翻页，与分组视图互不干扰。
//
// 加购流程与主页共用 components/local-sku-picker，本页只负责找到那件商品并把它交出去。

const { formatPrice, formatStock } = require('../../utils/format')
const catalogApi = require('../../api/catalog')
const { getLocalMeta } = require('../../api/local')
const { headNoticeOf, resolveLocalMode } = require('../../utils/local-catalog')
var catalogGroups = require('../../utils/catalog-groups')
const app = getApp()

Page({
  data: {
    channel: 'EXPRESS',
    // 同城专用
    meta: null,
    mode: 'DELIVERY',
    headBlocking: false,
    // 搜索（仅邮寄，非空 = 搜索模式，右侧展示跨分类平铺结果）
    keyword: '',          // 输入框实时值
    searchKeyword: '',    // 已确认的搜索词
    // 搜索结果分页（分组视图下不使用）
    list: [],
    page: 1,
    pageSize: 20,
    total: 0,
    hasMore: true,
    loading: false,
    // 右侧 scroll-view 回顶用（值变化才生效，故在 0 / 0.5 间交替）
    rightScrollTop: 0,
    // 分组视图
    groups: [],            // [{ id, name, items }]，左侧与右侧分段都渲染它
    activeGroupId: null,   // 当前高亮段；搜索模式下 wxml 不画高亮
    activeGroupName: '',   // 右侧顶部浮动条文字
    scrollIntoView: '',    // 'g-<id>'，点左侧时设置
    tailHeight: 0,         // 最后一段之后的补白（px），量出来的
    catalogLoading: false, // 分组视图拉全量中 → 骨架屏
    channelSheetOpen: false, // 渠道切换弹层（两侧标识共用）
  },

  onLoad() {
    this.reloadForChannel()
  },

  // 每次切到本 tab 都会触发。渠道变了就整页重来；否则只消费主页传来的分类意图。
  onShow() {
    if (app.getShoppingChannel() !== this.data.channel) {
      this.reloadForChannel()
      return
    }
    if (this.data.channel === 'LOCAL') {
      if (app.getLocalMode() !== this.data.mode) this.applyMode(app.getLocalMode())
      this.loadMeta()
      this.refreshCartBar()
    }
    var g = app.globalData
    if (g.pendingCategoryAll === true) {
      g.pendingCategoryAll = false
      g.pendingCategoryId = null
      g.pendingCategoryName = null
      if (this.data.searchKeyword) {
        this.clearSearch()
      } else {
        this.setData({ scrollIntoView: '' })
        this.resetRightScroll()
      }
      if (this.data.groups.length) this.setActiveGroup(this.data.groups[0].id)
      else this._pendingLocateId = null
      return
    }
    if (g.pendingCategoryId != null) {
      var id = g.pendingCategoryId
      g.pendingCategoryId = null
      g.pendingCategoryName = null
      this.locateGroup(id)
    }
  },

  // 切渠道时把分组、商品、搜索词、分页全部归零。
  // 不归零的话，新渠道的第一屏会先闪出上一个渠道的商品；activeGroupId 也可能
  // 指向一个当前渠道根本没有的分类，右侧会一直空着且看不出原因。
  reloadForChannel() {
    var channel = app.getShoppingChannel()
    this.setData({
      channel: channel,
      groups: [],
      activeGroupId: null,
      activeGroupName: '',
      scrollIntoView: '',
      tailHeight: 0,
      catalogLoading: true,
      keyword: '',
      searchKeyword: '',
      list: [],
      page: 1,
      total: 0,
      hasMore: true,
      meta: channel === 'LOCAL' ? this.data.meta : null,
      mode: channel === 'LOCAL' ? app.getLocalMode() : 'DELIVERY',
      headBlocking: false,
    })
    this._products = []
    this._offsets = []
    this.resetRightScroll()
    this.loadCatalog()
    // 进分类页这一次要做模式回落；onShow 里的刷新（loadMeta() 不传参）不改顾客已选的模式
    if (channel === 'LOCAL') this.loadMeta(true)
  },

  // resolve 为 true 时才做外送/自取回落（只在进本页那一次做，onShow 的刷新不改顾客的选择）
  loadMeta(resolve) {
    var self = this
    getLocalMeta()
      .then(function(meta) {
        var mode = resolve ? app.setLocalMode(resolveLocalMode(meta, app.getLocalMode())) : app.getLocalMode()
        self.setData({ meta: meta, mode: mode, headBlocking: headNoticeOf(meta, mode).blocking })
        self.afterGroupsRendered() // 门店头第一次画出来会把右侧往下推，要重量
      })
      .catch(function() {
        // 保留上一次的 meta：拉不到状态时，把营业中的店显示成打烊比不刷新更糟
      })
  },

  // 一次拉全本渠道的分类与商品，按分类分段。分类拉失败不丢菜：全部归到「其他」。
  loadCatalog() {
    var self = this
    var channel = this.data.channel
    var seq = (this._catalogSeq = (this._catalogSeq || 0) + 1) // 切渠道时让在途的旧结果作废
    this.setData({ catalogLoading: true })
    Promise.all([
      catalogApi.getCategories(channel).then(function(d) { return d || [] }, function() { return [] }),
      catalogApi.getAllProducts(channel),
    ]).then(function(r) {
      if (seq !== self._catalogSeq) return
      var cats = r[0].map(function(c) { return { id: c.id, name: c.name } })
      var products = (r[1].list || []).map(function(p) { return self.decorateProduct(p) })
      self._products = products
      var groups = catalogGroups.groupByCategory(cats, products)
      var first = groups.length ? groups[0] : null
      self.setData({ groups: groups, catalogLoading: false, activeGroupId: first ? first.id : null, activeGroupName: first ? first.name : '' })
      self.afterGroupsRendered() // 量各段锚点位置，Task 5 填充实现
      if (self._pendingLocateId != null) {
        var id = self._pendingLocateId
        self._pendingLocateId = null
        self.locateGroup(id)
      }
    }).catch(function() {
      if (seq === self._catalogSeq) self.setData({ catalogLoading: false })
    })
  },

  // 商品原始字段 → 页面展示字段。分组视图与搜索视图共用。
  decorateProduct(p) {
    return Object.assign({}, p, {
      priceText: formatPrice(p.price),
      stockLabel: formatStock(p.stock),
      hasSkus: !!p.hasSkus,
    })
  },

  // 在 groups 里找到就设高亮，找不到不动
  setActiveGroup(id) {
    var groups = this.data.groups
    for (var i = 0; i < groups.length; i++) {
      if (groups[i].id === id) {
        this.setData({ activeGroupId: id, activeGroupName: groups[i].name })
        return
      }
    }
  },

  // 点左侧 = 定位：滚到该段并立刻高亮。数据还没到位时先记下来，拉完后再定位一次。
  locateGroup(id) {
    var normId = (typeof id === 'string' && id !== 'other') ? Number(id) : id
    if (!this.data.groups.length) {
      this._pendingLocateId = normId
      return
    }
    var found = false
    for (var i = 0; i < this.data.groups.length; i++) {
      if (this.data.groups[i].id === normId) { found = true; break }
    }
    if (!found) return
    if (this.data.searchKeyword) this.clearSearch()
    this.setActiveGroup(normId)
    this._lockUntil = Date.now() + 500
    var target = 'g-' + normId
    if (this.data.scrollIntoView === target) {
      // scroll-into-view 设成同一个值不会再次触发：顾客滑走后再点同一个分类要先置空再设
      this.setData({ scrollIntoView: '' })
      this.setData({ scrollIntoView: target })
    } else {
      this.setData({ scrollIntoView: target })
    }
  },

  onSelectCategory(e) {
    this.locateGroup(e.currentTarget.dataset.id)
  },

  resetRightScroll() {
    this.setData({ rightScrollTop: this.data.rightScrollTop === 0 ? 0.5 : 0 })
  },

  // 分段渲染完成后（或右侧高度可能变化后）量一次锚点位置。
  // 完整门店头的高度由子组件二次 setData 决定（营业状态/通知条这类异步字段），
  // 头由高变矮时（店主恢复营业、通知条消失）nextTick 那次量可能量早了：与 onImageLoad
  // 同款的幂等保险，200ms 后再补量一次；量两次数值一样也无所谓，setData 会自己去重。
  afterGroupsRendered() {
    var self = this
    var run = function() { self.measureOffsets() }
    if (wx.nextTick) wx.nextTick(run)
    else setTimeout(run, 0)
    if (this._remeasureTimer) clearTimeout(this._remeasureTimer)
    this._remeasureTimer = setTimeout(run, 200)
  },

  // 量各段顶部位置（相对 scroll-view 内容顶）与最后一段的补白。只在分段渲染完成后调，滚动时只做数值比较。
  measureOffsets() {
    if (this.data.searchKeyword || !this.data.groups.length || !wx.createSelectorQuery) return
    var self = this
    wx.createSelectorQuery()
      .select('.prod-panel').boundingClientRect()
      .select('.prod-panel').scrollOffset()
      .selectAll('.group-anchor').boundingClientRect()
      .exec(function(res) {
        var panel = res[0], scroll = res[1], rects = res[2] || []
        if (!panel || !scroll || !rects.length) return
        var offsets = []
        for (var i = 0; i < rects.length; i++) {
          var gid = rects[i].dataset && rects[i].dataset.gid
          if (typeof gid === 'string' && gid !== 'other' && gid !== '' && !isNaN(Number(gid))) gid = Number(gid)
          offsets.push({ id: gid, top: rects[i].top - panel.top + scroll.scrollTop })
        }
        self._offsets = offsets
        // 最后一段顶不上去就永远亮不了：补白 = 可视高 − 最后段高。可视高取 scroll-view 自身高与「窗口底到面板顶」的较小值
        // （同城下 .prod-panel 有给购物车条让位的 padding-bottom，盒子比可视区高，多补一点空白无害，少补才是 bug）
        var win = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
        var visible = Math.min(panel.height, win.windowHeight - panel.top)
        var tail = Math.max(0, Math.round(visible - rects[rects.length - 1].height))
        if (tail !== self.data.tailHeight) self.setData({ tailHeight: tail })
      })
  },

  // 尾随节流 100ms：保证最后一次滚动位置一定被处理
  onRightScroll(e) {
    if (this.data.searchKeyword) return
    this._pendingScrollTop = e.detail.scrollTop
    if (this._scrollTimer) return
    var self = this
    this._scrollTimer = setTimeout(function() {
      self._scrollTimer = null
      if (Date.now() < (self._lockUntil || 0)) return // 点左侧后的滚动动画期间不让中间经过的段抢高亮
      var id = catalogGroups.activeGroupOf(self._offsets, self._pendingScrollTop, 2)
      if (id != null && id !== self.data.activeGroupId) self.setActiveGroup(id)
    }, 100)
  },

  // 商品图盒子是固定 160rpx 方盒，图片加载一般不改变布局；这里去抖重量只是按 spec §5.2 留的保险。
  onImageLoad() {
    var self = this
    if (this._imgTimer) clearTimeout(this._imgTimer)
    this._imgTimer = setTimeout(function() { self.measureOffsets() }, 300)
  },

  onHide() {
    this._clearTimers()
  },

  onUnload() {
    this._clearTimers()
  },

  // tabBar 页 onUnload 基本不触发，onHide 必须清，否则定时器在别的 tab 上 setData
  _clearTimers() {
    if (this._scrollTimer) { clearTimeout(this._scrollTimer); this._scrollTimer = null }
    if (this._imgTimer) { clearTimeout(this._imgTimer); this._imgTimer = null }
    if (this._remeasureTimer) { clearTimeout(this._remeasureTimer); this._remeasureTimer = null }
  },

  // 搜索结果分页（仅搜索模式生效；分组视图下右侧一次拉全，不走分页）
  loadProducts(reset) {
    if (!this.data.searchKeyword) return
    if (this.data.loading) return
    if (!reset && !this.data.hasMore) return

    var page = reset ? 1 : this.data.page
    var self = this
    // 记录本次请求对应的筛选条件，响应回来时若条件已变则丢弃（防止快速切换搜索词时串数据）。
    var reqKey = this.buildQueryKey()
    this.setData({ loading: true })

    catalogApi.getProducts({
      channel: this.data.channel,
      page: page,
      pageSize: this.data.pageSize,
      keyword: this.data.searchKeyword,
    })
      .then(function(data) {
        if (self.buildQueryKey() !== reqKey) {
          // 条件已变化：本次结果作废，让新条件的请求重新发起
          self.setData({ loading: false })
          self.loadProducts(true)
          return
        }
        var newItems = (data.list || []).map(function(p) { return self.decorateProduct(p) })
        var list = reset ? newItems : self.data.list.concat(newItems)
        var total = data.total || 0
        self.setData({
          list: list,
          page: page + 1,
          total: total,
          hasMore: list.length < total,
          loading: false,
        })
      })
      .catch(function() {
        self.setData({ loading: false })
      })
  },

  buildQueryKey() {
    return this.data.channel + '|' + (this.data.searchKeyword ? 'k:' + this.data.searchKeyword : 'g')
  },

  onScrollToLower() {
    if (!this.data.searchKeyword) return
    this.loadProducts(false)
  },

  onSearchInput(e) {
    this.setData({ keyword: e.detail.value })
  },

  onSearchConfirm() {
    var kw = (this.data.keyword || '').trim()
    if (!kw) {
      if (this.data.searchKeyword) this.clearSearch()
      return
    }
    if (kw === this.data.searchKeyword) return
    this.setData({
      searchKeyword: kw,
      keyword: kw,
      list: [],
      page: 1,
      total: 0,
      hasMore: true,
    })
    this.resetRightScroll()
    this.loadProducts(true)
  },

  // 清除搜索，回到分组视图（不重新拉全量）：回到顶部、高亮第一段
  clearSearch() {
    this.setData({
      searchKeyword: '',
      keyword: '',
      list: [],
      page: 1,
      total: 0,
      hasMore: true,
      scrollIntoView: '',
    })
    this.resetRightScroll()
    if (this.data.groups.length) this.setActiveGroup(this.data.groups[0].id)
    this.afterGroupsRendered() // 分段重新渲染后要重量
  },

  goToDetail(e) {
    var id = e.currentTarget.dataset.id
    wx.navigateTo({ url: '/pages/product/detail?id=' + id })
  },

  // 搜索模式下先在 list（搜索结果）里找，再在全量 _products 里找
  findProduct(id) {
    var i
    for (i = 0; i < this.data.list.length; i++) {
      if (this.data.list[i].id === id) return this.data.list[i]
    }
    var products = this._products || []
    for (i = 0; i < products.length; i++) {
      if (products[i].id === id) return products[i]
    }
    return null
  },

  // 同城「+」：整条加购流程（拉详情 → 弹规格 → 加购 → 提示）在
  // components/local-sku-picker 里，主页与本页共用同一份。
  onAddToCart(e) {
    var id = e.currentTarget.dataset.id
    var product = this.findProduct(id)
    var picker = this.selectComponent('#local-sku-picker')
    if (product && picker) picker.open(product)
  },

  // 加购成功（含「加错了渠道」那一支）：刷购物车条与角标
  onAdded() {
    this.refreshCartBar()
    app.updateCartCount()
  },

  refreshCartBar() {
    var bar = this.selectComponent('#local-cart-bar')
    if (bar) bar.refresh()
  },

  onCartChange() {
    app.updateCartCount()
  },

  onGoExpress() {
    app.setShoppingChannel('EXPRESS')
    this.reloadForChannel()
  },

  // ── 渠道标识与切换弹层（2026-09-17 设计 N1–N3）────────────────────
  // 两侧标识共用这一个弹层；选中即切渠道并**重载本页**（不跳主页）。
  // 去同城走 app.gateLocalChannel()（位置许可 → 定渠道），页面不自己问许可；去邮寄与 onGoExpress 同一条路。
  openChannelSheet() {
    this.setData({ channelSheetOpen: true })
  },
  closeChannelSheet() {
    this.setData({ channelSheetOpen: false })
  },
  noop() {},
  onPickChannel(e) {
    var target = e.currentTarget.dataset.channel
    this.closeChannelSheet()
    if (target === this.data.channel) return
    if (target === 'EXPRESS') { this.onGoExpress(); return }
    var self = this
    app.gateLocalChannel().then(function (ok) {
      if (ok) self.reloadForChannel()
    })
  },

  // 子模式变了：阻塞态按新模式重算，购物车条的按钮跟着变（去向与起送线都不一样）
  applyMode(mode) {
    this.setData({ mode: mode, headBlocking: headNoticeOf(this.data.meta, mode).blocking })
    this.refreshCartBar()
    this.afterGroupsRendered() // 外送/自取切换会改页头高度，要重量
  },
  onModeChange(e) {
    this.applyMode(app.setLocalMode(e.detail.mode))
  },
  // 页头通知里的「改用自取 / 改用外送」
  onSwitchMode(e) {
    this.applyMode(app.setLocalMode(e.detail.mode))
  },
})
