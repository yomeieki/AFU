const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const read = p => fs.readFileSync(path.join(__dirname, '../../apps/miniapp', p), 'utf8')
test('分类页使用原生页面滚动与一份页面级购物栏占位', () => {
  const wxml = read('pages/product/list.wxml')
  assert.doesNotMatch(wxml, /<scroll-view\s+class="prod-panel"/)
  assert.equal((wxml.match(/class="cart-spacer"/g) || []).length, 1)
  assert.match(wxml, /class="body catalog-body"/)
  assert.match(wxml, /class="cat-panel"[^>]*bindscroll="onSidebarScroll"/)
  assert.match(read('pages/product/list.wxss'), /\.catalog-toolbar\s*\{[^}]*position:\s*sticky/)
})
test('主页底部按实测高度占位', () => {
  assert.doesNotMatch(read('pages/index/index.wxss'), /\.page-local\s*\{/)
  assert.match(read('pages/index/index.wxml'), /class="cart-spacer"/)
})
test('结算条固定尺寸并包含进度提示与整体高度容器', () => {
  const css = read('components/local-cart-bar/index.wxss')
  assert.match(css, /\.local-cart-bar\s*\{[^}]*min-height:\s*88rpx/)
  assert.match(css, /\.local-cart-bar\s+\.checkout-btn\s*\{[^}]*height:\s*68rpx/)
  assert.doesNotMatch(css, /112rpx/)
  assert.match(read('components/local-cart-bar/index.wxml'), /class="cart-dock"/)
  assert.match(read('components/local-cart-bar/index.wxml'), /cart-tip/)
})
test('主页和分类页两个渠道都挂载结算条并监听高度', () => {
  for (const p of ['pages/index/index', 'pages/product/list']) {
    const tag = read(p + '.wxml').match(/<local-cart-bar\b[^>]*>/)[0]
    assert.doesNotMatch(tag, /wx:if/)
    assert.match(tag, /channel="{{channel}}"/)
    assert.match(tag, /bind:height="onCartHeight"/)
  }
})
test('两页活动条位于条件链之外并注册组件', () => {
  for (const p of ['pages/index/index', 'pages/product/list']) {
    const tag = read(p + '.wxml').match(/<promo-bar\b[^>]*>/)
    assert.ok(tag)
    assert.doesNotMatch(tag[0], /wx:elif/)
    assert.equal(JSON.parse(read(p + '.json')).usingComponents['promo-bar'], '/components/promo-bar/index')
  }
})
test('三个结算页满减行位于指定明细位置，统一使用组合计价', () => {
  for (const [p, before] of [['local/confirm', '打包费'], ['local/pickup', '自取优惠'], ['order/confirm', '商品金额']]) {
    const w = read('pages/' + p + '.wxml').replace(/<!--[\s\S]*?-->/g, '')
    assert.match(w, /<view\s+wx:if="{{promoDiscount > 0}}"[^>]*>\s*<text[^>]*>满减<\/text>/)
    assert.ok(w.indexOf('>' + before + '</text>') < w.indexOf('>满减</text>'))
    assert.ok(w.indexOf('>满减</text>') < w.indexOf('>优惠券</text>'))
    assert.match(w, /已优惠/)
  }
  for (const p of ['pages/local/confirm.js', 'pages/order/confirm.js', 'utils/pickup-checkout-state.js']) assert.match(read(p), /composePay\(/)
  assert.doesNotMatch(read('pages/local/confirm.js'), /d\.subtotal - d\.discount \+ fee \+ d\.packingFee/)
  assert.doesNotMatch(read('pages/order/confirm.js'), /this\.data\.totalAmount - this\.data\.discount \+ \(this\.data\.shippingFee \|\| 0\)/)
})
test('三种结算页将其它优惠传给优惠券组件', () => {
  for (const p of ['local/confirm', 'local/pickup', 'order/confirm']) {
    assert.match(read('pages/' + p + '.wxml').match(/<checkout-benefits\b[\s\S]*?\/>/)[0], /other-discount="{{otherDiscount}}"/)
  }
})
test('订单详情在自取优惠与优惠券之间显示满减快照', () => {
  const w = read('pages/order/detail.wxml')
  assert.match(w, /order\.promoDiscountAmount > 0/)
  assert.ok(w.indexOf('order.pickupDiscountAmount > 0') < w.indexOf('order.promoDiscountAmount > 0'))
  assert.ok(w.indexOf('order.promoDiscountAmount > 0') < w.indexOf('order.discountAmount > 0'))
  assert.match(read('pages/order/detail.js'), /promoDiscountAmountText/)
})
test('购物车页同一固定容器内展示活动进度提示', () => {
  assert.match(read('pages/cart/index.wxml'), /class="cart-tip/)
})
// 统筹裁定 Q3（2026-09-21）：满减关闭时购物车 tabBar 页原先直接 promoTip:{show:false}，
// 不经 progressTipOf，免运费进度也跟着消失——补齐与主页/分类页结算条一致的行为。
test('购物车页满减关闭时仍经 progressTipOf 显示免运费进度，且不发满减预览请求', async () => {
  const vm = require('node:vm')
  let config
  const file = path.join(__dirname, '../../apps/miniapp/pages/cart/index.js')
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    require: dep => {
      if (dep === '../../api/cart') return { getCart: () => Promise.resolve({ items: [] }), updateCartItem: () => Promise.resolve(), deleteCartItem: () => Promise.resolve() }
      if (dep === '../../api/local') return { getLocalMeta: () => Promise.resolve({}), getPromoPreview: () => { throw new Error('must not request') } }
      if (dep === '../../utils/format') return { formatPrice: v => String(v) }
      return require(path.resolve(path.dirname(file), dep))
    },
    Page: c => { config = c }, getApp: () => ({}), wx: {}, console,
  })
  config.data = structuredClone(config.data)
  config.setData = function(p) { Object.assign(this.data, p) }
  Object.assign(config.data, {
    channel: 'LOCAL',
    mode: 'DELIVERY',
    selectedCount: 2,
    totalAmount: 3800,
    promotion: { active: false },
    meta: { radiusKm: 8, fee: { freeShipTiers: [{ minAmountFen: 5800, maxKm: 2 }] } },
  })
  await config.loadPromo()
  assert.equal(config.data.promoTip.show, true)
  assert.equal(config.data.promoTip.text, '再买 ¥20 免运费（2 km 内）')
})
// M12（复审建议，纳入本批）：满减预览请求失败时原来直接 promoTip:{show:false}，
// 把免运费进度也一并清掉了——与上面 Q3 裁定的「满减关闭」分支（经 progressTipOf(null,
// opts) 走一遍）不一致，同一个免运费进度会因为一次网络抖动而消失又重新出现。
test('T12 M12：满减预览请求失败时仍经 progressTipOf(null, opts) 显示免运费进度', async () => {
  const vm = require('node:vm')
  let config
  const file = path.join(__dirname, '../../apps/miniapp/pages/cart/index.js')
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    require: dep => {
      if (dep === '../../api/cart') return { getCart: () => Promise.resolve({ items: [] }), updateCartItem: () => Promise.resolve(), deleteCartItem: () => Promise.resolve() }
      if (dep === '../../api/local') return { getLocalMeta: () => Promise.resolve({}), getPromoPreview: () => Promise.reject(new Error('down')) }
      if (dep === '../../utils/format') return { formatPrice: v => String(v) }
      return require(path.resolve(path.dirname(file), dep))
    },
    Page: c => { config = c }, getApp: () => ({}), wx: {}, console,
  })
  config.data = structuredClone(config.data)
  config.setData = function(p) { Object.assign(this.data, p) }
  Object.assign(config.data, {
    channel: 'LOCAL',
    mode: 'DELIVERY',
    selectedCount: 2,
    totalAmount: 3800,
    promotion: { active: true, channels: {} },
    meta: { radiusKm: 8, fee: { freeShipTiers: [{ minAmountFen: 5800, maxKm: 2 }] } },
  })
  await config.loadPromo()
  assert.equal(config.data.promoTip.show, true, '请求失败不该把免运费进度也清掉')
  assert.equal(config.data.promoTip.text, '再买 ¥20 免运费（2 km 内）')
})

// 02 复核（2026-09-21）：分类页整页滚动的几何值算得再对，页面不把它们绑到节点上就是空转。
// 这三条锁住 WXML/WXSS 侧的契约——改坏绑定必须变红。
test('分类页把算好的尾部补白与左栏吸顶几何真正绑到节点上', () => {
  const wxml = read('pages/product/list.wxml')
  assert.match(wxml, /class="group-tail"[^>]*style="[^"]*height:\s*\{\{tailHeight\}\}px/)
  assert.match(wxml, /class="cat-panel"[^>]*style="[^"]*top:\s*\{\{pinnedHeight\}\}px[^"]*height:\s*\{\{sidebarHeight\}\}px/)
  assert.match(read('pages/product/list.wxss'), /\.cat-panel\s*\{[^}]*position:\s*sticky/)
})
