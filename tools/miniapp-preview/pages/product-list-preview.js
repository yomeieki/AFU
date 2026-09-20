/* Browser bridge for category layout only. Sample products/cart never call an API or checkout. */
(function () {
  'use strict'

  var channel = document.body.dataset.channel
  var local = channel === 'LOCAL'
  var names = ['凉菜', '熟食', '卤味', '礼盒', '自贡特产', '小吃', '下饭菜', '时令推荐', '素菜', '甜品', '汤羹', '面食', '调味', '预制菜', '酒水/饮料']
  var state = { mode: 'DELIVERY', cartCount: 7, active: 0, search: '', searchPage: 0, loading: false }
  var root = document.getElementById('preview-root')
  var raf = 0
  var clickLockUntil = 0

  function esc(value) {
    return String(value).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] })
  }

  // Deterministic repeats keep the page long while the final category has one short product.
  var groups = names.map(function (name, groupIndex) {
    var count = groupIndex === names.length - 1 ? 1 : (groupIndex === 0 ? 4 : 3)
    return { id: 'preview-' + groupIndex, name: name, items: Array.from({ length: count }, function (_, itemIndex) {
      return { name: groupIndex === names.length - 1 ? '酸梅汤' : (['冷吃兔', '凉拌折耳根', '麻辣牛肉', '口水鸡'][itemIndex % 4] + ' · ' + name), subtitle: '预览用样例商品', price: ['45.80', '12.00', '39.90', '28.00'][itemIndex % 4], sales: 28 + groupIndex * 13 + itemIndex }
    }) }
  })

  function product(item) {
    var price = item.price.split('.')
    return '<div class="product-row">' +
      '<div class="product-row-img-wrap"><div class="product-row-img-placeholder img-placeholder"></div></div>' +
      '<div class="product-row-info"><span class="product-row-name">' + esc(item.name) + '</span>' +
      '<span class="product-row-subtitle">' + esc(item.subtitle) + '</span>' +
      '<div class="product-row-meta"><span class="product-row-stock">有货</span><span class="product-row-sales">已售' + item.sales + '</span></div>' +
      '<div class="product-row-bottom"><span class="price-symbol">¥</span><span class="price-int product-row-price-int">' + price[0] + '</span><span class="price-dec">.' + price[1] + '</span><span class="product-row-unit">/ 份</span>' +
      (local ? '<button type="button" class="add-btn" aria-label="加购 ' + esc(item.name) + '">+</button>' : '') + '</div></div></div>'
  }

  function channelBadge() { return '<a class="channel-badge" href="/pages/product-list' + (local ? '' : '-local') + '.html">' + (local ? '同城配送' : '全国邮寄') + '<span class="channel-badge-caret">⌄</span></a>' }

  function header() {
    if (!local) return '<div class="catalog-toolbar search-bar"><div class="search-input-wrap"><span class="search-icon">🔍</span><input id="catalog-search" class="search-input" placeholder="搜索商品" aria-label="搜索商品"><button id="search-confirm" class="search-clear" type="button">搜索</button></div>' + channelBadge() + '</div>'
    return '<div class="store-head"><div class="store-title-row"><div class="store-name-wrap"><div class="icon icon-shop store-icon"></div><span class="store-name">自贡味道同城店</span><span class="status-pill status-pill-closed">已打烊</span></div>' + channelBadge() + '</div>' +
      '<div class="delivery-rules-row"><span class="delivery-rules">配送范围 5 公里 · ¥30 起送 · 运费结算时算</span><span class="delivery-rules-arrow">›</span></div>' +
      '<div class="head-notice head-notice-soft"><span class="head-notice-text" id="notice-text">当前已打烊，您可以提前下单，营业后将按顺序安排配送。若您想预约自取，可切换到自取查看可预约时段。</span></div></div>'
  }

  function toolbar() {
    if (!local) return ''
    return '<div class="catalog-toolbar"><div class="mode-bar"><button type="button" class="mode-tab active" data-mode="DELIVERY"><span class="mode-name">外送</span></button><button type="button" class="mode-tab" data-mode="PICKUP"><span class="mode-name">自取</span><span class="mode-sub mode-sub-open">可预约</span></button></div></div>'
  }

  function renderBase() {
    root.innerHTML = '<div class="page ' + (local ? 'page-local' : '') + '">' + header() +
      '<div class="promo-bar"><span class="promo-badge">减</span><span class="promo-summary">全店满减　满 66 减 6 · 满 108 减 12</span><span class="promo-detail">详情 ›</span></div>' +
      '<div id="search-chip" class="category-tag-bar" hidden></div>' + toolbar() +
      '<div class="body catalog-body"><div id="category-rail" class="cat-panel"></div><div class="prod-wrap"><div id="product-panel" class="prod-panel"></div></div></div>' +
      '<div id="cart-spacer" class="cart-spacer"></div></div><div id="cart-host"></div>' +
      '<button id="cart-toggle" class="preview-control" type="button">预览：切换空车</button>'
    document.getElementById('category-rail').innerHTML = groups.map(function (group, index) {
      return '<button type="button" class="cat-item' + (index === 0 ? ' active' : '') + '" data-index="' + index + '" id="cat-' + group.id + '"><span class="cat-item-bar"></span><span class="cat-item-name">' + esc(group.name) + '</span></button>'
    }).join('')
    renderGroups()
    renderCart()
    bind()
    updateLayout()
  }

  function renderGroups() {
    var panel = document.getElementById('product-panel')
    if (state.search) {
      var matches = groups.flatMap(function (g) { return g.items }).filter(function (item) { return item.name.indexOf(state.search) !== -1 })
      var visible = matches.slice(0, state.searchPage * 5)
      panel.innerHTML = '<div class="search-results"><div class="product-list">' + visible.map(product).join('') + '</div><button type="button" id="load-more" class="footer-tip"' + (visible.length >= matches.length ? ' disabled' : '') + '>' + (visible.length >= matches.length ? '- 没有更多了 -' : '加载更多示例商品') + '</button></div>'
      document.getElementById('search-chip').hidden = false
      document.getElementById('search-chip').innerHTML = '<span class="category-tag"><span class="category-tag-text">搜索：' + esc(state.search) + '</span><button type="button" class="category-tag-close" id="search-clear" aria-label="清除搜索">×</button></span>'
      document.getElementById('search-clear').addEventListener('click', clearSearch)
      document.getElementById('load-more').addEventListener('click', loadMore)
    } else {
      document.getElementById('search-chip').hidden = true
      panel.innerHTML = groups.map(function (group, index) {
        return '<div class="group-anchor" data-index="' + index + '" id="g-' + group.id + '"><div class="group-head">' + esc(group.name) + '</div><div class="product-list">' + group.items.map(product).join('') + '</div></div>'
      }).join('') + '<div class="group-tail" id="group-tail"></div>'
    }
    panel.querySelectorAll('.add-btn').forEach(function (button) { button.addEventListener('click', function (event) { event.stopPropagation(); state.cartCount += 1; renderCart(); updateLayout() }) })
    updateLayout()
  }

  function renderCart() {
    var host = document.getElementById('cart-host')
    document.body.classList.toggle('preview-cart-full', !!state.cartCount)
    if (!state.cartCount) { host.innerHTML = ''; return }
    host.innerHTML = '<div class="cart-dock"><div class="cart-tip"><span class="cart-tip-em">已减 ¥6 · 再买 ¥42 可减 ¥12（示例）</span></div>' +
      '<div class="local-cart-bar"><div class="cart-summary"><div class="cart-icon"><div class="cart-drawing"></div><span class="cart-badge">' + state.cartCount + '</span></div><div class="cart-summary-text"><div class="cart-summary-main"><span class="cart-summary-amount">¥191.00</span><span class="cart-summary-orig">¥197.00</span></div><span class="cart-summary-sub">样例购物车 · ' + state.cartCount + ' 件</span></div></div><span class="checkout-btn btn-primary">去结算 · ' + (local ? (state.mode === 'PICKUP' ? '自取' : '外送') : '邮寄') + '</span></div></div>'
  }

  function updateLayout() {
    if (!document.getElementById('category-rail')) return
    document.documentElement.style.setProperty('--rpx', (window.innerWidth / 750) + 'px')
    var toolbarNode = document.querySelector('.catalog-toolbar')
    var body = document.querySelector('.catalog-body')
    var sidebar = document.getElementById('category-rail')
    var dock = document.querySelector('.cart-dock')
    var pinned = toolbarNode ? toolbarNode.getBoundingClientRect().height : 0
    var bodyTop = body.getBoundingClientRect().top + window.scrollY
    var dockHeight = dock ? dock.getBoundingClientRect().height : 0
    var top = Math.max(pinned, bodyTop - window.scrollY)
    sidebar.style.top = top + 'px'
    sidebar.style.height = Math.max(0, window.innerHeight - dockHeight - top) + 'px'
    document.querySelectorAll('.group-head').forEach(function (head) { head.style.top = pinned + 'px' })
    var tail = document.getElementById('group-tail')
    if (tail) {
      var anchors = document.querySelectorAll('.group-anchor')
      var last = anchors[anchors.length - 1]
      tail.style.height = Math.max(0, window.innerHeight - pinned - dockHeight - (last ? last.getBoundingClientRect().height : 0)) + 'px'
    }
    document.getElementById('cart-spacer').style.height = dockHeight + 'px'
    if (!state.search) updateActive(pinned)
  }

  function updateActive(pinned) {
    if (Date.now() < clickLockUntil) return
    var anchors = Array.from(document.querySelectorAll('.group-anchor'))
    if (!anchors.length) return
    var y = window.scrollY + pinned + 2
    var index = 0
    anchors.forEach(function (anchor, i) {
      if (anchor.getBoundingClientRect().top + window.scrollY <= y) index = i
    })
    setActive(index)
  }

  function setActive(index) {
    if (state.active === index && document.querySelector('.cat-item.active')) return
    state.active = index
    document.querySelectorAll('.cat-item').forEach(function (item, i) { item.classList.toggle('active', i === index) })
    var sidebar = document.getElementById('category-rail')
    var item = sidebar.querySelector('[data-index="' + index + '"]')
    if (item.offsetTop < sidebar.scrollTop) sidebar.scrollTo({ top: item.offsetTop, behavior: 'smooth' })
    else if (item.offsetTop + item.offsetHeight > sidebar.scrollTop + sidebar.clientHeight) sidebar.scrollTo({ top: item.offsetTop + item.offsetHeight - sidebar.clientHeight, behavior: 'smooth' })
  }

  function selectCategory(index) {
    if (state.search) clearSearch()
    setActive(index)
    clickLockUntil = Date.now() + 500
    var group = document.getElementById('g-' + groups[index].id)
    var pinned = document.querySelector('.catalog-toolbar').getBoundingClientRect().height
    var documentTop = group.getBoundingClientRect().top + window.scrollY
    window.scrollTo({ top: Math.max(0, documentTop - pinned), behavior: 'smooth' })
  }

  function startSearch() {
    var query = document.getElementById('catalog-search').value.trim()
    if (!query) { clearSearch(); return }
    state.search = query
    state.searchPage = 1
    renderGroups()
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  function clearSearch() {
    state.search = ''
    state.searchPage = 0
    document.getElementById('catalog-search').value = ''
    renderGroups()
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  function loadMore() { if (state.search) { state.searchPage += 1; renderGroups() } }

  function bind() {
    document.getElementById('category-rail').addEventListener('click', function (event) {
      var item = event.target.closest('.cat-item')
      if (item) selectCategory(Number(item.dataset.index))
    })
    document.getElementById('cart-toggle').addEventListener('click', function () { state.cartCount = state.cartCount ? 0 : 7; renderCart(); updateLayout() })
    if (local) document.querySelectorAll('.mode-tab').forEach(function (tab) { tab.addEventListener('click', function () {
      state.mode = tab.dataset.mode
      document.querySelectorAll('.mode-tab').forEach(function (other) { other.classList.toggle('active', other === tab) })
      document.getElementById('notice-text').textContent = state.mode === 'PICKUP' ? '当前已打烊，自取仍可预约。请先选择合适的自取时间；实际可预约时段以小程序为准。' : '当前已打烊，您可以提前下单，营业后将按顺序安排配送。若您想预约自取，可切换到自取查看可预约时段。'
      renderCart(); updateLayout()
    }) })
    else {
      document.getElementById('search-confirm').addEventListener('click', startSearch)
      document.getElementById('catalog-search').addEventListener('keydown', function (event) { if (event.key === 'Enter') startSearch() })
    }
    window.addEventListener('resize', updateLayout)
    window.addEventListener('scroll', function () {
      if (raf) return
      raf = requestAnimationFrame(function () {
        raf = 0
        updateLayout()
        if (state.search && !state.loading && window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 5) {
          var load = document.getElementById('load-more')
          if (load && !load.disabled) { state.loading = true; setTimeout(function () { loadMore(); state.loading = false }, 120) }
        }
      })
    }, { passive: true })
  }

  renderBase()
  window.categoryPreview = { state: state, groups: groups, updateLayout: updateLayout }
})()
