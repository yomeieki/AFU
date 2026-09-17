// 自取结算页（pages/local/pickup.js）的页面级行为锁（2026-09-17 返工）。
//
// 02 复核 + 03 回判实测：把 pickup.js 里 patch.selected 改回自动预填第一格
// （等于撤销「顾客自己选时段」这个需求）之后，utils/pickup-checkout-state.js
// 的纯函数用例照样全绿——核心行为完全没有护栏。这份文件补的就是这道护栏，
// 锁住「拉到有格的时段 → 停在未选 → 顾客自己点」这条链路，而不是只测判定函数。
//
// 夹具照抄 tests/miniapp/category-anchor-page.test.cjs 的 loadPage / makeCtx 写法。
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
  registered._patches = []
  registered.setData = function (patch) {
    registered._patches.push(patch)
    Object.assign(registered.data, patch)
  }
  registered.selectComponent = () => null
  return registered
}

function makeCtx(opts) {
  opts = opts || {}
  const urls = []
  const requests = []
  const app = {
    globalData: {},
    setLocalMode: () => {},
    setShoppingChannel: () => {},
  }
  const cart = opts.cart || { items: [{ id: 1, quantity: 1, price: 4750, subtotal: 4750, productName: '拌兔丁', productImage: '' }] }
  const meta = opts.meta || {
    store: { name: '门店', district: '', address: '', latE6: null, lngE6: null },
    pickup: { enabled: true, paused: null, minOrderAmountFen: 0, discount: null },
  }
  const contact = opts.contact === undefined ? { name: '', phone: '13800001234' } : opts.contact
  const orderMeta = opts.orderMeta || { subscribeTemplateIds: [], payTimeoutMin: 15 }
  const wx = {
    getStorageSync: () => '',
    setStorageSync: () => {},
    showToast: () => {},
    showModal: () => {},
    navigateTo: () => {},
    redirectTo: () => {},
    switchTab: () => {},
    makePhoneCall: () => {},
    openLocation: () => {},
    request: (o) => {
      const url = o.url.replace(/^https?:\/\/[^/]+(\/api)?/, '')
      urls.push(url)
      requests.push({ url: url, method: o.method || 'GET', data: o.data })
      if (/\/cart/.test(url)) {
        o.success({ statusCode: 200, data: { code: 0, message: 'ok', data: cart } })
        return
      }
      if (/\/local\/pickup-slots/.test(url)) {
        if (opts.slotsFail) {
          o.success({ statusCode: 200, data: { code: 50001, message: '系统开小差了' } })
          return
        }
        o.success({ statusCode: 200, data: { code: 0, message: 'ok', data: opts.slots || { blocked: null, days: [] } } })
        return
      }
      if (/\/local\/meta/.test(url)) {
        o.success({ statusCode: 200, data: { code: 0, message: 'ok', data: meta } })
        return
      }
      if (/\/orders\/pickup-contact/.test(url)) {
        o.success({ statusCode: 200, data: { code: 0, message: 'ok', data: contact } })
        return
      }
      if (/\/orders\/meta/.test(url)) {
        o.success({ statusCode: 200, data: { code: 0, message: 'ok', data: orderMeta } })
        return
      }
      if (/\/orders\/tableware-last/.test(url) || /\/orders\/last-tableware/.test(url)) {
        o.success({ statusCode: 200, data: { code: 0, message: 'ok', data: opts.lastTableware || null } })
        return
      }
      if (/^\/orders(\?|$)/.test(url) && (o.method || 'GET') === 'POST') {
        o.success({ statusCode: 200, data: { code: 0, message: 'ok', data: { orderId: 1 } } })
        return
      }
      o.success({ statusCode: 200, data: { code: 0, message: 'ok', data: {} } })
    },
  }
  return { app, wx, urls, requests, getSelectorQueryCalls: () => 0 }
}

const settle = () => new Promise((r) => setTimeout(r, 0))
async function settleAll(n) {
  for (let i = 0; i < (n || 6); i++) await settle()
}

function slotsWithOneSlot() {
  return {
    blocked: null,
    days: [
      { date: '2026-09-17', label: '今天', slots: [] },
      { date: '2026-09-18', label: '明天', slots: [{ startAt: '2026-09-18T10:00:00.000Z', endAt: '2026-09-18T10:30:00.000Z', label: '10:00–10:30' }] },
    ],
  }
}

function slotsEmpty() {
  return {
    blocked: null,
    days: [
      { date: '2026-09-17', label: '今天', slots: [] },
      { date: '2026-09-18', label: '明天', slots: [] },
    ],
  }
}

function loadPickup(opts) {
  const ctx = makeCtx(opts)
  const page = loadPage('../../apps/miniapp/pages/local/pickup.js', ctx)
  page.onLoad.call(page, { cartItemIds: '1' })
  return { ctx, page }
}

test('拉到有格的时段：停在未选、有格可选、弹层未开、按钮可点去开时段选择器、金额照常显示', async function () {
  const { page } = loadPickup({ slots: slotsWithOneSlot() })
  await settleAll()
  assert.equal(page.data.selected, null)
  assert.equal(page.data.hasAnySlot, true)
  assert.equal(page.data.pickerOpen, false)
  assert.equal(page.data.action.action, 'slot')
  assert.equal(page.data.action.disabled, false)
  assert.equal(page.data.action.amountState, 'ready')
})

test('onSubmit 在 action:slot 时只打开选择器，不提交订单', async function () {
  const { ctx, page } = loadPickup({ slots: slotsWithOneSlot() })
  await settleAll()
  assert.equal(page.data.action.action, 'slot')
  page.onSubmit.call(page)
  assert.equal(page.data.pickerOpen, true)
  assert.equal(ctx.requests.some((r) => r.method === 'POST' && /^\/orders(\?|$)/.test(r.url)), false, ctx.urls.join(' '))
})

test('选中某格后 selected 非空，action 从 slot 前进到下一格', async function () {
  const { page } = loadPickup({ slots: slotsWithOneSlot() })
  await settleAll()
  assert.equal(page.data.activeDay, 1) // 今天为空，落到明天
  page.selectSlot.call(page, { currentTarget: { dataset: { idx: 0 } } })
  assert.ok(page.data.selected)
  assert.equal(page.data.selected.startAt, '2026-09-18T10:00:00.000Z')
  assert.notEqual(page.data.action.action, 'slot')
})

test('days 全空：禁用提交，文案「暂无可取时段」', async function () {
  const { page } = loadPickup({ slots: slotsEmpty() })
  await settleAll()
  assert.equal(page.data.hasAnySlot, false)
  assert.equal(page.data.action.disabled, true)
  assert.equal(page.data.action.text, '暂无可取时段')
})

test('/local/pickup-slots 报错：禁用提交，文案「取餐时段获取失败」', async function () {
  const { page } = loadPickup({ slotsFail: true })
  await settleAll()
  // page.data.slotsError 存的是 request 层翻译过的原始错误文案（这里是 50001 的
  // 「系统开小差了」），按钮文案不用它——底部按钮的文案由 pickupCheckoutAction 按
  // slotsError 这个布尔位统一给「取餐时段获取失败」，与具体错误原因无关
  assert.ok(page.data.slotsError)
  assert.equal(page.data.action.disabled, true)
  assert.equal(page.data.action.text, '取餐时段获取失败')
})

test('首屏（时段还没回来）：按钮禁用、动作是 none', function () {
  const { page } = loadPickup({ slots: slotsWithOneSlot() })
  // 不 settle：模拟请求在途时的首屏状态
  assert.equal(page.data.action.disabled, true)
  assert.equal(page.data.action.action, 'none')
})

test('openPicker 在时段加载中 / 出错时不打开弹层', async function () {
  const { page } = loadPickup({ slotsFail: true })
  await settleAll()
  page.openPicker.call(page)
  assert.equal(page.data.pickerOpen, false)
})
