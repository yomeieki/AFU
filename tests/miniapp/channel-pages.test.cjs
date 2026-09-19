// 主页与分类页「按渠道加载」的行为锁。
//
// 这两页被同城和邮寄共用，长得几乎一样。拉错渠道的表现是**顾客在同城模式下看到邮寄的货**——
// 不报错、不告警，在开发者工具里两屏也长得差不多，只有把货名逐个认一遍才发现。
// 所以这里断言的是「实际发出去的 URL」，不是页面数据。
//
// 桩打在 wx.request 上，让真实的 utils/request 与 api/catalog 都跑起来——
// 把 api 层一起 mock 掉的话，正好会漏掉「页面忘了传 channel」这一类错误。
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
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

function makeCtx(channel) {
  const urls = []
  const app = {
    globalData: { shoppingChannel: channel, pendingCategoryId: null, pendingCategoryName: null, pendingCategoryAll: false },
    getShoppingChannel: () => app.globalData.shoppingChannel,
    setShoppingChannel: (v) => { app.globalData.shoppingChannel = v; return v },
    getLocalMode: () => app.globalData.localMode || 'DELIVERY',
    setLocalMode: (v) => { app.globalData.localMode = v; return v },
    applyCartBadge() {}, updateCartCount() {},
  }
  const wx = {
    getStorageSync: () => '',
    setStorageSync: () => {},
    request: (o) => {
      urls.push(o.url.replace(/^https?:\/\/[^/]+(\/api)?/, ''))
      // 每个接口都给一个形状合法的空响应，页面据此走完整条 then 链
      const body = /\/categories/.test(o.url) ? [] : /\/products/.test(o.url) ? { list: [], total: 0 } : /\/local\/meta/.test(o.url) ? meta : {}
      o.success({ statusCode: 200, data: { code: 0, message: 'ok', data: body } })
    },
    getWindowInfo: () => ({ windowWidth: 375, windowHeight: 812, statusBarHeight: 44 }),
    getSystemInfoSync: () => ({ windowWidth: 375, windowHeight: 812, statusBarHeight: 44 }),
    getMenuButtonBoundingClientRect: () => ({ top: 48, height: 32 }),
    stopPullDownRefresh() {}, showToast() {}, switchTab() {}, navigateTo() {}, reLaunch() {},
    showNavigationBarLoading() {}, hideNavigationBarLoading() {},
    nextTick: (fn) => setTimeout(fn, 0),
    createSelectorQuery: () => { const q = { in: () => q, select: () => q, selectAll: () => q, boundingClientRect: () => q, scrollOffset: () => q, exec: (cb) => cb([{ top: 0, height: 600 }, { scrollTop: 0 }, []]) }; return q },
  }
  return { app, wx, urls }
}

const settle = () => new Promise((r) => setTimeout(r, 0))
const has = (urls, frag) => urls.some((u) => u.indexOf(frag) !== -1)

test('主页 LOCAL：分类与商品都带 channel=LOCAL，并拉门店 meta', async function () {
  const ctx = makeCtx('LOCAL')
  const page = loadPage('../../apps/miniapp/pages/index/index.js', ctx)
  page.onLoad.call(page)
  await settle(); await settle()
  assert.ok(has(ctx.urls, '/categories?channel=LOCAL'), '分类要带 LOCAL：' + ctx.urls.join(' '))
  assert.ok(has(ctx.urls, '/products?channel=LOCAL'), '商品要带 LOCAL：' + ctx.urls.join(' '))
  assert.ok(has(ctx.urls, '/local/meta'), '同城要拉门店状态')
  // 邮寄专属的 Banner 不该在同城下白跑一趟
  assert.ok(!has(ctx.urls, '/banners'), '同城不该请求邮寄 Banner')
})

test('主页 EXPRESS：商品按渠道加载，仅读取 meta 中的活动配置', async function () {
  const ctx = makeCtx('EXPRESS')
  const page = loadPage('../../apps/miniapp/pages/index/index.js', ctx)
  page.onLoad.call(page)
  await settle(); await settle()
  assert.ok(has(ctx.urls, '/categories?channel=EXPRESS'))
  assert.ok(has(ctx.urls, '/products?channel=EXPRESS'))
  assert.ok(has(ctx.urls, '/banners'))
  assert.ok(has(ctx.urls, '/local/meta'), '邮寄需要读取活动配置')
  assert.deepEqual(page.data.promotion, promotion)
  assert.equal(page.data.meta, null)
  assert.equal(page.data.headBlocking, false)
})

// 顾客在封面换了渠道再切回这个 tab：onShow 必须整页重来。
// 只刷新不重置的话，页面还留着上一个渠道的分类与商品。
test('主页 onShow：渠道变了就整页重来', async function () {
  const ctx = makeCtx('EXPRESS')
  const page = loadPage('../../apps/miniapp/pages/index/index.js', ctx)
  page.onLoad.call(page)
  await settle(); await settle()
  ctx.urls.length = 0
  ctx.app.globalData.shoppingChannel = 'LOCAL'
  page.onShow.call(page)
  await settle(); await settle()
  assert.ok(has(ctx.urls, '/categories?channel=LOCAL'), '应按新渠道重拉：' + ctx.urls.join(' '))
})

test('主页切渠道的一瞬间先清空旧内容，不让另一个渠道的商品留在屏幕上', async function () {
  const ctx = makeCtx('EXPRESS')
  const page = loadPage('../../apps/miniapp/pages/index/index.js', ctx)
  page.onLoad.call(page)
  await settle(); await settle()
  page.setData({ products: [{ id: 1, name: '邮寄的货' }], banners: [{ id: 1 }] })
  ctx.app.globalData.shoppingChannel = 'LOCAL'
  page.loadData.call(page)          // 不 await：要看的就是「发请求之前」那一刻
  assert.deepEqual(page.data.products, [], '旧商品必须当场清掉')
  assert.deepEqual(page.data.banners, [], '邮寄 Banner 不能留到同城页面上')
  assert.equal(page.data.loading, true)
})

test('分类页 LOCAL / EXPRESS 各自带对渠道', async function () {
  for (const ch of ['LOCAL', 'EXPRESS']) {
    const ctx = makeCtx(ch)
    const page = loadPage('../../apps/miniapp/pages/product/list.js', ctx)
    page.onLoad.call(page)
    await settle(); await settle()
    assert.ok(has(ctx.urls, '/categories?channel=' + ch), ch + ' 分类：' + ctx.urls.join(' '))
    assert.ok(has(ctx.urls, '/products?channel=' + ch), ch + ' 商品：' + ctx.urls.join(' '))
    assert.ok(has(ctx.urls, '/local/meta'))
    assert.deepEqual(page.data.promotion, promotion)
    if (ch === 'EXPRESS') {
      assert.equal(page.data.meta, null)
      assert.equal(page.data.headBlocking, false)
    }
  }
})

// 快速切分类时，在途请求带回来的可能是旧条件的结果。原来这把钥匙只含分类 id，
// **切渠道那一刻的在途请求会被认成「条件没变」**，另一个渠道的货就直接铺进列表了。
test('分类页的请求钥匙里必须含渠道，否则切渠道时在途响应会串货', function () {
  const ctx = makeCtx('LOCAL')
  const page = loadPage('../../apps/miniapp/pages/product/list.js', ctx)
  page.setData({ channel: 'LOCAL', searchKeyword: '牛肉' })
  const keyLocal = page.buildQueryKey.call(page)
  page.setData({ channel: 'EXPRESS' })
  const keyExpress = page.buildQueryKey.call(page)
  assert.notEqual(keyLocal, keyExpress, '同一个分类 id 在两个渠道下必须是不同的钥匙')
})

test('分类页切渠道会清空分类、商品与搜索词', async function () {
  const ctx = makeCtx('EXPRESS')
  const page = loadPage('../../apps/miniapp/pages/product/list.js', ctx)
  page.onLoad.call(page)
  await settle(); await settle()
  page.setData({ list: [{ id: 1 }], searchKeyword: '牛肉', groups: [{ id: 3, name: 'x', items: [] }], activeGroupId: 3 })
  ctx.app.globalData.shoppingChannel = 'LOCAL'
  page.reloadForChannel.call(page)
  assert.deepEqual(page.data.list, [])
  assert.equal(page.data.searchKeyword, '')
  assert.equal(page.data.activeGroupId, null, '旧渠道的分类 id 会指向一个新渠道没有的分类')
  assert.deepEqual(page.data.groups, [])
})
