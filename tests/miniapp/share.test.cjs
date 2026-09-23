// 转发行为锁：utils/share.js 的纯函数 + 25 页统一挂载 + 朋友圈只留主页。
//
// 背景：微信右上角「…」菜单显示「无法转发此页面」，因为大多数页面没实现
// onShareAppMessage。修法是给 25 个页面统一挂同一个 onShareAppMessage——而不是
// 给每页各写一份「转发到本页」（那样转过去的页面往往没有底部导航，等于死胡同）。
//
// 「转发给好友」卡片落到哪：PO 2026-09-23 最终决定改成落封面页 pages/cover/index
// （pages[0]），不带渠道参数，由对方在封面自己选同城/邮寄（此前落主页 + 带
// channel 参数的旧形态，本文件的断言已跟着改成新形态——这是需求本身导致的断言
// 变更，不是放宽）。卡片的标题、图片显示不变。朋友圈（onShareTimeline）不受
// 这次调整影响，仍只在主页、仍带 channel 参数。
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

// ── shareCard / homeTimeline / channelFromQuery：纯函数，不用桩 ──────────────

// shareCard() 不再接受/看渠道参数：进封面页，标题与卡片图跟改动前一致，
// path 精确等于封面页路径、不带任何 query。
test('shareCard()：标题、path 精确等于封面页、卡片图，且不带 query', function () {
  assert.deepEqual(share.shareCard(), {
    title: '阿福凉菜 · 家的味道，三十年老店',
    path: '/pages/cover/index',
    imageUrl: '/assets/share/card.png',
  })
})

test('shareCard()：无论传不传参数结果都一样（新落地页不带渠道）', function () {
  assert.deepEqual(share.shareCard('LOCAL'), share.shareCard())
  assert.deepEqual(share.shareCard('EXPRESS'), share.shareCard())
  assert.deepEqual(share.shareCard(undefined), share.shareCard())
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

// 卡片进封面、不带渠道参数，所以 LOCAL/EXPRESS 两种渠道下 25 页应该拿到
// 完全相同的一份 payload（跟当前购物渠道无关）——这正是本次需求要的行为。
test('25 页的 onShareAppMessage 都落到 shareCard()（进封面），LOCAL 与 EXPRESS 渠道下结果相同', function () {
  var pages = APP_JSON.pages
  ;['LOCAL', 'EXPRESS'].forEach(function (channel) {
    pages.forEach(function (pagePath) {
      var page = loadPage(pagePath, channel)
      var result = page.onShareAppMessage.call(page, { from: 'menu' })
      assert.deepEqual(result, share.shareCard(), pagePath + ' @ ' + channel)
      assert.deepEqual(
        result,
        { title: '阿福凉菜 · 家的味道，三十年老店', path: '/pages/cover/index', imageUrl: '/assets/share/card.png' },
        pagePath + ' @ ' + channel + '：显示与落地页锁定'
      )
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
