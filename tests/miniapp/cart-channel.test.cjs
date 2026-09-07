// 购物车页的渠道隔离锁。
//
// 这一页两个渠道共用，而两个车在服务端是**分开的**。三件事错了都会出真问题：
//   ① 拉车不带渠道 → 同城模式下打开购物车看到的是邮寄的货；
//   ② 结算路由不分流 → 同城的车走进邮寄结算页，没有地址定位、没有配送费，
//      提交时被服务端 42224「商品渠道不符」拒掉，而顾客完全不知道为什么；
//   ③ 切渠道不清空 → 新渠道的车拉回来之前，屏幕上还是上一个渠道的商品与合计。
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

function makeCtx(channel, carts) {
  const urls = []
  const nav = []
  const app = {
    globalData: { shoppingChannel: channel },
    getShoppingChannel: () => app.globalData.shoppingChannel,
    setShoppingChannel: (v) => { app.globalData.shoppingChannel = v; return v },
    applyCartBadge() {}, updateCartCount() { nav.push('updateCartCount') },
    enterLocalChannel() { nav.push('enterLocal'); return Promise.resolve() },
  }
  const wx = {
    getStorageSync: () => '',
    setStorageSync: () => {},
    request: (o) => {
      const u = o.url.replace(/^https?:\/\/[^/]+(\/api)?/, '')
      urls.push(u)
      const ch = /channel=LOCAL/.test(u) ? 'LOCAL' : 'EXPRESS'
      const body = /\/cart/.test(u) ? ((carts && carts[ch]) || { channel: ch, items: [], totalAmount: 0, selectedCount: 0 })
        : /\/local\/meta/.test(u) ? { enabled: true, isOpen: true, paused: null, fee: { minOrderAmount: 4000 } }
        : {}
      o.success({ statusCode: 200, data: { code: 0, message: 'ok', data: body } })
    },
    navigateTo: (o) => { nav.push('navigateTo:' + o.url) },
    switchTab: (o) => { nav.push('switchTab:' + o.url) },
    showToast: () => {}, showModal: () => {},
  }
  return { app, wx, urls, nav }
}

const settle = () => new Promise((r) => setTimeout(r, 0))
const twoItems = (ch) => ({
  channel: ch,
  items: [
    { id: 1, productName: 'A', price: 2500, quantity: 1, subtotal: 2500, isSelected: 1, status: 'ON_SHELF' },
    { id: 2, productName: 'B', price: 1500, quantity: 1, subtotal: 1500, isSelected: 1, status: 'ON_SHELF' },
  ],
  totalAmount: 4000,
  selectedCount: 2,
})

test('拉车带当前渠道：同城模式下不能拉回邮寄的车', async function () {
  for (const ch of ['LOCAL', 'EXPRESS']) {
    const ctx = makeCtx(ch, { LOCAL: twoItems('LOCAL'), EXPRESS: twoItems('EXPRESS') })
    const page = loadPage('../../apps/miniapp/pages/cart/index.js', ctx)
    page.onShow.call(page)
    await settle(); await settle()
    assert.ok(ctx.urls.some((u) => u.indexOf('/cart?channel=' + ch) === 0),
      ch + ' 应拉本渠道的车：' + ctx.urls.join(' '))
  }
})

test('结算路由按渠道分流：同城进同城结算，邮寄进邮寄结算', async function () {
  const local = makeCtx('LOCAL', { LOCAL: twoItems('LOCAL') })
  const pl = loadPage('../../apps/miniapp/pages/cart/index.js', local)
  pl.onShow.call(pl)
  await settle(); await settle()
  pl.onCheckout.call(pl)
  assert.ok(local.nav.includes('navigateTo:/pages/local/confirm?cartItemIds=1,2'),
    '同城应进同城结算：' + local.nav.join(' '))

  const express = makeCtx('EXPRESS', { EXPRESS: twoItems('EXPRESS') })
  const pe = loadPage('../../apps/miniapp/pages/cart/index.js', express)
  pe.onShow.call(pe)
  await settle(); await settle()
  pe.onCheckout.call(pe)
  assert.ok(express.nav.includes('navigateTo:/pages/order/confirm?cartItemIds=1,2'),
    '邮寄应进邮寄结算：' + express.nav.join(' '))
})

// 同城有起送线，邮寄没有。没到起送线还放行的话，顾客要走完地址、报价、
// 点提交，才在服务端撞上 42210——前面全白填。
test('同城未达起送时按钮说清还差多少，并且点不动', async function () {
  const small = { channel: 'LOCAL', items: [{ id: 1, productName: 'A', price: 1500, quantity: 1, subtotal: 1500, isSelected: 1, status: 'ON_SHELF' }], totalAmount: 1500, selectedCount: 1 }
  const ctx = makeCtx('LOCAL', { LOCAL: small })
  const page = loadPage('../../apps/miniapp/pages/cart/index.js', ctx)
  page.onShow.call(page)
  await settle(); await settle()
  assert.equal(page.data.checkoutDisabled, true)
  assert.equal(page.data.checkoutText, '还差 ¥25.00 起送')
  page.onCheckout.call(page)
  assert.ok(!ctx.nav.some((n) => n.indexOf('navigateTo:') === 0), '未达起送不该放行')
})

test('邮寄没有起送线：选中即可结算', async function () {
  const ctx = makeCtx('EXPRESS', { EXPRESS: twoItems('EXPRESS') })
  const page = loadPage('../../apps/miniapp/pages/cart/index.js', ctx)
  page.onShow.call(page)
  await settle(); await settle()
  assert.equal(page.data.checkoutDisabled, false)
  assert.equal(page.data.checkoutText, '结算（2）')
})

test('切渠道：先清空旧车再拉，不让另一个渠道的商品与合计留在屏幕上', async function () {
  const ctx = makeCtx('EXPRESS', { LOCAL: twoItems('LOCAL'), EXPRESS: twoItems('EXPRESS') })
  const page = loadPage('../../apps/miniapp/pages/cart/index.js', ctx)
  page.onShow.call(page)
  await settle(); await settle()
  assert.equal(page.data.items.length, 2)
  ctx.app.globalData.shoppingChannel = 'LOCAL'
  page.onShow.call(page)          // 不 await：要看的就是「发请求之前」那一刻
  assert.deepEqual(page.data.items, [], '旧车必须当场清掉')
  assert.equal(page.data.totalAmount, 0)
  assert.equal(page.data.selectedCount, 0)
})

// 「去逛逛」固定进邮寄主页的话，同城模式下的空车顾客会被甩去看邮寄的货。
test('空车「去逛逛」进当前渠道的分类页', async function () {
  const ctx = makeCtx('LOCAL', { LOCAL: { channel: 'LOCAL', items: [], totalAmount: 0, selectedCount: 0 } })
  const page = loadPage('../../apps/miniapp/pages/cart/index.js', ctx)
  page.onShow.call(page)
  await settle(); await settle()
  page.goShopping.call(page)
  assert.ok(ctx.nav.includes('switchTab:/pages/product/list'), '应进分类页：' + ctx.nav.join(' '))
})

// 两个车分开，顾客很容易在一边看到空车、忘了另一边还挂着东西。
test('本渠道车空时，提示另一个渠道还有几件未结算', async function () {
  const ctx = makeCtx('LOCAL', {
    LOCAL: { channel: 'LOCAL', items: [], totalAmount: 0, selectedCount: 0 },
    EXPRESS: twoItems('EXPRESS'),
  })
  const page = loadPage('../../apps/miniapp/pages/cart/index.js', ctx)
  page.onShow.call(page)
  await settle(); await settle(); await settle()
  assert.equal(page.data.otherChannelCount, 2, '应数出邮寄车里的件数')
  assert.equal(page.data.otherChannelLabel, '全国邮寄')
})
