// 打烊／午休预约提示 + 主页渠道标识（2026-09-23）行为锁。
//
// 覆盖四件事：① 主页渠道切换弹层（onPickChannel/openChannelSheet/closeChannelSheet）；
// ② 新组件 channel-sheet 自身的事件转发；③ 主页/分类页 wxml、json 的源码级接线；
// ④ computeNavBar 矩阵——门店头永远不被右上角胶囊压住，任何机型都成立。
//
// 夹具照 tests/miniapp/channel-badge-page.test.cjs 的 loadPage/makeCtx：同一套 wx.request
// 桩（按 URL 分派 categories/products/local/meta）、同一套 app 桩（含 gateLocalChannel）。
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')

const promotion = { active: true, name: '秋日满减', channels: { LOCAL: true, PICKUP: false, EXPRESS: true }, tiers: [{ minFen: 5000, cutFen: 500 }] }
const meta = { enabled: false, paused: { reason: '暂停外送' }, pickup: { enabled: false }, promotion }

function loadPage(relPath, ctx) {
  Object.keys(require.cache)
    .filter((k) => k.includes(path.join('apps', 'miniapp')))
    .forEach((k) => delete require.cache[k])
  let registered = null
  global.Page = (o) => { registered = o }
  global.Component = (o) => { registered = o }
  global.getApp = () => ctx.app
  global.wx = ctx.wx
  require(relPath)
  registered.data = Object.assign({}, registered.data)
  registered.setData = function (patch) { Object.assign(registered.data, patch) }
  registered.selectComponent = () => null
  return registered
}

function makeCtx(channel, opts) {
  const urls = []
  const calls = []
  const app = {
    globalData: { shoppingChannel: channel, pendingCategoryId: null, pendingCategoryName: null, pendingCategoryAll: false },
    getShoppingChannel: () => app.globalData.shoppingChannel,
    setShoppingChannel: (v) => { app.globalData.shoppingChannel = v; return v },
    getLocalMode: () => app.globalData.localMode || 'DELIVERY',
    setLocalMode: (v) => { app.globalData.localMode = v; return v },
    gateLocalChannel: () => {
      calls.push('gate')
      const ok = !opts || opts.gateOk !== false
      if (ok) app.globalData.shoppingChannel = 'LOCAL'
      return Promise.resolve(ok)
    },
    applyCartBadge() {}, updateCartCount() {},
  }
  const wx = {
    getStorageSync: () => '',
    setStorageSync: () => {},
    request: (o) => {
      urls.push(o.url.replace(/^https?:\/\/[^/]+(\/api)?/, ''))
      const body = /\/categories/.test(o.url) ? [] : /\/products/.test(o.url) ? { list: [], total: 0 } : /\/local\/meta/.test(o.url) ? meta : {}
      o.success({ statusCode: 200, data: { code: 0, message: 'ok', data: body } })
    },
    getWindowInfo: () => ({ windowWidth: 375, windowHeight: 812, statusBarHeight: 44 }),
    getSystemInfoSync: () => ({ windowWidth: 375, windowHeight: 812, statusBarHeight: 44 }),
    getMenuButtonBoundingClientRect: () => ({ top: 48, height: 32, left: 280 }),
    stopPullDownRefresh() {}, showToast() {}, switchTab() {}, navigateTo() {}, reLaunch() {},
    showNavigationBarLoading() {}, hideNavigationBarLoading() {},
    nextTick: (fn) => setTimeout(fn, 0),
    pageScrollTo() {},
    createSelectorQuery: () => {
      const selections = []
      let current
      const q = {
        in: () => q,
        selectViewport: () => { current = 'viewport'; return q },
        select: s => { current = s; return q }, selectAll: s => { current = s; return q },
        boundingClientRect: () => { selections.push(['rect', current]); return q },
        scrollOffset: () => { selections.push(['scroll', current]); return q },
        exec: cb => cb(selections[0] && selections[0][1] === 'viewport'
          ? selections.map(([kind, s]) => kind === 'scroll' ? { scrollTop: 0 } : s === '.catalog-toolbar' ? { top: 0, height: 40 } : s === '.catalog-body' ? { top: 100, height: 600 } : s === '.cat-panel' ? { top: 100, height: 600 } : s === '.group-anchor' || s === '.cat-item' ? [] : null)
          : [{ top: 0, height: 600 }, { scrollTop: 0 }, []]),
      }
      return q
    },
  }
  return { app, wx, urls, calls }
}

const settle = () => new Promise((r) => setTimeout(r, 0))
const has = (urls, frag) => urls.some((u) => u.indexOf(frag) !== -1)

// ── 主页渠道切换 ────────────────────────────────────────────────────────

test('主页 onPickChannel(EXPRESS)：定渠道、重载本页拉邮寄货，弹层关闭', async function () {
  const ctx = makeCtx('LOCAL')
  const page = loadPage('../../apps/miniapp/pages/index/index.js', ctx)
  page.onLoad.call(page, {})
  await settle(); await settle()
  page.openChannelSheet.call(page)
  ctx.urls.length = 0
  page.onPickChannel.call(page, { detail: { channel: 'EXPRESS' } })
  await settle(); await settle()
  assert.equal(ctx.app.globalData.shoppingChannel, 'EXPRESS')
  assert.ok(has(ctx.urls, '/categories?channel=EXPRESS'), ctx.urls.join(' '))
  assert.equal(page.data.channelSheetOpen, false)
})

test('主页同城态 onPickChannel(LOCAL)：目标就是当前渠道，不发请求、不过门，只关弹层', async function () {
  const ctx = makeCtx('LOCAL')
  const page = loadPage('../../apps/miniapp/pages/index/index.js', ctx)
  page.onLoad.call(page, {})
  await settle(); await settle()
  page.openChannelSheet.call(page)
  ctx.urls.length = 0
  page.onPickChannel.call(page, { detail: { channel: 'LOCAL' } })
  await settle()
  assert.deepEqual(ctx.urls, [])
  assert.deepEqual(ctx.calls, [])
  assert.equal(page.data.channelSheetOpen, false)
})

test('主页邮寄态 onPickChannel(LOCAL，门放行)：过门后拉同城货', async function () {
  const ctx = makeCtx('EXPRESS', { gateOk: true })
  const page = loadPage('../../apps/miniapp/pages/index/index.js', ctx)
  page.onLoad.call(page, {})
  await settle(); await settle()
  ctx.urls.length = 0
  page.onPickChannel.call(page, { detail: { channel: 'LOCAL' } })
  await settle(); await settle()
  assert.ok(ctx.calls.indexOf('gate') !== -1, ctx.calls.join(' '))
  assert.ok(has(ctx.urls, '/categories?channel=LOCAL'), ctx.urls.join(' '))
})

test('主页 openChannelSheet / closeChannelSheet：切换 channelSheetOpen；noop 存在且可调用', function () {
  const ctx = makeCtx('LOCAL')
  const page = loadPage('../../apps/miniapp/pages/index/index.js', ctx)
  assert.equal(page.data.channelSheetOpen, false)
  page.openChannelSheet.call(page)
  assert.equal(page.data.channelSheetOpen, true)
  page.closeChannelSheet.call(page)
  assert.equal(page.data.channelSheetOpen, false)
  assert.equal(typeof page.noop, 'function')
  assert.doesNotThrow(function () { page.noop.call(page) })
})

// ── 组件 channel-sheet ──────────────────────────────────────────────────

test('组件 channel-sheet：onPick 按 dataset.channel 触发 pick；onClose 触发 close；noop 可调用', function () {
  const ctx = makeCtx('LOCAL')
  const sheet = loadPage('../../apps/miniapp/components/channel-sheet/index.js', ctx)
  const events = []
  sheet.triggerEvent = function (name, detail) { events.push([name, detail]) }
  Object.keys(sheet.methods).forEach(function (k) { sheet[k] = sheet.methods[k] })
  sheet.onPick({ currentTarget: { dataset: { channel: 'EXPRESS' } } })
  assert.equal(events.length, 1)
  assert.equal(events[0][0], 'pick')
  assert.equal(events[0][1].channel, 'EXPRESS')
  sheet.onClose()
  assert.equal(events[1][0], 'close')
  assert.equal(typeof sheet.noop, 'function')
  assert.doesNotThrow(function () { sheet.noop() })
})

// ── 源码级接线 ──────────────────────────────────────────────────────────

const MINIAPP = path.join(__dirname, '../../apps/miniapp')
const read = (p) => fs.readFileSync(path.join(MINIAPP, p), 'utf8')

test('源码级：主页 local-store-header 传 channel 与 bind:switchchannel；channel-sheet 在 local-cart-bar 之后', function () {
  const wxml = read('pages/index/index.wxml')
  const headerMatch = wxml.match(/<local-store-header\b[^>]*>/)
  assert.ok(headerMatch, 'local-store-header 标签未找到')
  assert.match(headerMatch[0], /channel="\{\{channel\}\}"/)
  assert.match(headerMatch[0], /bind:switchchannel="openChannelSheet"/)
  assert.match(wxml, /<channel-sheet\b/)
  const cartBarIdx = wxml.indexOf('<local-cart-bar')
  const sheetIdx = wxml.indexOf('<channel-sheet')
  assert.ok(cartBarIdx !== -1 && sheetIdx !== -1 && sheetIdx > cartBarIdx,
    'channel-sheet 必须排在 local-cart-bar 之后：cartBarIdx=' + cartBarIdx + ' sheetIdx=' + sheetIdx)
})

test('源码级：分类页 list.wxml 含 channel-sheet，不再含内联的 channel-mask 弹层', function () {
  const wxml = read('pages/product/list.wxml')
  assert.match(wxml, /<channel-sheet\b/)
  assert.equal(wxml.indexOf('class="channel-mask"'), -1)
})

test('源码级：index.json 与 list.json 的 usingComponents 都登记了 channel-sheet', function () {
  const indexJson = JSON.parse(read('pages/index/index.json'))
  const listJson = JSON.parse(read('pages/product/list.json'))
  assert.equal(indexJson.usingComponents['channel-sheet'], '/components/channel-sheet/index')
  assert.equal(listJson.usingComponents['channel-sheet'], '/components/channel-sheet/index')
})

test('源码级：主页区块标题改为「今日推荐」，不再是「今日现拌」', function () {
  const wxml = read('pages/index/index.wxml')
  assert.match(wxml, /今日推荐/)
  assert.equal(wxml.indexOf('今日现拌'), -1)
})

// ── computeNavBar 矩阵：门店头永远不被胶囊压住（不同机型） ──────────────────

function computeNavBar(statusBarHeight, menu) {
  // 与 pages/index/index.js 的 computeNavBar 同一公式，供矩阵直接调用而不必走整页 onLoad。
  var navContent = 44
  if (menu && menu.height && menu.top >= statusBarHeight) {
    navContent = (menu.top - statusBarHeight) * 2 + menu.height
  }
  return { navContent: navContent, navTotal: statusBarHeight + navContent }
}

test('computeNavBar：胶囊下沿永远不低于导航栏下沿（矩阵覆盖多机型 + 守卫不成立 + 拿不到胶囊）', function () {
  var cases = [
    { statusBarHeight: 44, menu: { top: 48, height: 32 } },  // 刘海机
    { statusBarHeight: 20, menu: { top: 24, height: 32 } },  // 非刘海机
    { statusBarHeight: 24, menu: { top: 30, height: 32 } },
    { statusBarHeight: 20, menu: { top: 26, height: 32 } },
    { statusBarHeight: 44, menu: { top: 40, height: 32 } },  // 守卫不成立（top < statusBarHeight）
  ]
  cases.forEach(function (c) {
    var r = computeNavBar(c.statusBarHeight, c.menu)
    assert.ok(r.navTotal >= c.menu.top + c.menu.height,
      'navTotal=' + r.navTotal + ' 应 >= ' + (c.menu.top + c.menu.height) + '（案例 ' + JSON.stringify(c) + '）')
  })
  // 拿不到胶囊信息（旧客户端/桩返回 null）：退回 44 常量
  var fallback = computeNavBar(20, null)
  assert.equal(fallback.navTotal, 20 + 44)
})

test('computeNavBar：与页面里实跑一致（通过 onLoad 触发真实 computeNavBar，走真实分支）', async function () {
  const ctx = makeCtx('LOCAL')
  ctx.wx.getMenuButtonBoundingClientRect = () => ({ top: 48, height: 32, left: 280 })
  ctx.wx.getWindowInfo = () => ({ windowWidth: 375, windowHeight: 812, statusBarHeight: 44 })
  const page = loadPage('../../apps/miniapp/pages/index/index.js', ctx)
  page.onLoad.call(page, {})
  await settle()
  assert.ok(page.data.navTotal >= 48 + 32, 'navTotal=' + page.data.navTotal)
  assert.equal(page.data.navTotal, page.data.statusBarHeight + page.data.navContent)
})

// ── .cart-tip 单行省略（购物车条 + 购物车页两处） ────────────────────────────

function cartTipBlock(css) {
  const m = css.match(/\.cart-tip\s*\{[^}]*\}/)
  return m ? m[0] : ''
}

test('源码级：local-cart-bar 与购物车页的 .cart-tip 都单行省略（nowrap + hidden + ellipsis）', function () {
  const barCss = cartTipBlock(read('components/local-cart-bar/index.wxss'))
  const cartCss = cartTipBlock(read('pages/cart/index.wxss'))
  ;[barCss, cartCss].forEach(function (block) {
    assert.match(block, /white-space:\s*nowrap/)
    assert.match(block, /overflow:\s*hidden/)
    assert.match(block, /text-overflow:\s*ellipsis/)
  })
})
