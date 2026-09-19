// 同城「外送 / 自取」子模式在页面上的接线锁。
//
// 三件事错了都是静默的：① 外送关了自取开着，主页却仍按外送画（顾客看到「即将开通」）；
// ② 切到自取后购物车条仍把顾客送进外送结算页（要地址、要报价）；③ 起送线按错的那一侧判。
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

const META_PICKUP_ONLY = {
  enabled: false, isOpen: false, paused: null, closedKind: 'OPEN', fee: { minOrderAmount: 4000 },
  pickup: { enabled: true, paused: null, minOrderAmountFen: 1500, discountText: '自取享 9.5 折', slotMinutes: 30 },
  store: { name: '阿福凉菜', district: '自流井区', address: '丹桂40栋底楼', latE6: 1, lngE6: 2 },
}
const META_BOTH = Object.assign({}, META_PICKUP_ONLY, { enabled: true, isOpen: true })

function makeCtx(channel, mode, meta, cart) {
  const urls = []
  const nav = []
  const app = {
    globalData: { shoppingChannel: channel, localMode: mode || 'DELIVERY', pendingCategoryId: null, pendingCategoryName: null, pendingCategoryAll: false },
    getShoppingChannel: () => app.globalData.shoppingChannel,
    setShoppingChannel: (v) => { app.globalData.shoppingChannel = v; return v },
    getLocalMode: () => app.globalData.localMode,
    setLocalMode: (v) => { nav.push('setLocalMode:' + v); app.globalData.localMode = v; return v },
    applyCartBadge() {}, updateCartCount() {},
    enterLocalChannel() { nav.push('enterLocal'); return Promise.resolve() },
  }
  const wx = {
    getStorageSync: () => '', setStorageSync: () => {},
    request: (o) => {
      const u = o.url.replace(/^https?:\/\/[^/]+(\/api)?/, '')
      urls.push(u)
      const body = /\/categories/.test(u) ? [] : /\/products/.test(u) ? { list: [], total: 0 }
        : /\/local\/meta/.test(u) ? meta
        : /\/cart/.test(u) ? (cart || { items: [], totalAmount: 0, selectedCount: 0 })
        : {}
      o.success({ statusCode: 200, data: { code: 0, message: 'ok', data: body } })
    },
    getWindowInfo: () => ({ windowWidth: 375, windowHeight: 812, statusBarHeight: 44 }),
    getSystemInfoSync: () => ({ windowWidth: 375, windowHeight: 812, statusBarHeight: 44 }),
    getMenuButtonBoundingClientRect: () => ({ top: 48, height: 32 }),
    navigateTo: (o) => { nav.push('navigateTo:' + o.url) },
    switchTab: (o) => { nav.push('switchTab:' + o.url) },
    stopPullDownRefresh() {}, showToast() {}, showModal() {}, reLaunch() {},
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
  return { app, wx, urls, nav }
}
const settle = () => new Promise((r) => setTimeout(r, 0))

test('主页：外送关、自取开 → 自动落到 PICKUP，并写回 app', async function () {
  const ctx = makeCtx('LOCAL', 'DELIVERY', META_PICKUP_ONLY)
  const page = loadPage('../../apps/miniapp/pages/index/index.js', ctx)
  page.onLoad.call(page)
  await settle(); await settle()
  assert.equal(page.data.mode, 'PICKUP')
  assert.ok(ctx.nav.indexOf('setLocalMode:PICKUP') !== -1, '要写回 app：' + ctx.nav.join(' '))
  assert.equal(page.data.headBlocking, false, '自取可用时不该阻塞')
})

test('主页：切换栏 change → 模式写回 app，阻塞态按新模式重算', async function () {
  const ctx = makeCtx('LOCAL', 'DELIVERY', Object.assign({}, META_BOTH, { paused: { reason: '骑手不够' } }))
  const page = loadPage('../../apps/miniapp/pages/index/index.js', ctx)
  page.onLoad.call(page)
  await settle(); await settle()
  assert.equal(page.data.headBlocking, true, '外送暂停应阻塞')
  page.onModeChange.call(page, { detail: { mode: 'PICKUP' } })
  assert.equal(ctx.app.globalData.localMode, 'PICKUP')
  assert.equal(page.data.mode, 'PICKUP')
  assert.equal(page.data.headBlocking, false, '切到自取后不再阻塞')
})

test('分类页：onShow 时 app 里的模式变了要跟上', async function () {
  const ctx = makeCtx('LOCAL', 'DELIVERY', META_BOTH)
  const page = loadPage('../../apps/miniapp/pages/product/list.js', ctx)
  page.onLoad.call(page)
  await settle(); await settle()
  assert.equal(page.data.mode, 'DELIVERY')
  ctx.app.globalData.localMode = 'PICKUP'
  page.onShow.call(page)
  await settle()
  assert.equal(page.data.mode, 'PICKUP')
})

const twoLocal = { items: [{ id: 1, productName: 'A', price: 1200, subtotal: 2400, quantity: 2, isSelected: 1, status: 'ON_SHELF' }], totalAmount: 2400, selectedCount: 2 }

test('购物车页：自取模式走自取结算页，外送模式走同城结算页；起送线按各自的', async function () {
  const pk = makeCtx('LOCAL', 'PICKUP', META_BOTH, twoLocal)
  const pkPage = loadPage('../../apps/miniapp/pages/cart/index.js', pk)
  pkPage.onShow.call(pkPage)
  await settle(); await settle()
  assert.equal(pkPage.data.checkoutText, '去结算 · 自取')
  pkPage.onCheckout.call(pkPage)
  assert.ok(pk.nav.some((n) => n.indexOf('navigateTo:/pages/local/pickup?cartItemIds=1') === 0), pk.nav.join(' '))

  const dl = makeCtx('LOCAL', 'DELIVERY', META_BOTH, twoLocal)
  const dlPage = loadPage('../../apps/miniapp/pages/cart/index.js', dl)
  dlPage.onShow.call(dlPage)
  await settle(); await settle()
  // 外送起送 ¥40，车里 ¥24：按外送判，不放行
  assert.equal(dlPage.data.checkoutDisabled, true)
  assert.equal(dlPage.data.checkoutText, '还差 ¥16.00 起送')
})

test('购物车条组件：自取模式 goCheckout 去自取结算页', async function () {
  const ctx = makeCtx('LOCAL', 'PICKUP', META_BOTH, twoLocal)
  const bar = loadPage('../../apps/miniapp/components/local-cart-bar/index.js', ctx)
  bar.properties = { meta: META_BOTH, blocking: false, mode: 'PICKUP' }
  bar.triggerEvent = () => {}
  // Component 运行时会把 methods 挂到 this 上（refresh 里调 this.recompute()）；桩要自己挂
  Object.keys(bar.methods).forEach((k) => { bar[k] = bar.methods[k] })
  await bar.refresh()
  assert.equal(bar.data.actionText, '去结算 · 自取')
  bar.goCheckout()
  assert.ok(ctx.nav.some((n) => n.indexOf('navigateTo:/pages/local/pickup?cartItemIds=1') === 0), ctx.nav.join(' '))
})

// F7 之后模式回落只在首次进同城时做：分类页那条路径（reloadForChannel → loadMeta(true)）单独钉住，
// 否则外送关、自取开时顾客从分类页进来仍会按外送画。
test('分类页：外送关、自取开 → 首次进入即落到 PICKUP；之后 onShow 不改顾客的选择', async function () {
  const ctx = makeCtx('LOCAL', 'DELIVERY', META_PICKUP_ONLY)
  const page = loadPage('../../apps/miniapp/pages/product/list.js', ctx)
  page.onLoad.call(page)
  await settle(); await settle()
  assert.equal(page.data.mode, 'PICKUP')
  assert.ok(ctx.nav.indexOf('setLocalMode:PICKUP') !== -1, '要写回 app：' + ctx.nav.join(' '))
  // 顾客手动切回外送看原因：onShow 重拉 meta 不能把他拨回自取
  ctx.app.globalData.localMode = 'DELIVERY'
  page.onShow.call(page)
  await settle(); await settle()
  assert.equal(page.data.mode, 'DELIVERY')
})
