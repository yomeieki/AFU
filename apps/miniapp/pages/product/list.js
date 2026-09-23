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
var categoryScroll = require('../../utils/category-scroll')
var promoTypeOf = require('../../utils/promo').promoTypeOf
const app = getApp()
var share = require('../../utils/share')

Page({
  onShareAppMessage: share.onShareAppMessage,
  data: {
    cartSpacerPx: 0,
    pinnedHeight: 0,
    sidebarTop: 0,
    sidebarHeight: 0,
    sidebarScrollTop: 0,
    promotion: null,
    promoType: 'EXPRESS',
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
    // 分组视图
    groups: [],            // [{ id, name, items }]，左侧与右侧分段都渲染它
    activeGroupId: null,   // 当前高亮段；搜索模式下 wxml 不画高亮
    activeGroupName: '',   // 右侧顶部浮动条文字
    tailHeight: 0,         // 最后一段之后的补白（px），量出来的
    catalogLoading: false, // 分组视图拉全量中 → 骨架屏
    channelSheetOpen: false, // 渠道切换弹层（两侧标识共用）
  },

  onCartHeight: function(e) {
    var px = typeof e.detail.px === 'number' && isFinite(e.detail.px) ? Math.max(0, e.detail.px) : 0
    if (px !== this.data.cartSpacerPx) {
      this.setData({ cartSpacerPx: px })
      this._updateSidebarLayout()
      this.afterGroupsRendered()
    }
  },

  onLoad() {
    this.reloadForChannel()
  },

  // 每次切到本 tab 都会触发。渠道变了就整页重来；否则只消费主页传来的分类意图。
  onShow() {
    this._hidden = false
    if (app.getShoppingChannel() !== this.data.channel) {
      this.reloadForChannel()
      return
    }
    if (this.data.channel === 'LOCAL') {
      if (app.getLocalMode() !== this.data.mode) this.applyMode(app.getLocalMode())
    }
    this.loadMeta()
    this.afterGroupsRendered()
    this.refreshCartBar()
    var g = app.globalData
    if (g.pendingCategoryAll === true) {
      g.pendingCategoryAll = false
      g.pendingCategoryId = null
      g.pendingCategoryName = null
      if (this.data.searchKeyword) {
        this.clearSearch()
      } else {
        this.scrollPageTo(0, 0)
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
    this._invalidateMeasurements()
    this._clearTimers()
    this._pendingLocateId = null
    this._anchorSnapshot = null
    this._offsets = []
    this._layout = null
    this._pageScrollTop = 0
    this._sidebarScrollTop = 0
    this._needsSidebarReveal = false
    this._lockUntil = 0
    this._pendingScrollTop = null
    this._searchSeq = (this._searchSeq || 0) + 1
    var channel = app.getShoppingChannel()
    this.setData({
      channel: channel,
      groups: [],
      activeGroupId: null,
      activeGroupName: '',
      tailHeight: 0,
      sidebarTop: 0,
      sidebarHeight: 0,
      sidebarScrollTop: 0,
      pinnedHeight: 0,
      catalogLoading: true,
      keyword: '',
      searchKeyword: '',
      list: [],
      page: 1,
      total: 0,
      hasMore: true,
      meta: channel === 'LOCAL' ? this.data.meta : null,
      mode: channel === 'LOCAL' ? app.getLocalMode() : 'DELIVERY',
      promoType: promoTypeOf(channel, app.getLocalMode()),
      headBlocking: false,
      promotion: null,
    })
    this._products = []
    this._offsets = []
    this.scrollPageTo(0, 0)
    this.loadCatalog()
    // 进分类页这一次要做模式回落；onShow 里的刷新（loadMeta() 不传参）不改顾客已选的模式
    this.loadMeta(channel === 'LOCAL')
    this.refreshCartBar()
  },

  // resolve 为 true 时才做外送/自取回落（只在进本页那一次做，onShow 的刷新不改顾客的选择）
  loadMeta(resolve) {
    var self = this
    var channel = this.data.channel
    getLocalMeta()
      .then(function(meta) {
        if (channel !== self.data.channel || self._hidden) return
        self._captureAnchor()
        if (channel === 'EXPRESS') {
          self.setData({ promotion: meta.promotion })
          self.afterGroupsRendered()
          return
        }
        var mode = resolve ? app.setLocalMode(resolveLocalMode(meta, app.getLocalMode())) : app.getLocalMode()
        self.setData({ meta: meta, promotion: meta.promotion, mode: mode, promoType: promoTypeOf('LOCAL', mode), headBlocking: headNoticeOf(meta, mode).blocking })
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
      self.afterGroupsRendered()
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
        if (id !== this.data.activeGroupId || groups[i].name !== this.data.activeGroupName) {
          this.setData({ activeGroupId: id, activeGroupName: groups[i].name })
        }
        this.revealCategory(id)
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
    if (this.data.searchKeyword) {
      this.clearSearch()
      this._offsets = []
      this._pendingLocateId = normId
      this.setActiveGroup(normId)
      return
    }
    if (!this._layout || !this._offsets.length) {
      this._pendingLocateId = normId
      this.afterGroupsRendered()
      return
    }
    this.setActiveGroup(normId)
    if (this._lockTimer) clearTimeout(this._lockTimer)
    var self = this
    var lockRevision = this._lockRevision = (this._lockRevision || 0) + 1
    this._lockUntil = Date.now() + 500
    this._pendingScrollTop = null
    this._lockTimer = setTimeout(function() {
      if (lockRevision !== self._lockRevision) return
      self._lockTimer = null
      self._lockUntil = 0
      if (!self._hidden && !self._unloaded && self._pendingScrollTop != null) self._syncActiveFromScroll()
    }, 500)
    for (var j = 0; j < this._offsets.length; j++) {
      if (this._offsets[j].id === normId) {
        this.scrollPageTo(categoryScroll.pageTarget(this._offsets[j].top, this.data.pinnedHeight), 300)
        return
      }
    }
  },

  onSelectCategory(e) {
    this.locateGroup(e.currentTarget.dataset.id)
  },

  scrollPageTo: function(top, duration) {
    if (wx.pageScrollTo) wx.pageScrollTo({ scrollTop: top, duration: duration || 0 })
  },

  // 分段渲染完成后（或右侧高度可能变化后）量一次锚点位置。
  // 完整门店头的高度由子组件二次 setData 决定（营业状态/通知条这类异步字段），
  // 头由高变矮时（店主恢复营业、通知条消失）nextTick 那次量可能量早了：与 onImageLoad
  // 同款的幂等保险，200ms 后再补量一次；量两次数值一样也无所谓，setData 会自己去重。
  afterGroupsRendered() {
    if (this._hidden || this._unloaded) return
    var self = this
    var run = function() { self.measureOffsets() }
    if (wx.nextTick) wx.nextTick(run)
    else setTimeout(run, 0)
    if (this._remeasureTimer) clearTimeout(this._remeasureTimer)
    this._remeasureTimer = setTimeout(function() {
      self._remeasureTimer = null
      self.measureOffsets(true)
    }, 200)
  },

  _captureAnchor: function() {
    if (!this._layout || this._anchorSnapshot) return
    var y = typeof this._pageScrollTop === 'number' ? this._pageScrollTop : this._layout.scrollTop
    if (y + this._layout.pinnedHeight < this._layout.bodyTop) return
    this._anchorSnapshot = { scrollTop: y, bodyTop: this._layout.bodyTop, pinnedHeight: this._layout.pinnedHeight, scrollRevision: this._scrollRevision || 0 }
  },

  _invalidateMeasurements: function() {
    this._measureGeneration = (this._measureGeneration || 0) + 1
  },

  _updateSidebarLayout: function() {
    if (!this._layout) return
    var geometry = categoryScroll.layoutOf({
      viewportHeight: this._layout.viewportHeight,
      pinnedHeight: this._layout.pinnedHeight,
      bodyTop: this._layout.bodyTop,
      scrollTop: this._pageScrollTop || 0,
      dockHeight: this.data.cartSpacerPx,
      lastGroupHeight: this._layout.lastGroupHeight,
    })
    var patch = {}
    if (geometry.sidebarTop !== this.data.sidebarTop) patch.sidebarTop = geometry.sidebarTop
    if (geometry.sidebarHeight !== this.data.sidebarHeight) patch.sidebarHeight = geometry.sidebarHeight
    if (geometry.tailHeight !== this.data.tailHeight) patch.tailHeight = geometry.tailHeight
    var visibleRangeChanged = geometry.sidebarTop !== this.data.sidebarTop || geometry.sidebarHeight !== this.data.sidebarHeight
    if (Object.keys(patch).length) this.setData(patch)
    if (visibleRangeChanged && this.data.activeGroupId != null) {
      this._needsSidebarReveal = !this.revealCategory(this.data.activeGroupId)
    }
  },

  // Query the viewport and all layout rects together, so document coordinates share one scroll sample.
  measureOffsets(clearAnchorOnResult) {
    if (this._hidden || !wx.createSelectorQuery) return
    var self = this
    var generation = this._measureGeneration = (this._measureGeneration || 0) + 1
    var scrollRevision = this._scrollRevision || 0
    var query = wx.createSelectorQuery()
    if (query.in) query.in(this)
    query.selectViewport().scrollOffset()
    query.select('.catalog-toolbar').boundingClientRect()
    query.select('.catalog-body').boundingClientRect()
    query.selectAll('.group-anchor').boundingClientRect()
    query.selectAll('.cat-item').boundingClientRect()
    query.select('.cat-panel').boundingClientRect()
    query.select('.cat-panel').scrollOffset()
    query.select('.search-results').boundingClientRect()
    query.exec(function(res) {
        if (generation !== self._measureGeneration || self._hidden) return
        var viewport = res[0], toolbar = res[1], body = res[2], rects = res[3] || []
        var items = res[4] || [], sidebar = res[5], sidebarOffset = res[6], searchResults = res[7]
        if (!viewport || !toolbar || !body) return
        var sampledY = Math.max(0, viewport.scrollTop || 0)
        var liveY = (self._scrollRevision || 0) !== scrollRevision ? self._pageScrollTop : sampledY
        var win = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
        var pinnedHeight = toolbar.height || 0
        var bodyTop = body.top + sampledY
        var offsets = []
        for (var i = 0; i < rects.length; i++) {
          var gid = rects[i].dataset && rects[i].dataset.gid
          if (typeof gid === 'string' && gid !== 'other' && gid !== '' && !isNaN(Number(gid))) gid = Number(gid)
          offsets.push({ id: gid, top: rects[i].top + sampledY })
        }
        self._offsets = offsets
        self._sidebarItems = []
        if (sidebar) {
          for (var j = 0; j < items.length; j++) {
            var itemId = items[j].dataset && items[j].dataset.gid
            if (typeof itemId === 'string' && itemId !== 'other' && itemId !== '' && !isNaN(Number(itemId))) itemId = Number(itemId)
            self._sidebarItems.push({ id: itemId, top: items[j].top - sidebar.top + (sidebarOffset && sidebarOffset.scrollTop || 0), height: items[j].height })
          }
        }
        var lastGroupHeight = rects.length ? rects[rects.length - 1].height : 0
        self._layout = { viewportHeight: win.windowHeight, pinnedHeight: pinnedHeight, bodyTop: bodyTop, lastGroupHeight: lastGroupHeight, scrollTop: liveY }
        var anchor = self._anchorSnapshot
        if (anchor && anchor.scrollRevision !== (self._scrollRevision || 0)) {
          self._anchorSnapshot = null
          anchor = null
        }
        if (anchor && (anchor.bodyTop !== bodyTop || anchor.pinnedHeight !== pinnedHeight)) {
          var desired = Math.max(0, anchor.scrollTop + bodyTop - anchor.bodyTop - (pinnedHeight - anchor.pinnedHeight))
          self._anchorSnapshot = null
          if (Math.abs(desired - liveY) >= 1) {
            self.scrollPageTo(desired, 0)
            liveY = desired
          }
        }
        if (clearAnchorOnResult) self._anchorSnapshot = null
        self._pageScrollTop = liveY
        var patch = {}
        if (self.data.pinnedHeight !== pinnedHeight) patch.pinnedHeight = pinnedHeight
        if (Object.keys(patch).length) self.setData(patch)
        self._updateSidebarLayout()
        if (self._pendingLocateId != null && offsets.length) {
          var pendingId = self._pendingLocateId
          self._pendingLocateId = null
          self.locateGroup(pendingId)
        }
        if (self._needsSidebarReveal && !self.data.searchKeyword && self.data.activeGroupId != null) {
          self._needsSidebarReveal = !self.revealCategory(self.data.activeGroupId)
        }
        if (self.data.searchKeyword) self._fillSearchViewport(searchResults, liveY, win.windowHeight)
      })
  },

  // 尾随节流 100ms：保证最后一次滚动位置一定被处理
  onPageScroll(e) {
    if (this._hidden) return
    var y = Math.max(0, e.scrollTop || 0)
    this._scrollRevision = (this._scrollRevision || 0) + 1
    this._pageScrollTop = y
    if (this._layout && (y < this._layout.bodyTop - this._layout.pinnedHeight || this.data.sidebarTop !== this._layout.pinnedHeight)) this._updateSidebarLayout()
    if (this.data.searchKeyword) return
    this._pendingScrollTop = y
    if (this._scrollTimer) return
    var self = this
    this._scrollTimer = setTimeout(function() {
      self._scrollTimer = null
      if (self._hidden) return
      if (Date.now() < (self._lockUntil || 0)) return // 点左侧后的滚动动画期间不让中间经过的段抢高亮
      self._syncActiveFromScroll()
    }, 100)
  },

  _syncActiveFromScroll: function() {
    if (this.data.searchKeyword || this._pendingScrollTop == null) return
    var id = catalogGroups.activeGroupOf(this._offsets, this._pendingScrollTop + this.data.pinnedHeight, 2)
    if (id != null && id !== this.data.activeGroupId) this.setActiveGroup(id)
  },

  onSidebarScroll: function(e) {
    this._sidebarScrollTop = Math.max(0, e.detail.scrollTop || 0)
  },

  revealCategory: function(id) {
    if (!this._sidebarItems || !this._layout || this.data.sidebarHeight <= 0) return false
    for (var i = 0; i < this._sidebarItems.length; i++) {
      if (this._sidebarItems[i].id !== id) continue
      var oldTop = this._sidebarScrollTop || 0
      var top = categoryScroll.revealScrollTop({ itemTop: this._sidebarItems[i].top, itemHeight: this._sidebarItems[i].height, scrollTop: oldTop, viewportHeight: this.data.sidebarHeight })
      if (Math.abs(top - oldTop) < 1) return true
      this._sidebarScrollTop = top
      this.setData({ sidebarScrollTop: top === this.data.sidebarScrollTop ? top + 0.5 : top })
      return true
    }
    return false
  },

  onReachBottom: function() {
    this.onScrollToLower()
  },

  onResize: function() {
    this.afterGroupsRendered()
  },

  // 商品图盒子是固定 160rpx 方盒，图片加载一般不改变布局；这里去抖重量只是按 spec §5.2 留的保险。
  onImageLoad() {
    var self = this
    if (this._imgTimer) clearTimeout(this._imgTimer)
    this._imgTimer = setTimeout(function() { self.measureOffsets() }, 300)
  },

  onHide() {
    this._hidden = true
    this._invalidateMeasurements()
    this._anchorSnapshot = null
    this._clearTimers()
    this._lockUntil = 0
  },

  onUnload() {
    this._unloaded = true
    this._hidden = true
    this._invalidateMeasurements()
    this._anchorSnapshot = null
    this._clearTimers()
    this._lockUntil = 0
  },

  // tabBar 页 onUnload 基本不触发，onHide 必须清，否则定时器在别的 tab 上 setData
  _clearTimers() {
    if (this._scrollTimer) { clearTimeout(this._scrollTimer); this._scrollTimer = null }
    if (this._lockTimer) { clearTimeout(this._lockTimer); this._lockTimer = null }
    this._lockRevision = (this._lockRevision || 0) + 1
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
    var seq = this._searchSeq || 0
    this.setData({ loading: true })

    catalogApi.getProducts({
      channel: this.data.channel,
      page: page,
      pageSize: this.data.pageSize,
      keyword: this.data.searchKeyword,
    })
      .then(function(data) {
        if (self._unloaded || seq !== (self._searchSeq || 0)) return
        if (self.buildQueryKey() !== reqKey) {
          // 条件已变化：本次结果作废，让新条件的请求重新发起
          self.setData({ loading: false })
          self.loadProducts(true)
          return
        }
        var existing = reset ? [] : self.data.list
        var seen = {}
        for (var i = 0; i < existing.length; i++) seen[String(existing[i].id)] = true
        var newItems = []
        var incoming = data.list || []
        for (var j = 0; j < incoming.length; j++) {
          var key = String(incoming[j].id)
          if (seen[key]) continue
          seen[key] = true
          newItems.push(self.decorateProduct(incoming[j]))
        }
        var list = existing.concat(newItems)
        var total = data.total || 0
        self.setData({
          list: list,
          page: page + 1,
          total: total,
          hasMore: !!newItems.length && list.length < total,
          loading: false,
        })
        self.afterGroupsRendered()
      })
      .catch(function() {
        if (!self._unloaded && seq === (self._searchSeq || 0)) self.setData({ loading: false })
      })
  },

  _fillSearchViewport: function(results, scrollTop, viewportHeight) {
    if (!this.data.searchKeyword || this.data.loading || !this.data.hasMore || !results) return
    var bottom = typeof results.bottom === 'number' ? results.bottom : results.top + results.height
    if (bottom <= viewportHeight - this.data.cartSpacerPx + 120) this.loadProducts(false)
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
    this._searchSeq = (this._searchSeq || 0) + 1
    this.setData({
      searchKeyword: kw,
      keyword: kw,
      list: [],
      page: 1,
      total: 0,
      hasMore: true,
      loading: false,
    })
    this.scrollPageTo(0, 0)
    this.loadProducts(true)
  },

  // 清除搜索，回到分组视图（不重新拉全量）：回到顶部、高亮第一段
  clearSearch() {
    this._searchSeq = (this._searchSeq || 0) + 1
    this.setData({
      searchKeyword: '',
      keyword: '',
      list: [],
      page: 1,
      total: 0,
      hasMore: true,
      loading: false,
    })
    this.scrollPageTo(0, 0)
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
    this._captureAnchor()
    this.setData({ mode: mode, promoType: promoTypeOf(this.data.channel, mode), headBlocking: headNoticeOf(this.data.meta, mode).blocking })
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
