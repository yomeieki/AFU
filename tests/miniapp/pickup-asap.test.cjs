// 到店自取「尽快取」（2026-09-28，plans/2026-09-28-pickup-asap.md 测试用例 D 组）。
//
// D1/D2 纯函数 pickupCheckoutAction；D3–D5 结算页 pages/local/pickup.js 的页面级行为；
// D6 共享函数 headNoticeOf；D7 订单详情 pages/order/detail.js 的 decorateOrder。
// 页面夹具照抄 tests/miniapp/pickup-page.test.cjs 与 order-channel.test.cjs 的 loadPage / makeCtx 写法
// （各文件各自维护一份，不跨 .test.cjs 互相 require）。
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

const { pickupCheckoutAction } = require('../../apps/miniapp/utils/pickup-checkout-state')
const { headNoticeOf } = require('../../apps/miniapp/utils/local-catalog')
const asapUtil = require('../../apps/miniapp/utils/pickup-asap')

// ── D1 / D2：按钮判定 ────────────────────────────────────────────────
// 覆盖所有影响分支的布尔组合（外加两档金额与起送差额），逐一比对
function actionInputs() {
  const out = []
  const bools = ['blockReason', 'slotsLoading', 'slotsError', 'noSlots', 'hasSlot', 'slotStale', 'phoneValid', 'promoError', 'hasTableware', 'benefitsLoading', 'submitting']
  const n = bools.length
  for (let mask = 0; mask < (1 << n); mask++) {
    for (const payAmount of [null, 3420]) {
      for (const belowMinGap of [0, 500]) {
        const s = { payAmount, belowMinGap }
        bools.forEach((k, i) => { s[k] = (mask >> i) & 1 ? (k === 'blockReason' ? '休息中' : true) : (k === 'blockReason' ? '' : false) })
        out.push(s)
      }
    }
  }
  return out
}

test('D1 pickupCheckoutAction：不传新入参 / mode=SCHEDULED / 只传 asapAvailable 时与不传逐字节一致', function () {
  let n = 0
  for (const s of actionInputs()) {
    const base = JSON.stringify(pickupCheckoutAction(s))
    assert.equal(JSON.stringify(pickupCheckoutAction(Object.assign({}, s, { mode: 'SCHEDULED' }))), base)
    assert.equal(JSON.stringify(pickupCheckoutAction(Object.assign({}, s, { mode: 'SCHEDULED', asapAvailable: true }))), base)
    assert.equal(JSON.stringify(pickupCheckoutAction(Object.assign({}, s, { asapAvailable: false }))), base)
    n++
  }
  assert.ok(n > 8000, '组合数 ' + n)
})

test('D2 尽快模式：不需要时段也能提交（asap 可用、手机号合法、达起送、餐具已选）', function () {
  const ok = { mode: 'ASAP', asapAvailable: true, phoneValid: true, belowMinGap: 0, payAmount: 3420, hasTableware: true }
  // 时段相关的五格一律不挡：没选时段、时段在加载、时段拉取失败、无格、已选的失效
  for (const extra of [{}, { slotsLoading: true }, { slotsError: true }, { noSlots: true }, { hasSlot: true, slotStale: true }]) {
    assert.deepEqual(pickupCheckoutAction(Object.assign({}, ok, extra)), { disabled: false, text: '提交订单', amountState: 'ready', action: 'submit' }, JSON.stringify(extra))
  }
  // 其余前置条件照旧生效
  assert.equal(pickupCheckoutAction(Object.assign({}, ok, { phoneValid: false })).text, '请填写手机号')
  assert.equal(pickupCheckoutAction(Object.assign({}, ok, { belowMinGap: 500 })).disabled, true)
  assert.equal(pickupCheckoutAction(Object.assign({}, ok, { hasTableware: false })).action, 'tableware')
  assert.equal(pickupCheckoutAction(Object.assign({}, ok, { blockReason: '休息中' })).action, 'none')
})

test('D2 尽快模式下 asap 变成不可用：任何输入下按钮都不会落到 submit', function () {
  let n = 0
  for (const s of actionInputs()) {
    const r = pickupCheckoutAction(Object.assign({}, s, { mode: 'ASAP', asapAvailable: false }))
    assert.notEqual(r.action, 'submit', JSON.stringify(s))
    if (!s.blockReason) {
      assert.equal(r.action, 'schedule', JSON.stringify(s))
      assert.equal(r.disabled, false)
    }
    n++
  }
  assert.ok(n > 8000)
})

// ── 页面夹具 ─────────────────────────────────────────────────────────
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
  registered.data = JSON.parse(JSON.stringify(registered.data))
  registered.setData = function (patch) { Object.assign(registered.data, patch) }
  registered.selectComponent = () => null
  if (typeof registered.startTicker === 'function') registered.startTicker = () => {}
  return registered
}

const ONE_SLOT = { startAt: '2026-09-28T04:00:00.000Z', endAt: '2026-09-28T04:30:00.000Z', label: '12:00–12:30' }
function slotsView(asap) {
  const v = { blocked: null, earliestAt: ONE_SLOT.startAt, slotMinutes: 30, days: [{ date: '2026-09-28', label: '今天', slots: [ONE_SLOT] }] }
  if (asap !== undefined) v.asap = asap
  return v
}
const ASAP_OK = { available: true, readyAt: '2026-09-28T03:40:00.000Z', minutes: 20, reason: null }
const ASAP_CLOSED = { available: false, readyAt: null, minutes: null, reason: 'CLOSED' }

function makePickupCtx(opts) {
  const requests = []
  const toasts = []
  let slots = opts.slots
  const ctx = {
    requests, toasts,
    setSlots(v) { slots = v },
    app: { globalData: {}, setLocalMode() {}, setShoppingChannel() {} },
  }
  ctx.wx = {
    getStorageSync: () => '', setStorageSync() {},
    showToast: (o) => { toasts.push(o.title) }, showModal() {}, navigateTo() {}, redirectTo() {}, switchTab() {},
    makePhoneCall() {}, openLocation() {},
    request: (o) => {
      const url = o.url.replace(/^https?:\/\/[^/]+(\/api)?/, '')
      requests.push({ url, method: o.method || 'GET', data: o.data })
      const ok = (data) => o.success({ statusCode: 200, data: { code: 0, message: 'ok', data } })
      if (/\/cart/.test(url)) return ok({ items: [{ id: 1, quantity: 1, price: 4750, subtotal: 4750, productName: '拌兔丁', productImage: '' }] })
      if (/\/local\/pickup-slots/.test(url)) return ok(slots)
      if (/\/local\/meta/.test(url)) return ok({ store: { name: '门店' }, pickup: { enabled: true, paused: null, minOrderAmountFen: 0, discount: null, asap: slots && slots.asap } })
      if (/\/orders\/pickup-contact/.test(url)) return ok({ name: '', phone: '13800001234' })
      if (/\/orders\/meta/.test(url)) return ok({ subscribeTemplateIds: [], payTimeoutMin: 15 })
      if (/\/orders\/(tableware-last|last-tableware)/.test(url)) return ok(null)
      if (/^\/orders(\?|$)/.test(url) && (o.method || 'GET') === 'POST') {
        if (opts.orderFail) return o.success({ statusCode: 200, data: { code: opts.orderFail.code, message: opts.orderFail.message, data: null } })
        return ok({ orderId: 1, actualAmount: 4750 })
      }
      return ok({})
    },
  }
  return ctx
}
const settle = () => new Promise((r) => setTimeout(r, 0))
async function settleAll(n) { for (let i = 0; i < (n || 8); i++) await settle() }
function loadPickup(opts) {
  const ctx = makePickupCtx(opts)
  const page = loadPage('../../apps/miniapp/pages/local/pickup.js', ctx)
  page.onLoad.call(page, { cartItemIds: '1' })
  return { ctx, page }
}
// 下单成功后页面 800ms 后 redirectTo 详情页：等它在本条用例内跑完，别漏到下一条用例换掉的 wx 上
const waitRedirect = () => new Promise((r) => setTimeout(r, 900))
const orderPosts = (ctx) => ctx.requests.filter((r) => r.method === 'POST' && /^\/orders(\?|$)/.test(r.url))
const slotFetches = (ctx) => ctx.requests.filter((r) => /\/local\/pickup-slots/.test(r.url)).length

// ── D3：结算页默认模式 ──────────────────────────────────────────────
test('D3 asap.available=true → 默认选中尽快取、显示「预计 HH:mm 可取」、不需要选时段', async function () {
  const { page } = loadPickup({ slots: slotsView(ASAP_OK) })
  await settleAll()
  assert.equal(page.data.pickupMode, 'ASAP')
  assert.equal(page.data.asap.available, true)
  assert.equal(page.data.asap.readyText, '11:40')
  assert.equal(page.data.asap.subText, '约 20 分钟')
  assert.equal(page.data.selected, null, '尽快取不预选时段')
  // 还差餐具：动作是选餐具，不是选时段
  assert.equal(page.data.action.action, 'tableware')
  page.onTablewareConfirm.call(page, { detail: { mode: 'COUNT', count: 1 } })
  assert.equal(page.data.action.action, 'submit')
  assert.equal(page.data.action.disabled, false)
  // 尽快取模式下点卡片不弹时段
  page.openPicker.call(page)
  assert.equal(page.data.pickerOpen, false)
})

test('D3 asap.available=false → 尽快取置灰、停在预约、时段不自动预选、提示按 reason', async function () {
  const { page } = loadPickup({ slots: slotsView(ASAP_CLOSED) })
  await settleAll()
  assert.equal(page.data.pickupMode, 'SCHEDULED')
  assert.equal(page.data.asap.available, false)
  assert.equal(page.data.asap.subText, '当前不可用')
  assert.equal(page.data.asap.hint, '现在不在营业时间，只能预约')
  assert.equal(page.data.selected, null)
  assert.equal(page.data.action.action, 'slot')
  // 置灰的尽快取点不动
  page.pickMode.call(page, { currentTarget: { dataset: { mode: 'ASAP' } } })
  assert.equal(page.data.pickupMode, 'SCHEDULED')
})

test('D3 老服务端没有 asap 字段 → 与改前一样只有预约：mode=SCHEDULED、asap=null、按钮去选时段', async function () {
  const { page } = loadPickup({ slots: slotsView(undefined) })
  await settleAll()
  assert.equal(page.data.asap, null)
  assert.equal(page.data.pickupMode, 'SCHEDULED')
  assert.equal(page.data.selected, null)
  assert.equal(page.data.action.action, 'slot')
  page.onSubmit.call(page)
  assert.equal(page.data.pickerOpen, true)
})

test('D3 刷新时尽快取变成不可用：切回预约并提示；按钮不再是 submit', async function () {
  const { ctx, page } = loadPickup({ slots: slotsView(ASAP_OK) })
  await settleAll()
  page.onTablewareConfirm.call(page, { detail: { mode: 'COUNT', count: 1 } })
  assert.equal(page.data.action.action, 'submit')
  ctx.setSlots(slotsView(ASAP_CLOSED))
  page.onShow.call(page)
  await settleAll()
  assert.equal(page.data.pickupMode, 'SCHEDULED')
  assert.ok(ctx.toasts.some((t) => /尽快取暂不可用/.test(t)), ctx.toasts.join(' | '))
  assert.notEqual(page.data.action.action, 'submit')
})

// ── D4：提交载荷与幂等键 ─────────────────────────────────────────────
test('D4 尽快取提交：带 pickupMode:ASAP、不带 pickupAt', async function () {
  const { ctx, page } = loadPickup({ slots: slotsView(ASAP_OK) })
  await settleAll()
  page.onTablewareConfirm.call(page, { detail: { mode: 'COUNT', count: 1 } })
  page.doSubmit.call(page)
  await settleAll()
  const posts = orderPosts(ctx)
  assert.equal(posts.length, 1)
  assert.equal(posts[0].data.pickupMode, 'ASAP')
  assert.equal('pickupAt' in posts[0].data && posts[0].data.pickupAt !== undefined, false, JSON.stringify(posts[0].data))
  assert.equal(posts[0].data.deliveryType, 'PICKUP')
  assert.deepEqual(posts[0].data.pickupContact, { phone: '13800001234' })
  await waitRedirect()
})

test('D4 预约提交：带 pickupAt、不带 pickupMode（与改前请求一致）；切换模式换新 clientRequestId', async function () {
  const { ctx, page } = loadPickup({ slots: slotsView(ASAP_OK) })
  await settleAll()
  const id0 = page._clientRequestId
  page.pickMode.call(page, { currentTarget: { dataset: { mode: 'SCHEDULED' } } })
  assert.equal(page.data.pickupMode, 'SCHEDULED')
  assert.equal(page.data.pickerOpen, true, '切到预约且没选过时段 → 直接打开时段弹层')
  const id1 = page._clientRequestId
  assert.notEqual(id1, id0)
  page.selectSlot.call(page, { currentTarget: { dataset: { idx: 0 } } })
  page.onTablewareConfirm.call(page, { detail: { mode: 'COUNT', count: 1 } })
  page.pickMode.call(page, { currentTarget: { dataset: { mode: 'ASAP' } } })
  const id2 = page._clientRequestId
  assert.notEqual(id2, id1)
  page.pickMode.call(page, { currentTarget: { dataset: { mode: 'SCHEDULED' } } })
  assert.notEqual(page._clientRequestId, id2)
  assert.equal(page.data.action.action, 'submit')
  const idAtSubmit = page._clientRequestId
  page.doSubmit.call(page)
  await settleAll()
  const post = orderPosts(ctx)[0]
  assert.equal(post.data.pickupAt, ONE_SLOT.startAt)
  assert.equal('pickupMode' in post.data, false, JSON.stringify(post.data))
  assert.equal(post.data.clientRequestId, idAtSubmit, '提交用的是最后一次切换后换出的幂等键')
  assert.notEqual(idAtSubmit, id0)
  await waitRedirect()
})

// ── D5：42285 ──────────────────────────────────────────────────────
test('D5 下单返回 42285：弹提示、重拉时段、切回预约、清掉已选时段', async function () {
  const { ctx, page } = loadPickup({ slots: slotsView(ASAP_OK), orderFail: { code: 42285, message: '现在不在营业时间，暂不能尽快取，请预约取餐时间' } })
  await settleAll()
  page.onTablewareConfirm.call(page, { detail: { mode: 'COUNT', count: 1 } })
  // 造一个「之前选过的时段」，验证会被清掉
  page.setData({ selected: { startAt: ONE_SLOT.startAt, endAt: ONE_SLOT.endAt, label: ONE_SLOT.label, dayLabel: '今天', text: '今天 12:00–12:30' } })
  const before = slotFetches(ctx)
  page.doSubmit.call(page)
  await settleAll()
  assert.equal(page.data.pickupMode, 'SCHEDULED')
  assert.equal(page.data.selected, null)
  assert.ok(slotFetches(ctx) > before, '应重拉时段')
  assert.ok(ctx.toasts.some((t) => /尽快取/.test(t)), ctx.toasts.join(' | '))
  assert.equal(page.data.submitting, false)
})

// ── D6：headNoticeOf ─────────────────────────────────────────────────
test('D6 headNoticeOf：asap 可用时自取不再出「现在下单为预约自取…」；缺失/不可用与不带 asap 逐字节一致；blocking 恒与不带 asap 相同', function () {
  const whens = ['CURRENT', 'LATER', 'NONE', undefined]
  const variants = []
  for (const when of whens) {
    for (const enabled of [true, false]) {
      for (const paused of [null, { reason: '忙' }]) {
        for (const holiday of [null, { until: '2026-10-08' }]) {
          for (const isOpen of [true, false]) {
            variants.push({ enabled: true, isOpen, closedKind: isOpen ? 'OPEN' : 'CLOSED', holiday, businessHours: [{ start: '10:00', end: '20:00' }],
              pickup: { enabled, paused, earliestPickupWhen: when, earliestPickupText: '最早明天 10:30–11:00 可取' } })
          }
        }
      }
    }
  }
  for (const meta of variants) {
    const plain = headNoticeOf(meta, 'PICKUP')
    const withPk = (asap) => Object.assign({}, meta, { pickup: Object.assign({}, meta.pickup, { asap }) })
    assert.deepEqual(headNoticeOf(withPk(ASAP_CLOSED), 'PICKUP'), plain)
    assert.deepEqual(headNoticeOf(withPk(undefined), 'PICKUP'), plain)
    assert.deepEqual(headNoticeOf(withPk(null), 'PICKUP'), plain)
    const avail = headNoticeOf(withPk(ASAP_OK), 'PICKUP')
    assert.equal(avail.blocking, plain.blocking, JSON.stringify(meta))
    if (!plain.blocking) assert.deepEqual(avail, { text: '', blocking: false }, JSON.stringify(meta))
    // 外送模式不看 asap
    assert.deepEqual(headNoticeOf(withPk(ASAP_OK), 'DELIVERY'), headNoticeOf(meta, 'DELIVERY'))
  }
  // 正例：营业段尾「本段已约不到」原本提示预约自取，现在尽快取可用时不再提示
  const tail = { enabled: true, isOpen: true, pickup: { enabled: true, paused: null, earliestPickupWhen: 'LATER', earliestPickupText: '最早明天 10:30–11:00 可取' } }
  assert.deepEqual(headNoticeOf(tail, 'PICKUP'), { text: '现在下单为预约自取，最早明天 10:30–11:00 可取', blocking: false })
  assert.deepEqual(headNoticeOf(Object.assign({}, tail, { pickup: Object.assign({}, tail.pickup, { asap: ASAP_OK }) }), 'PICKUP'), { text: '', blocking: false })
})

// ── D7：订单详情 ────────────────────────────────────────────────────
function detailOrder(extra) {
  return Object.assign({
    id: 41, orderNo: 'ORD41', deliveryType: 'PICKUP', status: 'PAID', pickupAsap: true,
    createdAt: '2026-09-28T03:19:00Z', paidAt: '2026-09-28T03:20:10Z', acceptedAt: null,
    pickupAt: '2026-09-28T03:41:00Z', pickupReadyAt: null, pickupDiscountAmount: 0,
    receiverName: '张三', receiverPhone: '13900000000', receiverFullAddress: '四川省自贡市自流井区丹桂40栋底楼',
    totalAmount: 3400, shippingFee: 0, actualAmount: 3420, refundedAmount: 0, discountAmount: 0, pointsUsed: 0,
    items: [{ id: 1, productName: '凉拌耳片', productPrice: 1800, quantity: 1, subtotal: 1800 }], refunds: [], afterSale: null,
    canSelfCancel: true, canRequestCancel: false, cancelRequestedAt: null, cancelRequestRejectedAt: null, subscribeTemplateIds: [],
    pickup: { pickupAt: '2026-09-28T03:41:00Z', pickupReadyAt: null, prepStartAt: '2026-09-28T03:21:00Z', slotLabel: '尽快取 约 11:41', asap: true, store: { name: '阿福凉菜', phone: '1', address: 'x', latE6: null, lngE6: null } },
  }, extra || {})
}
async function loadDetail(order) {
  const ctx = { app: { globalData: {} }, wx: {
    getStorageSync: () => '', setStorageSync() {}, showLoading() {}, hideLoading() {}, stopPullDownRefresh() {}, showToast() {}, setNavigationBarTitle() {},
    openLocation() {}, makePhoneCall() {},
    request: (r) => r.success({ statusCode: 200, data: { code: 0, message: 'ok', data: order } }),
  } }
  const page = loadPage('../../apps/miniapp/pages/order/detail.js', ctx)
  page.startCourierPoll = () => {}
  page.onLoad.call(page, { id: String(order.id) })
  await settleAll(4)
  const o = page.data.order
  page.onUnload.call(page)
  return o
}

test('D7 待付款的尽快单：不出任何钟点，提示付款后才出预计时间', async function () {
  const o = await loadDetail(detailOrder({ status: 'PENDING_PAYMENT', paidAt: null, canSelfCancel: true }))
  assert.equal(o.pickupAsap, true)
  assert.equal(o.pickupAsapText, '尽快取 · 付款成功后显示预计可取时间')
  assert.ok(!/\d{1,2}:\d{2}/.test(o.pickupAsapText))
  assert.equal(o.pickupSlotLabel, '', '不再出「尽快取 约 HH:mm 取」')
})

test('D7 已付款未接单：「尽快取 预计 HH:mm 可取」（取服务端重算值），接单前可取消提示 + 取消按钮，无申请取消', async function () {
  const o = await loadDetail(detailOrder({ pickup: Object.assign({}, detailOrder().pickup, { pickupAt: '2026-09-28T03:44:00Z' }) }))
  assert.equal(o.pickupAsapText, '尽快取 预计 11:44 可取')
  assert.equal(o.pickupHint, '店家接单前可随时取消，取消后原路退款')
  assert.equal(o.canSelfCancel, true)
  assert.equal(o.canRequestCancel, false)
  assert.equal(o.showLocalCancelUnavailable, false)
})

test('D7 已接单：「店家已接单，不可取消」，没有取消与申请取消按钮', async function () {
  const o = await loadDetail(detailOrder({ status: 'PREPARING', acceptedAt: '2026-09-28T03:22:00Z', canSelfCancel: false, canRequestCancel: false }))
  assert.equal(o.pickupAsapText, '尽快取 预计 11:41 可取')
  assert.equal(o.canSelfCancel, false)
  assert.equal(o.canRequestCancel, false)
  assert.equal(o.showLocalCancelUnavailable, true, '取消卡要出现')
  assert.equal(o.pickupAsapCancelCopy, '店家已接单，不可取消')
  assert.equal(o.scheduleCancelCopy, '', '取消卡 wx:else 的文案落到 pickupAsapCancelCopy')
})

test('D7 预约自取单的展示与改前一致（pickupSlotLabel 照旧、尽快字段为空）', async function () {
  const o = await loadDetail(detailOrder({ pickupAsap: false, canSelfCancel: false, pickup: Object.assign({}, detailOrder().pickup, { asap: false, slotLabel: '今天 12:00–12:30' }) }))
  assert.equal(o.pickupAsap, false)
  assert.equal(o.pickupSlotLabel, '今天 12:00–12:30')
  assert.equal(o.pickupAsapText, '')
  assert.equal(o.pickupAsapCancelCopy, '')
  assert.equal(o.pickupHint, '商家即将接单')
})

test('D7 源码级：取消卡 wx:else 用 pickupAsapCancelCopy，头部渲染 pickupAsapText', function () {
  const wxml = require('node:fs').readFileSync(path.join(__dirname, '../../apps/miniapp/pages/order/detail.wxml'), 'utf8')
  assert.ok(/local-cancel-unavailable" wx:else>\{\{[^}]*order\.pickupAsapCancelCopy/.test(wxml))
  assert.ok(/\{\{order\.pickupAsapText\}\}/.test(wxml))
})

test('pickup-asap 纯函数：decorateAsap / pickupTimePayload / asapDetailText 边界', function () {
  assert.equal(asapUtil.decorateAsap(undefined), null)
  assert.equal(asapUtil.decorateAsap('x'), null)
  assert.equal(asapUtil.decorateAsap({ available: true, readyAt: null, minutes: 20 }).available, false, '缺 readyAt 不算可用')
  assert.equal(asapUtil.decorateAsap({ available: false, reason: 'TOO_LATE' }).hint, '本段营业快结束，来不及备餐，只能预约')
  assert.deepEqual(asapUtil.pickupTimePayload('ASAP', { startAt: 'x' }), { pickupMode: 'ASAP' })
  assert.deepEqual(asapUtil.pickupTimePayload('SCHEDULED', { startAt: 'x' }), { pickupAt: 'x' })
  assert.equal(asapUtil.initialPickupMode(null), 'SCHEDULED')
  assert.equal(asapUtil.asapDetailText({ deliveryType: 'LOCAL', pickupAsap: true, status: 'PAID' }), '')
  assert.equal(asapUtil.asapDetailText({ deliveryType: 'PICKUP', pickupAsap: true, status: 'CANCELLED', paidAt: null }), '尽快取')
})
