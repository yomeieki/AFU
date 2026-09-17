// 分类页两侧渠道标识 + 共用切换弹层的行为锁（2026-09-17 设计 N1–N3）。
//
// 选中即切渠道并**重载本页**（不跳主页）；去同城走 app.gateLocalChannel()（位置许可 → 定渠道），
// 页面不自己问许可、不自己判许可分支——门在 app.js 里，页面只管门后的重载。
//
// 桩打在 wx.request 上，断言实际发出的 URL：与 channel-pages.test.cjs 同一套理由，
// 页面数据看着对不代表真的按新渠道拉过货。
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

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
    // 真身在 app.js：位置许可 → 定渠道 LOCAL；这里的桩记录「确实过了门」，并按真身把渠道置 LOCAL
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
      const body = /\/categories/.test(o.url) ? [] : /\/products/.test(o.url) ? { list: [], total: 0 } : {}
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
  return { app, wx, urls, calls }
}

const settle = () => new Promise((r) => setTimeout(r, 0))
const has = (urls, frag) => urls.some((u) => u.indexOf(frag) !== -1)
const pick = (page, channel) => page.onPickChannel.call(page, { currentTarget: { dataset: { channel: channel } } })

test('同城 → 邮寄：定渠道、重载本页拉邮寄货，弹层关闭', async function () {
  const ctx = makeCtx('LOCAL')
  const page = loadPage('../../apps/miniapp/pages/product/list.js', ctx)
  page.onLoad.call(page)
  await settle(); await settle()
  ctx.urls.length = 0
  pick(page, 'EXPRESS')
  await settle(); await settle()
  assert.equal(ctx.app.globalData.shoppingChannel, 'EXPRESS')
  assert.ok(has(ctx.urls, '/categories?channel=EXPRESS'), ctx.urls.join(' '))
  assert.ok(!has(ctx.urls, '/local/meta'), '邮寄不该拉同城门店状态：' + ctx.urls.join(' '))
  assert.equal(page.data.channelSheetOpen, false)
})

test('邮寄 → 同城（门放行）：过门后重载本页拉同城货', async function () {
  const ctx = makeCtx('EXPRESS', { gateOk: true })
  const page = loadPage('../../apps/miniapp/pages/product/list.js', ctx)
  page.onLoad.call(page)
  await settle(); await settle()
  ctx.urls.length = 0
  pick(page, 'LOCAL')
  await settle(); await settle()
  assert.ok(ctx.calls.indexOf('gate') !== -1, ctx.calls.join(' '))
  assert.ok(has(ctx.urls, '/categories?channel=LOCAL'), ctx.urls.join(' '))
  assert.ok(has(ctx.urls, '/local/meta'), ctx.urls.join(' '))
})

test('邮寄 → 同城（门拒绝）：不重载，页面仍是邮寄', async function () {
  const ctx = makeCtx('EXPRESS', { gateOk: false })
  const page = loadPage('../../apps/miniapp/pages/product/list.js', ctx)
  page.onLoad.call(page)
  await settle(); await settle()
  ctx.urls.length = 0
  pick(page, 'LOCAL')
  await settle(); await settle()
  assert.deepEqual(ctx.urls, [])
  assert.equal(page.data.channel, 'EXPRESS')
})

test('选中当前渠道：不发请求、不过门，只关弹层', async function () {
  const ctx = makeCtx('LOCAL')
  const page = loadPage('../../apps/miniapp/pages/product/list.js', ctx)
  page.onLoad.call(page)
  await settle(); await settle()
  page.openChannelSheet.call(page)
  ctx.urls.length = 0
  pick(page, 'LOCAL')
  await settle()
  assert.deepEqual(ctx.urls, [])
  assert.deepEqual(ctx.calls, [])
  assert.equal(page.data.channelSheetOpen, false)
})

test('弹层开关：openChannelSheet / closeChannelSheet；noop 存在且可调用', function () {
  const ctx = makeCtx('LOCAL')
  const page = loadPage('../../apps/miniapp/pages/product/list.js', ctx)
  page.openChannelSheet.call(page)
  assert.equal(page.data.channelSheetOpen, true)
  page.closeChannelSheet.call(page)
  assert.equal(page.data.channelSheetOpen, false)
  assert.equal(typeof page.noop, 'function')
  assert.doesNotThrow(function () { page.noop.call(page) })
})

test('组件事件链：local-store-header 的 onTapChannel 触发 switchchannel；channel-badge 的 onTap 触发 switch，observers 按渠道给文案', function () {
  const ctx = makeCtx('LOCAL')
  const header = loadPage('../../apps/miniapp/components/local-store-header/index.js', ctx)
  const headerEvents = []
  header.triggerEvent = function (name) { headerEvents.push(name) }
  Object.keys(header.methods).forEach(function (k) { header[k] = header.methods[k] })
  header.onTapChannel()
  assert.deepEqual(headerEvents, ['switchchannel'])

  const badge = loadPage('../../apps/miniapp/components/channel-badge/index.js', ctx)
  const badgeEvents = []
  badge.triggerEvent = function (name) { badgeEvents.push(name) }
  badge.data = Object.assign({}, badge.data)
  badge.setData = function (patch) { Object.assign(badge.data, patch) }
  Object.keys(badge.methods).forEach(function (k) { badge[k] = badge.methods[k] })
  badge.onTap()
  assert.deepEqual(badgeEvents, ['switch'])
  badge.observers.channel.call(badge, 'LOCAL')
  assert.equal(badge.data.label, '同城配送')
})

test('页面不自己问许可：onPickChannel 存在，list.js 源码不含 ensurePrivacyAuthorize（与验收 A7 同一件事）', function () {
  const ctx = makeCtx('LOCAL')
  const page = loadPage('../../apps/miniapp/pages/product/list.js', ctx)
  assert.equal(typeof page.onPickChannel, 'function')
  const source = require('fs').readFileSync('apps/miniapp/pages/product/list.js', 'utf8')
  assert.ok(source.indexOf('ensurePrivacyAuthorize') === -1, '分类页不应自己拉起许可弹窗')
})
