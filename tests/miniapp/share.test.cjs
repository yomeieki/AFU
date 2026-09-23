// 转发行为锁：utils/share.js 的三个纯函数 + 25 页统一挂载 + 朋友圈只留主页。
//
// 背景（PO 2026-09-23）：微信右上角「…」菜单显示「无法转发此页面」，因为大多数页面
// 没实现 onShareAppMessage。修法是全部转发到主页（tabBar[0]），并把当前购物渠道
// 编进链接，让对方点开主页自动切到同一套菜单——而不是给每页各写一份「转发到本页」
// （那样转过去的页面往往没有底部导航，等于死胡同）。
//
// 25 页覆盖测试故意从 apps/miniapp/app.json 读 pages 数组，不写死清单：
// 页面清单本身会变，写死清单的测试会在清单变了之后继续对着旧清单断言，看不出漏挂。
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')

const APP_JSON = require('../../apps/miniapp/app.json')
const share = require('../../apps/miniapp/utils/share')

// ── 分享图产物：card.png / timeline.png ─────────────────────────────────────
// 验收标准第 4 条：直接解析 PNG 的 IHDR chunk 拿宽高（不依赖 sharp——测试要能在
// 没装 sharp 的环境里也跑）。IHDR 是 PNG 文件的第一个 chunk，固定布局：
// 字节 0-7 签名，8-11 chunk 长度，12-15 chunk 类型 "IHDR"，16-19 宽（大端 u32），
// 20-23 高（大端 u32）。

var SHARE_ASSETS_DIR = path.join(__dirname, '..', '..', 'apps', 'miniapp', 'assets', 'share')
var MAX_BYTES = 60 * 1024

function readPngSize(file) {
  var buf = fs.readFileSync(file)
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

;[
  { file: 'card.png', width: 500, height: 400 },
  { file: 'timeline.png', width: 500, height: 500 },
].forEach(function (spec) {
  test('分享图 ' + spec.file + '：' + spec.width + '×' + spec.height + '，且 < 60 KB', function () {
    var full = path.join(SHARE_ASSETS_DIR, spec.file)
    var size = readPngSize(full)
    assert.equal(size.width, spec.width, spec.file + ' 宽度')
    assert.equal(size.height, spec.height, spec.file + ' 高度')
    var bytes = fs.statSync(full).size
    assert.ok(bytes < MAX_BYTES, spec.file + ' 体积 ' + bytes + ' 字节，应 < ' + MAX_BYTES)
  })
})

// ── homeShare / homeTimeline / channelFromQuery：纯函数，不用桩 ──────────────

test('homeShare(LOCAL)：标题、主页路径带 channel=LOCAL、卡片图', function () {
  assert.deepEqual(share.homeShare('LOCAL'), {
    title: '阿福凉菜 · 家的味道，三十年老店',
    path: '/pages/index/index?channel=LOCAL',
    imageUrl: '/assets/share/card.png',
  })
})

test('homeShare(EXPRESS)：path 带 channel=EXPRESS', function () {
  assert.equal(share.homeShare('EXPRESS').path, '/pages/index/index?channel=EXPRESS')
})

test('homeShare：脏值与 undefined 落到 EXPRESS（与全站默认一致）', function () {
  assert.equal(share.homeShare('垃圾值').path, '/pages/index/index?channel=EXPRESS')
  assert.equal(share.homeShare(undefined).path, '/pages/index/index?channel=EXPRESS')
})

test('homeTimeline(LOCAL)：标题、query=channel=LOCAL、朋友圈图', function () {
  assert.deepEqual(share.homeTimeline('LOCAL'), {
    title: '阿福凉菜 · 家的味道，三十年老店',
    query: 'channel=LOCAL',
    imageUrl: '/assets/share/timeline.png',
  })
})

test('channelFromQuery：只认严格的 LOCAL / EXPRESS，其余（含大小写不对、空串、缺参、undefined）一律 null', function () {
  assert.equal(share.channelFromQuery({ channel: 'LOCAL' }), 'LOCAL')
  assert.equal(share.channelFromQuery({ channel: 'EXPRESS' }), 'EXPRESS')
  assert.equal(share.channelFromQuery({}), null)
  assert.equal(share.channelFromQuery(undefined), null)
  assert.equal(share.channelFromQuery({ channel: 'local' }), null)
  assert.equal(share.channelFromQuery({ channel: 'foo' }), null)
  assert.equal(share.channelFromQuery({ channel: '' }), null)
})

// ── 25 页覆盖：逐个加载页面模块，断言都挂了统一的 onShareAppMessage ─────────

function makeWxStub() {
  // 空桩：Proxy 兜底任何未显式定义的属性为 no-op 函数。这些页面模块加载期间
  // 只会在函数体内部用到 wx.*（顶层 require 不触发），真正调它们的行为
  // 已经在别的既有测试文件里锁过，这里只关心 onShareAppMessage 挂没挂对。
  return new Proxy(
    {
      getStorageSync: function () { return '' },
      setStorageSync: function () {},
    },
    {
      get: function (target, prop) {
        if (prop in target) return target[prop]
        return function () {}
      },
    }
  )
}

function makeApp(channel) {
  return {
    globalData: { shoppingChannel: channel, localMode: 'DELIVERY' },
    getShoppingChannel: function () { return channel },
    setShoppingChannel: function (v) { channel = v; return v },
    getLocalMode: function () { return 'DELIVERY' },
    setLocalMode: function (v) { return v },
    applyCartBadge: function () {},
    updateCartCount: function () {},
    enterLocalChannel: function () { return Promise.resolve() },
    gateLocalChannel: function () { return Promise.resolve(true) },
  }
}

function clearMiniappCache() {
  Object.keys(require.cache)
    .filter(function (k) { return k.indexOf(path.join('apps', 'miniapp')) !== -1 })
    .forEach(function (k) { delete require.cache[k] })
}

/** 加载一个小程序页面模块，返回它注册给 Page() 的对象。 */
function loadPage(pagePath, channel) {
  clearMiniappCache()
  var registered = null
  global.Page = function (o) { registered = o }
  global.Component = function (o) { registered = o }
  global.getApp = function () { return makeApp(channel) }
  global.wx = makeWxStub()
  global.getCurrentPages = function () { return [] }
  require('../../apps/miniapp/' + pagePath + '.js')
  if (registered && typeof registered.setData !== 'function') {
    registered.data = Object.assign({}, registered.data)
    registered.setData = function (patch) { Object.assign(registered.data, patch) }
  }
  return registered
}

test('25 页全覆盖：每页都能加载，且都挂了统一的 onShareAppMessage', function () {
  var pages = APP_JSON.pages
  var loadedCount = 0
  pages.forEach(function (pagePath) {
    var page = loadPage(pagePath, 'EXPRESS')
    loadedCount++
    assert.equal(typeof page.onShareAppMessage, 'function', pagePath + ' 缺 onShareAppMessage')
  })
  assert.equal(loadedCount, pages.length)
  assert.equal(pages.length, 25, 'app.json 的页面数变了——本用例数目断言需要跟着核实，不是巧合写死的 25')
})

test('25 页的 onShareAppMessage 都落到 homeShare(当前渠道)——LOCAL 与 EXPRESS 各验一遍', function () {
  var pages = APP_JSON.pages
  ;['LOCAL', 'EXPRESS'].forEach(function (channel) {
    pages.forEach(function (pagePath) {
      var page = loadPage(pagePath, channel)
      var result = page.onShareAppMessage.call(page, { from: 'menu' })
      assert.deepEqual(result, share.homeShare(channel), pagePath + ' @ ' + channel)
    })
  })
})

test('朋友圈入口只留在主页：其余 24 页 onShareTimeline 均为 undefined', function () {
  var pages = APP_JSON.pages
  var withTimeline = []
  pages.forEach(function (pagePath) {
    var page = loadPage(pagePath, 'EXPRESS')
    if (pagePath === 'pages/index/index') {
      assert.equal(typeof page.onShareTimeline, 'function', '主页应有 onShareTimeline')
    } else {
      assert.equal(page.onShareTimeline, undefined, pagePath + ' 不应有 onShareTimeline')
    }
    if (typeof page.onShareTimeline === 'function') withTimeline.push(pagePath)
  })
  assert.deepEqual(withTimeline, ['pages/index/index'])
})

test('主页 onShareTimeline 返回值等于 homeTimeline(当前渠道)', function () {
  ;['LOCAL', 'EXPRESS'].forEach(function (channel) {
    var page = loadPage('pages/index/index', channel)
    var result = page.onShareTimeline.call(page)
    assert.deepEqual(result, share.homeTimeline(channel))
  })
})
