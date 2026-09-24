// 微信「单页模式」行为锁（朋友圈内直接打开分享卡片）。
//
// 背景：顾客从朋友圈点开在同城下分享的卡片，落地的是官方「单页模式」——并不会
// 真正打开小程序（微信文档 share-timeline.html）：页面无登录态，wx.login 等登录
// 相关接口不可用，也不允许真正跳转。此前的问题：
//   ① app.js 的 onLaunch 不管场景都会尝试 wx.login/自动登录，登录失败后
//      utils/request.js 在下一次 40101/40102 时弹「登录已过期，请重试」——
//      这在单页模式下是必然发生的误报，不是真的登录过期；
//   ② 主页 onLoad 收到 ?channel=LOCAL 时会走 gateThenLoad() 问位置许可，
//      单页模式下隐私授权流程同样不可信，且这里本来就只是浏览。
// 本文件锁住的修复：单页模式（scene===1154）下不登录、不过门、不弹「登录已过期」/
// 「未登录」toast、隐藏同城商品卡上的「+」；点「前往小程序」后是一次新的启动
// （scene 变成 1155），一切照常——这些回归锁在下面各组用例里各留一条。
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')

// ── a. utils/share.js: isSinglePageLaunch ───────────────────────────────────

function freshShare() {
  var abs = require.resolve('../../apps/miniapp/utils/share')
  delete require.cache[abs]
  return require('../../apps/miniapp/utils/share')
}

test('isSinglePageLaunch({scene:1154}) === true', function () {
  var share = freshShare()
  assert.equal(share.isSinglePageLaunch({ scene: 1154 }), true)
})

;[
  ['{scene:1155}', { scene: 1155 }],
  ['{scene:1007}', { scene: 1007 }],
  ['{}', {}],
  ['undefined', undefined],
].forEach(function (pair) {
  test('isSinglePageLaunch(' + pair[0] + ') === false（没有 wx 兜底可用）', function () {
    var share = freshShare()
    delete global.wx
    assert.equal(share.isSinglePageLaunch(pair[1]), false)
  })
})

test('options 里没有 scene，桩 wx.getLaunchOptionsSync() 返回 {scene:1154} 时 → true', function () {
  var share = freshShare()
  global.wx = { getLaunchOptionsSync: function () { return { scene: 1154 } } }
  assert.equal(share.isSinglePageLaunch({}), true)
  delete global.wx
})

test('options 里没有 scene，桩里没有 getLaunchOptionsSync 这个 API 时 → false 且不抛', function () {
  var share = freshShare()
  global.wx = {}
  assert.doesNotThrow(function () {
    assert.equal(share.isSinglePageLaunch({}), false)
  })
  delete global.wx
})

test('options 里没有 scene，桩里连 global.wx 都没有时 → false 且不抛', function () {
  var share = freshShare()
  delete global.wx
  assert.doesNotThrow(function () {
    assert.equal(share.isSinglePageLaunch({}), false)
  })
})

// ── b/c. app.js：onLaunch 判单页模式；单页模式下 _tryLogin 短路 ─────────────
// 桩法沿用 tests/miniapp/navigation.test.cjs 的 loadApp，额外记录 wx.login 与
// wx.request 的调用，用来断言「没有发起登录/购物车请求」。

function loadApp(opts) {
  Object.keys(require.cache)
    .filter(function (k) { return k.indexOf(path.join('apps', 'miniapp')) !== -1 })
    .forEach(function (k) { delete require.cache[k] })
  var registered = null
  var calls = []
  global.App = function (o) { registered = o }
  global.getApp = function () { return registered }
  global.wx = {
    getStorageSync: function (k) {
      return (opts && opts.storedChannel && k === 'shoppingChannel') ? opts.storedChannel : ''
    },
    setStorageSync: function () {},
    login: function (o) {
      calls.push('login')
      if (opts && opts.loginFails) { o.fail && o.fail(new Error('login failed')); return }
      o.success({ code: 'fake-code' })
    },
    request: function (o) {
      calls.push('request:' + o.url)
      if (o.url.indexOf('/auth/wechat-login') !== -1) {
        o.success({ statusCode: 200, data: { code: 0, message: 'ok', data: { token: 'tok', nickname: 'n', avatarUrl: 'a' } } })
        return
      }
      o.success({ statusCode: 200, data: { code: 0, message: 'ok', data: { items: [] } } })
    },
    onNeedPrivacyAuthorization: function () {},
    getSystemInfoSync: function () { return {} },
    setTabBarBadge: function () {},
    removeTabBarBadge: function () {},
  }
  global.getCurrentPages = function () { return [] }
  require('../../apps/miniapp/app.js')
  return { app: registered, calls: calls }
}

var tick = function () { return new Promise(function (r) { setImmediate(r) }) }

test('app.js: onLaunch({scene:1154}) 单页模式——不登录、不拉购物车', async function () {
  var h = loadApp()
  h.app.onLaunch({ scene: 1154 })
  await tick(); await tick(); await tick()
  assert.equal(h.app.globalData.singlePage, true)
  assert.ok(h.calls.indexOf('login') === -1, '不该调用 wx.login：' + h.calls.join(','))
  assert.ok(!h.calls.some(function (c) { return c.indexOf('/auth/wechat-login') !== -1 }), '不该发登录请求：' + h.calls.join(','))
  assert.ok(!h.calls.some(function (c) { return c.indexOf('/cart') !== -1 }), '不该拉购物车：' + h.calls.join(','))
})

test('app.js 回归：onLaunch({scene:1007}) 非单页模式——正常走一次登录（回归锁）', async function () {
  var h = loadApp()
  h.app.onLaunch({ scene: 1007 })
  await tick(); await tick(); await tick()
  assert.equal(h.app.globalData.singlePage, false)
  assert.ok(h.calls.indexOf('login') !== -1, '应该调用 wx.login：' + h.calls.join(','))
})

test('app.js: 单页模式下 _tryLogin() 返回 rejected Promise，且不调用 wx.login', async function () {
  var h = loadApp()
  h.app.globalData.singlePage = true
  await assert.rejects(h.app._tryLogin())
  assert.ok(h.calls.indexOf('login') === -1, '不该调用 wx.login：' + h.calls.join(','))
})

// ── d/e. utils/request.js：单页模式下 40101/40102 直接 reject，不重登、不弹 toast；
//         非单页模式回归锁原样保留 ───────────────────────────────────────────

function makeWxRequestQueue(responses) {
  var calls = []
  var idx = 0
  return {
    calls: calls,
    fn: function (o) {
      calls.push(o.url)
      var r = responses[idx] !== undefined ? responses[idx] : responses[responses.length - 1]
      idx++
      if (r.fail) { o.fail(r.fail); return }
      o.success(r.success)
    },
  }
}

function loadRequest(appStub, responses) {
  Object.keys(require.cache)
    .filter(function (k) { return k.indexOf(path.join('apps', 'miniapp')) !== -1 })
    .forEach(function (k) { delete require.cache[k] })
  var toastCalls = []
  var reqStub = makeWxRequestQueue(responses)
  global.getApp = function () { return appStub }
  global.wx = {
    getStorageSync: function () { return '' },
    showToast: function (o) { toastCalls.push(o.title) },
    request: reqStub.fn,
  }
  var mod = require('../../apps/miniapp/utils/request')
  return { request: mod.request, toastCalls: toastCalls, requestCalls: reqStub.calls }
}

;[40101, 40102].forEach(function (code) {
  test('request.js 单页模式：' + code + ' 直接 reject，不重登、不弹 toast（silent:false 也不弹）', async function () {
    var tryLoginCalls = 0
    var appStub = { globalData: { singlePage: true }, _tryLogin: function () { tryLoginCalls++; return Promise.resolve() } }
    var h = loadRequest(appStub, [{ success: { statusCode: 401, data: { code: code, message: '未登录' } } }])
    await assert.rejects(h.request({ url: '/cart', silent: false }), function (err) {
      assert.equal(err.code, code)
      return true
    })
    assert.equal(tryLoginCalls, 0, '单页模式不该重登')
    assert.equal(h.toastCalls.length, 0, '单页模式不该弹 toast：' + h.toastCalls.join(','))
    assert.equal(h.requestCalls.length, 1, '单页模式不该重试请求')
  })
})

test('request.js 回归：非单页模式 40101 → _tryLogin 调用一次；reject 时 toast 为「登录已过期，请重试」', async function () {
  var tryLoginCalls = 0
  var appStub = { globalData: {}, _tryLogin: function () { tryLoginCalls++; return Promise.reject(new Error('login failed')) } }
  var h = loadRequest(appStub, [{ success: { statusCode: 401, data: { code: 40101, message: '未登录' } } }])
  await assert.rejects(h.request({ url: '/cart', silent: false }))
  assert.equal(tryLoginCalls, 1)
  assert.deepEqual(h.toastCalls, ['登录已过期，请重试'])
})

test('request.js 回归：_tryLogin resolve 后重试一次，以第二次返回的数据 resolve', async function () {
  var tryLoginCalls = 0
  var appStub = { globalData: {}, _tryLogin: function () { tryLoginCalls++; return Promise.resolve() } }
  var h = loadRequest(appStub, [
    { success: { statusCode: 401, data: { code: 40101, message: '未登录' } } },
    { success: { statusCode: 200, data: { code: 0, message: 'ok', data: { items: [1, 2] } } } },
  ])
  var result = await h.request({ url: '/cart', silent: false })
  assert.equal(tryLoginCalls, 1)
  assert.equal(h.requestCalls.length, 2)
  assert.deepEqual(result, { items: [1, 2] })
})

test('request.js 回归：silent:true 时 40101 不弹 toast（reject 仍然发生）', async function () {
  var appStub = { globalData: {}, _tryLogin: function () { return Promise.reject(new Error('nope')) } }
  var h = loadRequest(appStub, [{ success: { statusCode: 401, data: { code: 40101, message: '未登录' } } }])
  await assert.rejects(h.request({ url: '/cart', silent: true }))
  assert.equal(h.toastCalls.length, 0)
})

// ── f-j. 主页：单页模式落地不过门，普通模式回归锁原样保留 ────────────────────
// 桩法沿用 tests/miniapp/share-landing.test.cjs 的 makeCtx/makeMultiGateCtx：
// 打桩在 wx.request 上，断言的是「实际发出去的 URL」，不是页面 data。

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

function makeDeferred() {
  var resolve, reject
  var promise = new Promise(function (res, rej) { resolve = res; reject = rej })
  return { promise: promise, resolve: resolve, reject: reject }
}

function makeCtx(channel, gate, opts) {
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
    gateLocalChannel: function () {
      gateCalls++
      return gate.promise.then(function (ok) {
        if (ok) app.setShoppingChannel('LOCAL')
        return ok
      })
    },
  }
  if (opts && Object.prototype.hasOwnProperty.call(opts, 'singlePage')) {
    app.globalData.singlePage = opts.singlePage
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

function makeMultiGateCtx(channel, opts) {
  var urls = []
  var pendingGates = []
  var gateCalls = 0
  var appShowListeners = []
  var app = {
    globalData: { shoppingChannel: channel, pendingCategoryId: null, pendingCategoryName: null, pendingCategoryAll: false },
    getShoppingChannel: function () { return app.globalData.shoppingChannel },
    setShoppingChannel: function (v) { app.globalData.shoppingChannel = v; return v },
    getLocalMode: function () { return app.globalData.localMode || 'DELIVERY' },
    setLocalMode: function (v) { app.globalData.localMode = v; return v },
    applyCartBadge: function () {},
    updateCartCount: function () {},
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
  if (opts && Object.prototype.hasOwnProperty.call(opts, 'singlePage')) {
    app.globalData.singlePage = opts.singlePage
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
    onAppShow: function (cb) { appShowListeners.push(cb) },
    offAppShow: function (cb) {
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
    fireAppShow: function (opts2) { appShowListeners.slice().forEach(function (cb) { cb(opts2) }) },
  }
}

var settle = function () { return new Promise(function (r) { setTimeout(r, 0) }) }
var has = function (urls, frag) { return urls.some(function (u) { return u.indexOf(frag) !== -1 }) }

function boot(page, options) {
  page.onLoad.call(page, options)
  if (typeof page.onShow === 'function') page.onShow.call(page)
  if (typeof page.onReady === 'function') page.onReady.call(page)
}

function bootPlain(page) {
  page.onLoad.call(page, {})
  page.onReady.call(page)
  page.onShow.call(page)
}

test('f. 主页单页模式：channel=LOCAL 落地不过门，直接按同城加载', async function () {
  var gate = makeDeferred()
  var ctx = makeCtx('EXPRESS', gate, { singlePage: true })
  var page = loadPage('../../apps/miniapp/pages/index/index.js', ctx)
  boot(page, { channel: 'LOCAL' })
  await settle(); await settle(); await settle()
  assert.equal(ctx.gateCallCount(), 0, '单页模式不该过门')
  assert.ok(has(ctx.urls, '/categories?channel=LOCAL'), ctx.urls.join(' '))
  assert.ok(has(ctx.urls, '/products?channel=LOCAL'), ctx.urls.join(' '))
  assert.ok(!has(ctx.urls, 'channel=EXPRESS'), '不该混进邮寄请求：' + ctx.urls.join(' '))
  assert.equal(ctx.app.getShoppingChannel(), 'LOCAL')
  assert.equal(page.data.loading, false)
  assert.equal(page.data.singlePage, true)
})

;[
  ['{channel:\'EXPRESS\'}', { channel: 'EXPRESS' }],
  ['{}（当前渠道 EXPRESS）', {}],
].forEach(function (pair) {
  test('g. 主页单页模式 onLoad' + pair[0] + '：不过门，全部按邮寄加载', async function () {
    var gate = makeDeferred()
    var ctx = makeCtx('EXPRESS', gate, { singlePage: true })
    var page = loadPage('../../apps/miniapp/pages/index/index.js', ctx)
    boot(page, pair[1])
    await settle(); await settle()
    assert.equal(ctx.gateCallCount(), 0)
    assert.ok(has(ctx.urls, '/categories?channel=EXPRESS'), ctx.urls.join(' '))
    assert.ok(has(ctx.urls, '/products?channel=EXPRESS'), ctx.urls.join(' '))
    assert.ok(!has(ctx.urls, 'channel=LOCAL'), ctx.urls.join(' '))
  })
})

test('h. 主页单页模式热启动：wx.onAppShow 带 channel=LOCAL 落地，不过门', async function () {
  var ctx = makeMultiGateCtx('EXPRESS', { singlePage: true })
  var page = loadPage('../../apps/miniapp/pages/index/index.js', ctx)
  bootPlain(page)
  await settle(); await settle()

  ctx.urls.length = 0
  ctx.fireAppShow({ path: 'pages/index/index', query: { channel: 'LOCAL' } })
  page.onShow.call(page)
  await settle(); await settle(); await settle()
  assert.equal(ctx.gateCallCount(), 0, '单页模式热启动也不该过门')
  assert.ok(has(ctx.urls, '/categories?channel=LOCAL'), ctx.urls.join(' '))
  assert.ok(has(ctx.urls, '/products?channel=LOCAL'), ctx.urls.join(' '))
  assert.equal(ctx.app.getShoppingChannel(), 'LOCAL')
})

test('i. 主页单页模式：onAddToCart 不打开加购弹层', function () {
  var gate = makeDeferred()
  var ctx = makeCtx('LOCAL', gate, { singlePage: true })
  var page = loadPage('../../apps/miniapp/pages/index/index.js', ctx)
  page.onLoad.call(page, {})
  page.data.products = [{ id: 'p1', stock: 5 }]
  var openCalls = 0
  page.selectComponent = function (sel) {
    if (sel === '#local-sku-picker') return { open: function () { openCalls++ } }
    return null
  }
  page.onAddToCart({ currentTarget: { dataset: { id: 'p1' } } })
  assert.equal(openCalls, 0, '单页模式不该打开加购弹层')
})

test('i. index.wxml：add-btn 节点的 wx:if 同时判断 channel===\'LOCAL\' 与 !singlePage', function () {
  var wxml = fs.readFileSync(path.join(__dirname, '..', '..', 'apps', 'miniapp', 'pages', 'index', 'index.wxml'), 'utf8')
  var idx = wxml.indexOf('class="add-btn')
  assert.ok(idx !== -1, '找不到 add-btn 节点')
  var before = wxml.slice(Math.max(0, idx - 150), idx)
  assert.match(before, /wx:if="\{\{\s*channel === 'LOCAL'\s*&&\s*!singlePage\s*\}\}"/, 'add-btn 前的 wx:if 应同时含 channel===\'LOCAL\' 与 !singlePage：' + before)
})

test('j. 主页回归（非单页模式，app 桩不带 singlePage 字段）：channel=LOCAL 落地仍然过门一次', async function () {
  var gate = makeDeferred()
  var ctx = makeCtx('EXPRESS', gate)
  assert.equal(ctx.app.globalData.singlePage, undefined)
  var page = loadPage('../../apps/miniapp/pages/index/index.js', ctx)
  boot(page, { channel: 'LOCAL' })
  await settle(); await settle()
  assert.equal(ctx.gateCallCount(), 1, '非单页模式应照常过门')
})
