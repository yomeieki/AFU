// 主页落地行为锁：分享链接带 ?channel=LOCAL|EXPRESS 落到主页之后，onLoad/onReady/onShow
// 要怎么把渠道落地。
//
// 同城比邮寄多一步「过门」（app.gateLocalChannel，位置许可 → 定渠道）。这道门是异步的，
// 还会经隐私授权弹层——授权弹层是 app.js 的 onNeedPrivacyAuthorization 通过
// getCurrentPages() 取末页 selectComponent('#privacy-popup') 找到的（app.js:56-61），
// onLoad 那一刻本页刚开始渲染，取不到自己的弹层组件，找不到会静默 disagree。
// 所以主页把「开门」推迟到 onReady（首屏已渲染完），onLoad 只记一个待开门标记。
//
// 桩法沿用 tests/miniapp/channel-pages.test.cjs 的 makeCtx：打桩在 wx.request 上，
// 让真实的 utils/request、api/catalog 都跑起来，断言的是「实际发出去的 URL」，
// 不是页面 data——这样才能把「页面忘了传 channel」这一类错误测出来。
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

var meta = { enabled: true, paused: null, pickup: { enabled: true }, promotion: null }

function loadPage(relPath, ctx) {
  Object.keys(require.cache)
    .filter(function (k) { return k.indexOf(path.join('apps', 'miniapp')) !== -1 })
    .forEach(function (k) { delete require.cache[k] })
  var registered = null
  global.Page = function (o) { registered = o }
  global.Component = function (o) { registered = o }
  global.getApp = function () { return ctx.app }
  global.wx = ctx.wx
  global.getCurrentPages = function () { return [] }
  require(relPath)
  registered.data = Object.assign({}, registered.data)
  registered.setData = function (patch) { Object.assign(registered.data, patch) }
  registered.selectComponent = function () { return null }
  return registered
}

/** deferred gate：resolve/reject 由用例自己按时机触发，模拟位置许可弹层悬而未决。 */
function makeDeferred() {
  var resolve, reject
  var promise = new Promise(function (res, rej) { resolve = res; reject = rej })
  return { promise: promise, resolve: resolve, reject: reject }
}

function makeCtx(channel, gate) {
  var urls = []
  var gateCalls = 0
  var app = {
    globalData: { shoppingChannel: channel, pendingCategoryId: null, pendingCategoryName: null, pendingCategoryAll: false },
    getShoppingChannel: function () { return app.globalData.shoppingChannel },
    setShoppingChannel: function (v) { app.globalData.shoppingChannel = v; return v },
    getLocalMode: function () { return app.globalData.localMode || 'DELIVERY' },
    setLocalMode: function (v) { app.globalData.localMode = v; return v },
    applyCartBadge: function () {},
    updateCartCount: function () {},
    // 真实 app.gateLocalChannel()（app.js:145-159）在 resolve(true) 之前会先
    // self.setShoppingChannel('LOCAL')——渠道已经切好了才通知调用方「门开了」。
    // 桩要复刻这个契约，否则本文件测的就不是「主页怎么用 gateLocalChannel()」，
    // 而是一个跟真实实现脱节的假页面。resolve(false) 与 reject 都不该切渠道。
    gateLocalChannel: function () {
      gateCalls++
      return gate.promise.then(function (ok) {
        if (ok) app.setShoppingChannel('LOCAL')
        return ok
      })
    },
  }
  var wx = {
    getStorageSync: function () { return '' },
    setStorageSync: function () {},
    request: function (o) {
      urls.push(o.url.replace(/^https?:\/\/[^/]+(\/api)?/, ''))
      var body = /\/categories/.test(o.url) ? [] : /\/products/.test(o.url) ? { list: [], total: 0 } : /\/local\/meta/.test(o.url) ? meta : {}
      o.success({ statusCode: 200, data: { code: 0, message: 'ok', data: body } })
    },
    getWindowInfo: function () { return { windowWidth: 375, windowHeight: 812, statusBarHeight: 44 } },
    getSystemInfoSync: function () { return { windowWidth: 375, windowHeight: 812, statusBarHeight: 44 } },
    getMenuButtonBoundingClientRect: function () { return { top: 48, height: 32 } },
    stopPullDownRefresh: function () {},
    showToast: function () {},
    switchTab: function () {},
    navigateTo: function () {},
    reLaunch: function () {},
  }
  return {
    app: app,
    wx: wx,
    urls: urls,
    gateCallCount: function () { return gateCalls },
  }
}

var settle = function () { return new Promise(function (r) { setTimeout(r, 0) }) }
var has = function (urls, frag) { return urls.some(function (u) { return u.indexOf(frag) !== -1 }) }

// 模拟真实小程序生命周期：onLoad → onShow → onReady。
function boot(page, options) {
  page.onLoad.call(page, options)
  if (typeof page.onShow === 'function') page.onShow.call(page)
  if (typeof page.onReady === 'function') page.onReady.call(page)
}

test('落地 LOCAL，gate 悬而未决期间不发任何 /categories /products 请求', async function () {
  var gate = makeDeferred()
  var ctx = makeCtx('EXPRESS', gate)
  var page = loadPage('../../apps/miniapp/pages/index/index.js', ctx)
  boot(page, { channel: 'LOCAL' })
  await settle(); await settle()
  assert.ok(!has(ctx.urls, '/categories'), 'gate 未决时不该拉分类：' + ctx.urls.join(' '))
  assert.ok(!has(ctx.urls, '/products'), 'gate 未决时不该拉商品：' + ctx.urls.join(' '))
  assert.equal(ctx.gateCallCount(), 1)
})

test('落地 LOCAL，gate resolve(true)：请求全带 channel=LOCAL，loading 收尾，gate 只调一次', async function () {
  var gate = makeDeferred()
  var ctx = makeCtx('EXPRESS', gate)
  var page = loadPage('../../apps/miniapp/pages/index/index.js', ctx)
  boot(page, { channel: 'LOCAL' })
  gate.resolve(true)
  await settle(); await settle(); await settle()
  assert.ok(has(ctx.urls, '/categories?channel=LOCAL'), ctx.urls.join(' '))
  assert.ok(has(ctx.urls, '/products?channel=LOCAL'), ctx.urls.join(' '))
  assert.ok(!has(ctx.urls, 'channel=EXPRESS'), '不该混进邮寄请求：' + ctx.urls.join(' '))
  assert.equal(page.data.loading, false)
  assert.equal(ctx.gateCallCount(), 1)
  assert.equal(ctx.app.getShoppingChannel(), 'LOCAL')
})

test('落地 LOCAL，gate resolve(false)：落回 EXPRESS，请求全带 channel=EXPRESS，不带 LOCAL', async function () {
  var gate = makeDeferred()
  var ctx = makeCtx('EXPRESS', gate)
  var page = loadPage('../../apps/miniapp/pages/index/index.js', ctx)
  boot(page, { channel: 'LOCAL' })
  gate.resolve(false)
  await settle(); await settle(); await settle()
  assert.ok(has(ctx.urls, '/categories?channel=EXPRESS'), ctx.urls.join(' '))
  assert.ok(has(ctx.urls, '/products?channel=EXPRESS'), ctx.urls.join(' '))
  assert.ok(!has(ctx.urls, 'channel=LOCAL'), '拒绝许可后不该留下同城请求：' + ctx.urls.join(' '))
  assert.equal(page.data.loading, false)
  assert.equal(ctx.app.getShoppingChannel(), 'EXPRESS')
})

test('落地 LOCAL，gate reject：仍要走到 EXPRESS 加载完成，不能卡死在待开门状态', async function () {
  var gate = makeDeferred()
  var ctx = makeCtx('EXPRESS', gate)
  var page = loadPage('../../apps/miniapp/pages/index/index.js', ctx)
  boot(page, { channel: 'LOCAL' })
  gate.reject(new Error('位置许可请求失败'))
  await settle(); await settle(); await settle()
  assert.ok(has(ctx.urls, '/categories?channel=EXPRESS'), ctx.urls.join(' '))
  assert.ok(has(ctx.urls, '/products?channel=EXPRESS'), ctx.urls.join(' '))
  assert.equal(page.data.loading, false)
  assert.equal(ctx.app.getShoppingChannel(), 'EXPRESS')
})

test('落地 EXPRESS 且桩 app 当前渠道为 LOCAL：不调 gate，直接定渠道 EXPRESS 后加载', async function () {
  var gate = makeDeferred()
  var ctx = makeCtx('LOCAL', gate)
  var page = loadPage('../../apps/miniapp/pages/index/index.js', ctx)
  boot(page, { channel: 'EXPRESS' })
  await settle(); await settle()
  assert.equal(ctx.gateCallCount(), 0, '邮寄不需要过门')
  assert.equal(ctx.app.getShoppingChannel(), 'EXPRESS')
  assert.ok(has(ctx.urls, '/categories?channel=EXPRESS'), ctx.urls.join(' '))
  assert.ok(has(ctx.urls, '/products?channel=EXPRESS'), ctx.urls.join(' '))
  assert.equal(page.data.loading, false)
})

// 无分享参数 / 参数不认识（缺参、大小写不对）：不是一次分享落地，按现有渠道正常加载，
// 不碰渠道、不过门。
;[
  ['{}', {}],
  ['()', undefined],
  ["{channel:'foo'}", { channel: 'foo' }],
  ["{channel:'local'}", { channel: 'local' }],
].forEach(function (pair) {
  var label = pair[0]
  var options = pair[1]
  test('onLoad' + label + ' 且当前渠道 LOCAL：不调 gate、不定渠道，按现有渠道（LOCAL）加载', async function () {
    var gate = makeDeferred()
    var ctx = makeCtx('LOCAL', gate)
    var page = loadPage('../../apps/miniapp/pages/index/index.js', ctx)
    boot(page, options)
    await settle(); await settle()
    assert.equal(ctx.gateCallCount(), 0, label + ' 不应过门')
    assert.ok(has(ctx.urls, '/categories?channel=LOCAL'), label + ' -> ' + ctx.urls.join(' '))
    assert.ok(has(ctx.urls, '/products?channel=LOCAL'), label + ' -> ' + ctx.urls.join(' '))
    assert.ok(!has(ctx.urls, 'channel=EXPRESS'), label + ' 不该混进邮寄请求：' + ctx.urls.join(' '))
    assert.equal(page.data.loading, false)
  })
})

// ── 热启动分享落地（R1，2026-09-23 规划裁决）─────────────────────────────────
//
// 主页是 tabBar 页，热启动大概率不会重新执行 onLoad——分享/扫码带来的入口参数
// 只保证经 wx.onAppShow 送达，页面自己在监听里记一个「待处理渠道」，onShow 消费。
// 每次 wx.onAppShow 触发都可能是「真的一次新入口」，也可能是同一次入口的回声
// （尤其 Android 从桌面切回前台），所以要能在同一个页面实例上多次触发监听、
// 多次独立地过门——makeCtx() 的单次 deferred 不够用，这里另起一个支持「排队、
// 逐次 resolve/reject」的 gate 桩，外加 wx.onAppShow/offAppShow。
function makeMultiGateCtx(channel) {
  var urls = []
  var pendingGates = []
  var gateCalls = 0
  var appShowListeners = []
  var lastOnAppShowCb = null
  var lastOffAppShowCb = null
  var app = {
    globalData: { shoppingChannel: channel, pendingCategoryId: null, pendingCategoryName: null, pendingCategoryAll: false },
    getShoppingChannel: function () { return app.globalData.shoppingChannel },
    setShoppingChannel: function (v) { app.globalData.shoppingChannel = v; return v },
    getLocalMode: function () { return app.globalData.localMode || 'DELIVERY' },
    setLocalMode: function (v) { app.globalData.localMode = v; return v },
    applyCartBadge: function () {},
    updateCartCount: function () {},
    // 与 makeCtx 里的注释同一个契约：resolve(true) 之前先切好渠道再通知调用方。
    // 这里每次调用都开一条新的悬而未决的 Promise（真实 gateLocalChannel 每次调用
    // 也是一次新的 ensurePrivacyAuthorize()），交给测试用 resolveNextGate/
    // rejectNextGate 按调用顺序逐个裁决。
    gateLocalChannel: function () {
      gateCalls++
      return new Promise(function (resolve, reject) {
        pendingGates.push({ resolve: resolve, reject: reject })
      }).then(function (ok) {
        if (ok) app.setShoppingChannel('LOCAL')
        return ok
      })
    },
  }
  var wx = {
    getStorageSync: function () { return '' },
    setStorageSync: function () {},
    request: function (o) {
      urls.push(o.url.replace(/^https?:\/\/[^/]+(\/api)?/, ''))
      var body = /\/categories/.test(o.url) ? [] : /\/products/.test(o.url) ? { list: [], total: 0 } : /\/local\/meta/.test(o.url) ? meta : {}
      o.success({ statusCode: 200, data: { code: 0, message: 'ok', data: body } })
    },
    getWindowInfo: function () { return { windowWidth: 375, windowHeight: 812, statusBarHeight: 44 } },
    getSystemInfoSync: function () { return { windowWidth: 375, windowHeight: 812, statusBarHeight: 44 } },
    getMenuButtonBoundingClientRect: function () { return { top: 48, height: 32 } },
    stopPullDownRefresh: function () {},
    showToast: function () {},
    switchTab: function () {},
    navigateTo: function () {},
    reLaunch: function () {},
    onAppShow: function (cb) { appShowListeners.push(cb); lastOnAppShowCb = cb },
    offAppShow: function (cb) {
      lastOffAppShowCb = cb
      var idx = appShowListeners.indexOf(cb)
      if (idx !== -1) appShowListeners.splice(idx, 1)
    },
  }
  return {
    app: app,
    wx: wx,
    urls: urls,
    gateCallCount: function () { return gateCalls },
    resolveNextGate: function (ok) { var g = pendingGates.shift(); if (g) g.resolve(ok) },
    rejectNextGate: function (err) { var g = pendingGates.shift(); if (g) g.reject(err) },
    fireAppShow: function (opts) { appShowListeners.slice().forEach(function (cb) { cb(opts) }) },
    listenerCount: function () { return appShowListeners.length },
    lastOnAppShowCb: function () { return lastOnAppShowCb },
    lastOffAppShowCb: function () { return lastOffAppShowCb },
  }
}

// 冷启动阶段的普通三步（无分享参数），用来把页面「跑起来」到正常展示状态，
// 再在这个已经跑起来的实例上模拟热启动事件。
function bootPlain(page) {
  page.onLoad.call(page, {})
  page.onReady.call(page)
  page.onShow.call(page)
}

test('热启动带 LOCAL：resolve(true) 后请求全带 channel=LOCAL，gate 只调一次', async function () {
  var ctx = makeMultiGateCtx('EXPRESS')
  var page = loadPage('../../apps/miniapp/pages/index/index.js', ctx)
  bootPlain(page)
  await settle(); await settle()
  assert.ok(has(ctx.urls, '/categories?channel=EXPRESS'), '初次冷启动应按 EXPRESS 加载：' + ctx.urls.join(' '))

  ctx.urls.length = 0
  ctx.fireAppShow({ path: 'pages/index/index', query: { channel: 'LOCAL' } })
  page.onShow.call(page)
  assert.equal(ctx.gateCallCount(), 1)
  ctx.resolveNextGate(true)
  await settle(); await settle(); await settle()
  assert.ok(has(ctx.urls, '/categories?channel=LOCAL'), ctx.urls.join(' '))
  assert.ok(has(ctx.urls, '/products?channel=LOCAL'), ctx.urls.join(' '))
  assert.ok(!has(ctx.urls, 'channel=EXPRESS'), '不该混进邮寄请求：' + ctx.urls.join(' '))
  assert.equal(page.data.loading, false)
  assert.equal(ctx.gateCallCount(), 1)
  assert.equal(ctx.app.getShoppingChannel(), 'LOCAL')
})

test('热启动带 LOCAL：resolve(false) 落回 EXPRESS，setShoppingChannel(EXPRESS) 被调用', async function () {
  var ctx = makeMultiGateCtx('EXPRESS')
  var page = loadPage('../../apps/miniapp/pages/index/index.js', ctx)
  bootPlain(page)
  await settle(); await settle()

  ctx.urls.length = 0
  ctx.fireAppShow({ path: 'pages/index/index', query: { channel: 'LOCAL' } })
  page.onShow.call(page)
  ctx.resolveNextGate(false)
  await settle(); await settle(); await settle()
  assert.ok(has(ctx.urls, '/categories?channel=EXPRESS'), ctx.urls.join(' '))
  assert.ok(has(ctx.urls, '/products?channel=EXPRESS'), ctx.urls.join(' '))
  assert.ok(!has(ctx.urls, 'channel=LOCAL'), '拒绝许可后不该留下同城请求：' + ctx.urls.join(' '))
  assert.equal(page.data.loading, false)
  assert.equal(ctx.app.getShoppingChannel(), 'EXPRESS')
})

test('热启动带 EXPRESS（桩 app 当前为 LOCAL）：不调 gate，setShoppingChannel(EXPRESS) 被调用，请求带 EXPRESS', async function () {
  var ctx = makeMultiGateCtx('LOCAL')
  var page = loadPage('../../apps/miniapp/pages/index/index.js', ctx)
  bootPlain(page)
  await settle(); await settle()
  assert.ok(has(ctx.urls, '/categories?channel=LOCAL'), '初次冷启动应按 LOCAL 加载：' + ctx.urls.join(' '))

  ctx.urls.length = 0
  ctx.fireAppShow({ path: 'pages/index/index', query: { channel: 'EXPRESS' } })
  page.onShow.call(page)
  await settle(); await settle()
  assert.equal(ctx.gateCallCount(), 0, '邮寄不需要过门')
  assert.equal(ctx.app.getShoppingChannel(), 'EXPRESS')
  assert.ok(has(ctx.urls, '/categories?channel=EXPRESS'), ctx.urls.join(' '))
  assert.ok(has(ctx.urls, '/products?channel=EXPRESS'), ctx.urls.join(' '))
  assert.equal(page.data.loading, false)
})

// Android 回声去重：同一个 (path, channel) 入口在同一个页面实例上被 wx.onAppShow
// 重复送达（切回前台时保留上一次的 scene），不能被当成「又一次新的分享落地」
// 重放一遍——否则顾客每次从桌面切回小程序都会被重新问一次位置许可。
test('Android 回声去重：同一入口重复触发不重放，换一个不同的入口才会再触发', async function () {
  var ctx = makeMultiGateCtx('EXPRESS')
  var page = loadPage('../../apps/miniapp/pages/index/index.js', ctx)

  // 冷启动本身就是一次带 LOCAL 的分享落地：onLoad 记住这个入口，onReady 开门。
  page.onLoad.call(page, { channel: 'LOCAL' })
  page.onReady.call(page)
  ctx.resolveNextGate(true)
  await settle(); await settle(); await settle()
  page.onShow.call(page)
  await settle(); await settle()
  assert.ok(has(ctx.urls, '/categories?channel=LOCAL'), '冷启动分享落地应加载 LOCAL：' + ctx.urls.join(' '))
  assert.equal(ctx.gateCallCount(), 1)

  // 店员/顾客后来手动切回邮寄（比如「我的」页的渠道入口）。
  ctx.urls.length = 0
  ctx.app.setShoppingChannel('EXPRESS')
  page.onShow.call(page)
  await settle(); await settle()
  assert.ok(has(ctx.urls, '/categories?channel=EXPRESS'), '手动切回邮寄应重新加载：' + ctx.urls.join(' '))

  // Android 切回前台：wx.onAppShow 把这次冷启动本身的入口（path+channel 都没变）
  // 又送了一遍——必须判成回声，不能再切一次渠道、不能再过一次门。
  ctx.urls.length = 0
  ctx.fireAppShow({ path: 'pages/index/index', query: { channel: 'LOCAL' }, scene: 1007 })
  page.onShow.call(page)
  await settle(); await settle()
  assert.equal(ctx.gateCallCount(), 1, '回声不该再触发一次过门')
  assert.equal(ctx.app.getShoppingChannel(), 'EXPRESS', '回声不该把渠道切回同城')
  assert.ok(!has(ctx.urls, 'channel=LOCAL'), '回声不该产生新的同城请求：' + ctx.urls.join(' '))

  // 换一个不同的入口（这次没带 channel）先「打断」一次，证明去重认的是
  // 「跟上一条记录的键不一样」，不是「以后再也不认同城了」。
  ctx.urls.length = 0
  ctx.fireAppShow({ path: 'pages/index/index', query: {} })
  page.onShow.call(page)
  await settle(); await settle()
  assert.equal(ctx.gateCallCount(), 1, '空 channel 不该触发过门')
  assert.equal(ctx.app.getShoppingChannel(), 'EXPRESS')

  // 再来一次真正「新的」LOCAL 入口：这次要生效，gate 调用数变成 2。
  ctx.fireAppShow({ path: 'pages/index/index', query: { channel: 'LOCAL' } })
  page.onShow.call(page)
  assert.equal(ctx.gateCallCount(), 2, '打断之后的同城入口应该重新触发过门')
})

// ── R4：门未决期间到达的入口，由 gateThenLoad 的 settle 统一收口 ──────────────
//
// 复核实测的缺陷：onShow 的 _shareGate 短路只挡住了「门未决期间不重新加载」，
// 没挡住「_pendingEntryChannel 悄悄攒着，门开完之后随便哪次不相关的 onShow
// 才被拿出来执行」——顾客可能已经在做别的事，渠道却突然被静默切走，因果对不上。
// 修复：settle(ok) 里把 _pendingEntryChannel 取出并清空，跟 ok 一起决定最终渠道，
// 门开完那一刻就把账结清，不留尾巴给下一次 onShow。

test('R4a：门未决期间来一次 EXPRESS 入口，resolve(true) 后立即以 EXPRESS 收口；之后无关的 onShow 不再变动', async function () {
  var ctx = makeMultiGateCtx('EXPRESS')
  var page = loadPage('../../apps/miniapp/pages/index/index.js', ctx)

  page.onLoad.call(page, { channel: 'LOCAL' })
  page.onReady.call(page) // gate 挂起（_shareGate = true）
  ctx.fireAppShow({ path: 'pages/index/index', query: { channel: 'EXPRESS' } })
  page.onShow.call(page)  // 被 _shareGate 短路；pending 记为 EXPRESS，本次不消费
  assert.equal(ctx.gateCallCount(), 1, '这一步不该再触发一次过门')

  ctx.resolveNextGate(true)
  await settle(); await settle(); await settle()
  assert.equal(ctx.app.getShoppingChannel(), 'EXPRESS', '门未决期间最后一次入口是 EXPRESS，settle 后应以它收口')
  assert.ok(has(ctx.urls, '/categories?channel=EXPRESS'), ctx.urls.join(' '))
  assert.ok(has(ctx.urls, '/products?channel=EXPRESS'), ctx.urls.join(' '))
  assert.ok(!has(ctx.urls, 'channel=LOCAL'), '不该残留一批同城请求：' + ctx.urls.join(' '))
  assert.equal(page.data.loading, false)

  // 之后一次跟这次入口完全无关的 onShow：pending 已经在 settle 里被清空，
  // 不该再被拿出来执行——渠道不变，也不再过门。
  ctx.urls.length = 0
  page.onShow.call(page)
  await settle(); await settle()
  assert.equal(ctx.gateCallCount(), 1, '不该有第二次过门')
  assert.equal(ctx.app.getShoppingChannel(), 'EXPRESS')
})

test('R4b：门未决期间来一次 LOCAL 入口（先打断去重再记为新入口）→ resolve(false) 仍落到 EXPRESS，不再多问一次授权', async function () {
  var ctx = makeMultiGateCtx('EXPRESS')
  var page = loadPage('../../apps/miniapp/pages/index/index.js', ctx)

  page.onLoad.call(page, { channel: 'LOCAL' })
  page.onReady.call(page)
  assert.equal(ctx.gateCallCount(), 1)

  // 先打断一次去重（空 channel，跟 onLoad 记的入口不同键），下一条 LOCAL 入口
  // 才不会被当成跟 onLoad 那次一样的回声而被静默吞掉。
  ctx.fireAppShow({ path: 'pages/index/index', query: {} })
  ctx.fireAppShow({ path: 'pages/index/index', query: { channel: 'LOCAL' } })
  page.onShow.call(page) // 门仍未决，_shareGate 短路，不消费 pending
  assert.equal(ctx.gateCallCount(), 1, '门未决期间来的入口不该立刻再触发一次过门')

  ctx.resolveNextGate(false)
  await settle(); await settle(); await settle()
  assert.equal(ctx.app.getShoppingChannel(), 'EXPRESS', '拒绝许可应落到 EXPRESS，忽略门未决期间那条 LOCAL 入口')
  assert.equal(ctx.gateCallCount(), 1, '门刚问过同一个问题，不该为那条 LOCAL 入口再弹一次')
  assert.ok(has(ctx.urls, '/categories?channel=EXPRESS'), ctx.urls.join(' '))
  assert.ok(!has(ctx.urls, 'channel=LOCAL'), ctx.urls.join(' '))

  ctx.urls.length = 0
  page.onShow.call(page)
  await settle(); await settle()
  assert.equal(ctx.gateCallCount(), 1, '后续 onShow 不该再过门')
})

test('R4c：门未决期间来一次 EXPRESS 入口 → resolve(true) 仍以最后一次入口为准，落到 EXPRESS', async function () {
  var ctx = makeMultiGateCtx('EXPRESS')
  var page = loadPage('../../apps/miniapp/pages/index/index.js', ctx)

  page.onLoad.call(page, { channel: 'LOCAL' })
  page.onReady.call(page)
  ctx.fireAppShow({ path: 'pages/index/index', query: { channel: 'EXPRESS' } })
  page.onShow.call(page)

  ctx.resolveNextGate(true)
  await settle(); await settle(); await settle()
  assert.equal(ctx.app.getShoppingChannel(), 'EXPRESS', '门未决期间最后一次入口是 EXPRESS，即便许可通过也该以它收口')
  assert.equal(ctx.gateCallCount(), 1)
  assert.ok(has(ctx.urls, '/categories?channel=EXPRESS'), ctx.urls.join(' '))
  assert.ok(!has(ctx.urls, 'channel=LOCAL'), ctx.urls.join(' '))
})

test('onAppShow 带的是别的页面路径（非主页）：不当分享落地处理，不调 gate、不改渠道', async function () {
  var ctx = makeMultiGateCtx('EXPRESS')
  var page = loadPage('../../apps/miniapp/pages/index/index.js', ctx)
  bootPlain(page)
  await settle(); await settle()

  ctx.urls.length = 0
  ctx.fireAppShow({ path: 'pages/product/detail', query: { channel: 'LOCAL' } })
  page.onShow.call(page)
  await settle(); await settle()
  assert.equal(ctx.gateCallCount(), 0, '非主页入口不该触发过门')
  assert.equal(ctx.app.getShoppingChannel(), 'EXPRESS')
  assert.ok(!has(ctx.urls, 'channel=LOCAL'), ctx.urls.join(' '))
})

test('onAppShow 带前导斜杠的主页路径（/pages/index/index）视同主页', async function () {
  var ctx = makeMultiGateCtx('EXPRESS')
  var page = loadPage('../../apps/miniapp/pages/index/index.js', ctx)
  bootPlain(page)
  await settle(); await settle()

  ctx.urls.length = 0
  ctx.fireAppShow({ path: '/pages/index/index', query: { channel: 'LOCAL' } })
  page.onShow.call(page)
  assert.equal(ctx.gateCallCount(), 1, '带前导斜杠也应识别为主页入口')
  ctx.resolveNextGate(true)
  await settle(); await settle(); await settle()
  assert.ok(has(ctx.urls, '/categories?channel=LOCAL'), ctx.urls.join(' '))
})

test('onLoad 里注册的监听函数与 onUnload 里注销的是同一个引用', function () {
  var ctx = makeMultiGateCtx('EXPRESS')
  var page = loadPage('../../apps/miniapp/pages/index/index.js', ctx)
  page.onLoad.call(page, {})
  assert.equal(ctx.listenerCount(), 1)
  var registered = ctx.lastOnAppShowCb()
  assert.equal(typeof registered, 'function')
  page.onUnload.call(page)
  assert.equal(ctx.listenerCount(), 0, 'onUnload 应该把监听摘掉')
  assert.equal(ctx.lastOffAppShowCb(), registered, 'offAppShow 收到的应是 onAppShow 注册的那个引用')
})

test('桩里没有 wx.onAppShow / wx.offAppShow 时，onLoad 与 onUnload 都不抛错（旧基础库兜底）', function () {
  var gate = makeDeferred()
  var ctx = makeCtx('EXPRESS', gate)
  assert.equal(ctx.wx.onAppShow, undefined)
  var page = loadPage('../../apps/miniapp/pages/index/index.js', ctx)
  assert.doesNotThrow(function () { page.onLoad.call(page, {}) })
  assert.doesNotThrow(function () { page.onUnload.call(page) })
})
