// 同城结算页（pages/local/confirm.js）的页面级行为锁（预约送达 2026-09-21 §5.2，批次二 Task 4）。
//
// 夹具照抄 tests/miniapp/pickup-page.test.cjs 的 loadPage / makeCtx 写法。
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

function defaultMeta(overrides) {
  return Object.assign({
    enabled: true,
    isOpen: true,
    paused: null,
    holiday: null,
    closedKind: 'OPEN',
    nextOpenText: '',
    fee: { minOrderAmount: 0 },
    delivery: { scheduleEnabled: false, slotMinutes: 30, earliestScheduleText: '' },
    store: { name: '门店', phone: '13800000000', latE6: null, lngE6: null, district: '', address: '' },
  }, overrides || {})
}

function defaultQuote(overrides) {
  return Object.assign({
    enabled: true,
    isOpen: true,
    paused: null,
    nextOpenText: '',
    closedKind: 'OPEN',
    inRange: true,
    belowMin: false,
    minOrderAmount: 0,
    distanceM: 3000,
    distanceSource: 'GPS',
    fee: 500,
    quoteToken: 'qt-1',
    quoteExpiresAt: '2099-01-01T00:00:00.000Z',
    estimatedMinRange: 25,
    estimatedMaxRange: 30,
    isPeakNow: false,
    promoDiscountFen: 0,
  }, overrides || {})
}

// 与自取页的 slotsWithOneSlot 同一形状（services/slots.ts 同一个 buildSlots，两边同构）
function slotsWithOneSlot() {
  return {
    blocked: null,
    days: [
      { date: '2026-09-22', label: '今天', slots: [] },
      { date: '2026-09-23', label: '明天', slots: [{ startAt: '2026-09-23T04:00:00.000Z', endAt: '2026-09-23T04:30:00.000Z', label: '12:00–12:30' }] },
    ],
  }
}

// 原来选中的那格在重拉后已经不在列表里了（真正过期/被店主关掉）——比原样返回同一格更贴近
// 42291 场景：服务端拒单说「该时段已不可选」，重拉理应看不到它，否则 loadSlots 会把
// slotStale 悄悄纠正回 false，测不出「格失效」这条路径。
function slotsWithoutFirst() {
  return {
    blocked: null,
    days: [
      { date: '2026-09-22', label: '今天', slots: [] },
      { date: '2026-09-23', label: '明天', slots: [{ startAt: '2026-09-23T05:00:00.000Z', endAt: '2026-09-23T05:30:00.000Z', label: '13:00–13:30' }] },
    ],
  }
}

function makeCtx(opts) {
  opts = opts || {}
  const urls = []
  const requests = []
  const app = { globalData: {} }
  const cart = opts.cart || { items: [{ id: 1, quantity: 1, price: 4750, subtotal: 4750, productName: '拌兔丁', productImage: '' }] }
  const addresses = opts.addresses || [{ id: 1, isDefault: true, receiverName: '张三', receiverPhone: '13800001234', fullAddress: '自流井区丹桂路1号', latE6: 29123456, lngE6: 104456789 }]
  const meta = opts.meta || defaultMeta()
  const quote = opts.quote || defaultQuote()
  const slots = opts.slots || slotsWithOneSlot()
  const orderMeta = opts.orderMeta || { subscribeTemplateIds: [], payTimeoutMin: 15 }
  // holdMeta：把 /local/meta 的响应挂起，用来实测「报价先回、meta 后到」这条竞态
  // （硬约束要求的那一处纠正：loadMeta 的 .then 里补一次「closedNow 且 scheduleAvailable
  // 刚变为 true」的处理）。与 pickup-page.test.cjs 的 holdSlots 同一套写法。
  const heldMeta = []
  let deliverySlotCalls = 0
  let quoteCalls = 0
  let cartCalls = 0
  const ctx = { app, urls, requests, holdMeta: !!opts.holdMeta }
  ctx.releaseMeta = function () {
    const pending = heldMeta.splice(0, heldMeta.length)
    pending.forEach(function (respond) { respond() })
  }
  const wx = {
    getStorageSync: () => '',
    setStorageSync: () => {},
    showToast: () => {},
    showModal: () => {},
    navigateTo: () => {},
    redirectTo: () => {},
    switchTab: () => {},
    navigateBack: () => {},
    makePhoneCall: () => {},
    request: (o) => {
      const url = o.url.replace(/^https?:\/\/[^/]+(\/api)?/, '')
      const method = o.method || 'GET'
      urls.push(url)
      requests.push({ url: url, method: method, data: o.data })
      if (/\/cart/.test(url)) {
        cartCalls += 1
        // cartSeq（T4d 等用例）：第 n 次 GET /cart 按序返回；用尽后停在最后一项——
        // 与 quoteSeq/slotsSeq 同一套「按序、越界钳到最后一个」的约定。
        var cartData = (opts.cartSeq && opts.cartSeq.length) ? opts.cartSeq[Math.min(cartCalls - 1, opts.cartSeq.length - 1)] : cart
        o.success({ statusCode: 200, data: { code: 0, message: 'ok', data: cartData } })
        return
      }
      if (/^\/addresses/.test(url)) {
        o.success({ statusCode: 200, data: { code: 0, message: 'ok', data: addresses } })
        return
      }
      if (/\/local\/quote/.test(url) && method === 'POST') {
        quoteCalls += 1
        // quoteSeq（M4b 竞态出路 / M7 等用例）：第 n 次 /local/quote 按序返回；
        // 用尽后停在最后一项，不需要每条用例都精确算出请求会打几次。
        if (opts.quoteSeq && opts.quoteSeq.length) {
          var seqQuote = opts.quoteSeq[Math.min(quoteCalls - 1, opts.quoteSeq.length - 1)]
          o.success({ statusCode: 200, data: { code: 0, message: 'ok', data: seqQuote } })
          return
        }
        if (opts.quoteFail) {
          o.success({ statusCode: 200, data: { code: opts.quoteFail.code || 50001, message: opts.quoteFail.message || '系统开小差了' } })
          return
        }
        o.success({ statusCode: 200, data: { code: 0, message: 'ok', data: quote } })
        return
      }
      if (/\/local\/delivery-slots/.test(url)) {
        deliverySlotCalls += 1
        // slotsSeq（M9 等用例）：第 n 次 GET /local/delivery-slots 按序返回，元素可写
        // {fail:{code,message}} 模拟拉取失败；用尽后停在最后一项。与 slotsSecond
        // （只区分「第一次/之后」两档）并存，slotsSeq 存在时优先于它。
        if (opts.slotsSeq && opts.slotsSeq.length) {
          var seqEntry = opts.slotsSeq[Math.min(deliverySlotCalls - 1, opts.slotsSeq.length - 1)]
          if (seqEntry && seqEntry.fail) {
            o.success({ statusCode: 200, data: { code: seqEntry.fail.code || 50001, message: seqEntry.fail.message || '时段获取失败' } })
          } else {
            o.success({ statusCode: 200, data: { code: 0, message: 'ok', data: seqEntry } })
          }
          return
        }
        var slotsData = (opts.slotsSecond && deliverySlotCalls > 1) ? opts.slotsSecond : slots
        o.success({ statusCode: 200, data: { code: 0, message: 'ok', data: slotsData } })
        return
      }
      if (/\/local\/meta/.test(url)) {
        const respond = function () {
          o.success({ statusCode: 200, data: { code: 0, message: 'ok', data: meta } })
        }
        if (ctx.holdMeta) { heldMeta.push(respond); return }
        respond()
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
      if (/^\/orders(\?|$)/.test(url) && method === 'POST') {
        if (opts.createOrderFail) {
          o.success({ statusCode: 200, data: { code: opts.createOrderFail.code, message: opts.createOrderFail.message || '下单失败' } })
          return
        }
        o.success({ statusCode: 200, data: { code: 0, message: 'ok', data: { orderId: 1 } } })
        return
      }
      o.success({ statusCode: 200, data: { code: 0, message: 'ok', data: {} } })
    },
  }
  ctx.wx = wx
  return ctx
}

const settle = () => new Promise((r) => setTimeout(r, 0))
async function settleAll(n) {
  for (let i = 0; i < (n || 10); i++) await settle()
}

function loadConfirm(opts) {
  const ctx = makeCtx(opts)
  const page = loadPage('../../apps/miniapp/pages/local/confirm.js', ctx)
  page.onLoad.call(page, { cartItemIds: '1' })
  return { ctx, page }
}

test('①打烊+预约开：报价成功后自动切预约、不阻塞、自动选中最早格，按钮「预约下单」', async function () {
  const { page } = loadConfirm({
    meta: defaultMeta({ isOpen: false, nextOpenText: '明天 09:00 营业', delivery: { scheduleEnabled: true, slotMinutes: 30, earliestScheduleText: '最早明天 12:00–12:30 送达' } }),
    quote: defaultQuote({ isOpen: false, nextOpenText: '明天 09:00 营业' }),
  })
  await settleAll()
  page.onTablewareConfirm.call(page, { detail: { mode: 'COUNT', count: 1 } })
  assert.equal(page.data.scheduleMode, 'SCHEDULED')
  assert.equal(page.data.blockReason, '')
  assert.equal(page.data.closedNow, true)
  assert.equal(page.data.scheduleAvailable, true)
  assert.ok(page.data.slotSelected, '应已自动选中一格')
  assert.equal(page.data.slotSelected.startAt, '2026-09-23T04:00:00.000Z')
  assert.equal(page.data.action.text, '预约下单')
  assert.equal(page.data.action.disabled, false)
  // 立即单路径逐字节不变的护栏之一：quoteToken 没被清空，能真正提交
  assert.ok(page.data.quoteToken)
})

test('②营业中：scheduleMode 停在 ASAP，不拉时段', async function () {
  const { ctx, page } = loadConfirm({
    meta: defaultMeta({ isOpen: true, delivery: { scheduleEnabled: true, slotMinutes: 30, earliestScheduleText: '' } }),
    quote: defaultQuote({ isOpen: true }),
  })
  await settleAll()
  page.onTablewareConfirm.call(page, { detail: { mode: 'COUNT', count: 1 } })
  assert.equal(page.data.scheduleMode, 'ASAP')
  assert.equal(page.data.closedNow, false)
  assert.equal(ctx.urls.some((u) => /\/local\/delivery-slots/.test(u)), false, ctx.urls.join(' '))
  assert.equal(page.data.action.text, '提交订单')
})

test('③打烊+预约关：blockReason 为 nextOpenText，金额态 blocked（与改前一致）', async function () {
  const { page } = loadConfirm({
    meta: defaultMeta({ isOpen: false, nextOpenText: '明天 09:00 营业', delivery: { scheduleEnabled: false, slotMinutes: 30, earliestScheduleText: '' } }),
    quote: defaultQuote({ isOpen: false, nextOpenText: '明天 09:00 营业' }),
  })
  await settleAll()
  assert.equal(page.data.blockReason, '明天 09:00 营业')
  assert.equal(page.data.action.amountState, 'blocked')
  assert.equal(page.data.scheduleMode, 'ASAP')
  assert.equal(page.data.slotSelected, null)
})

test('④选好格后 invalidateCheckout：slotSelected 清空', async function () {
  const { page } = loadConfirm({
    meta: defaultMeta({ isOpen: false, nextOpenText: '明天 09:00 营业', delivery: { scheduleEnabled: true, slotMinutes: 30, earliestScheduleText: '' } }),
    quote: defaultQuote({ isOpen: false, nextOpenText: '明天 09:00 营业' }),
  })
  await settleAll()
  assert.ok(page.data.slotSelected)
  page.invalidateCheckout.call(page, 'address')
  assert.equal(page.data.slotSelected, null)
  assert.equal(page.data.slotStale, false)
})

test('⑤createOrder 返回 42291：slotStale=true 且重拉时段', async function () {
  const { ctx, page } = loadConfirm({
    meta: defaultMeta({ isOpen: false, nextOpenText: '明天 09:00 营业', delivery: { scheduleEnabled: true, slotMinutes: 30, earliestScheduleText: '' } }),
    quote: defaultQuote({ isOpen: false, nextOpenText: '明天 09:00 营业' }),
    createOrderFail: { code: 42291, message: '该时段已不可选，请重新选择' },
    slotsSecond: slotsWithoutFirst(),
  })
  await settleAll()
  page.onTablewareConfirm.call(page, { detail: { mode: 'COUNT', count: 1 } })
  assert.equal(page.data.action.action, 'submit')
  const slotCallsBefore = ctx.urls.filter((u) => /\/local\/delivery-slots/.test(u)).length
  page.onSubmit.call(page)
  await settleAll()
  assert.equal(page.data.slotStale, true)
  const slotCallsAfter = ctx.urls.filter((u) => /\/local\/delivery-slots/.test(u)).length
  assert.ok(slotCallsAfter > slotCallsBefore, '应已重新拉取时段')
})

test('⑥提交时 createOrder 收到的 scheduledAt 等于所选格 startAt', async function () {
  const { ctx, page } = loadConfirm({
    meta: defaultMeta({ isOpen: false, nextOpenText: '明天 09:00 营业', delivery: { scheduleEnabled: true, slotMinutes: 30, earliestScheduleText: '' } }),
    quote: defaultQuote({ isOpen: false, nextOpenText: '明天 09:00 营业' }),
  })
  await settleAll()
  page.onTablewareConfirm.call(page, { detail: { mode: 'COUNT', count: 1 } })
  assert.equal(page.data.action.action, 'submit')
  page.onSubmit.call(page)
  await settleAll()
  const createReq = ctx.requests.find((r) => r.method === 'POST' && /^\/orders(\?|$)/.test(r.url))
  assert.ok(createReq, '应已发出建单请求')
  assert.equal(createReq.data.scheduledAt, page.data.slotSelected ? page.data.slotSelected.startAt : '2026-09-23T04:00:00.000Z')
  assert.equal(createReq.data.scheduledAt, '2026-09-23T04:00:00.000Z')
})

test('⑦报价先回、meta 后到（打烊竞态）：meta 落地后自动纠正为预约模式、清阻塞、拉时段', async function () {
  const { ctx, page } = loadConfirm({
    holdMeta: true,
    meta: defaultMeta({ isOpen: false, nextOpenText: '明天 09:00 营业', delivery: { scheduleEnabled: true, slotMinutes: 30, earliestScheduleText: '' } }),
    quote: defaultQuote({ isOpen: false, nextOpenText: '明天 09:00 营业' }),
  })
  // meta 还没回来：报价已经先回来，此刻 scheduleAvailable 还是初值 false，
  // 按老逻辑会被判成阻塞
  await settleAll()
  assert.equal(page.data.blockReason, '明天 09:00 营业')
  assert.equal(page.data.scheduleMode, 'ASAP')
  assert.equal(ctx.urls.some((u) => /\/local\/delivery-slots/.test(u)), false, ctx.urls.join(' '))

  // meta 落地：应纠正为预约模式、清阻塞、拉时段并自动选中最早格
  ctx.releaseMeta()
  await settleAll()
  assert.equal(page.data.blockReason, '')
  assert.equal(page.data.scheduleMode, 'SCHEDULED')
  assert.ok(page.data.quoteToken, 'quoteToken 应已恢复')
  assert.ok(page.data.slotSelected, '应已自动选中最早格')
  page.onTablewareConfirm.call(page, { detail: { mode: 'COUNT', count: 1 } })
  assert.equal(page.data.action.text, '预约下单')
})

test('⑦b 报价先回（打烊竞态）纠正后头条同步改为预约软提示，不再是旧的阻塞文案（R1）', async function () {
  const { ctx, page } = loadConfirm({
    holdMeta: true,
    meta: defaultMeta({ isOpen: false, nextOpenText: '明天 09:00 营业', delivery: { scheduleEnabled: true, slotMinutes: 30, earliestScheduleText: '' } }),
    quote: defaultQuote({ isOpen: false, nextOpenText: '明天 09:00 营业' }),
  })
  // meta 还没回来：报价先落地，按老逻辑头条判成阻塞（旧「明天 09:00 营业」+ 可点的改邮寄按钮）
  await settleAll()
  assert.equal(page.data.headBlocking, true)
  assert.ok(/明天 09:00 营业/.test(page.data.headNotice), page.data.headNotice)

  // meta 落地纠正：headBlocking 必须转为 false，headNotice 改成与报价成功分支同一口径的
  // 「本单为预约配送」软提示，blockReason 清空——三者必须同步，否则顶部仍显示「打烊/去
  // 邮寄」的旧警示，与下面已可提交的预约单状态矛盾（R1）
  ctx.releaseMeta()
  await settleAll()
  assert.equal(page.data.headBlocking, false)
  assert.ok(/预约/.test(page.data.headNotice), page.data.headNotice)
  assert.equal(page.data.blockReason, '')
  assert.ok(page.data.quoteToken, 'quoteToken 应已恢复')
  assert.equal(page.data.payAmount != null, true, 'payAmount 应已恢复为可提交的数字')
  page.onTablewareConfirm.call(page, { detail: { mode: 'COUNT', count: 1 } })
  assert.equal(page.data.action.text, '预约下单')
})

test('⑧营业中 + 预约未开通：点「预约时段」不切模式、不拉时段（R3）', async function () {
  const { ctx, page } = loadConfirm({
    meta: defaultMeta({ isOpen: true, delivery: { scheduleEnabled: false, slotMinutes: 30, earliestScheduleText: '' } }),
    quote: defaultQuote({ isOpen: true }),
  })
  await settleAll()
  assert.equal(page.data.scheduleAvailable, false)
  page.pickMode.call(page, { currentTarget: { dataset: { mode: 'SCHEDULED' } } })
  await settleAll()
  assert.equal(page.data.scheduleMode, 'ASAP', '预约未开通时点「预约时段」不应切换模式')
  assert.equal(ctx.urls.some((u) => /\/local\/delivery-slots/.test(u)), false, ctx.urls.join(' '))
  page.onTablewareConfirm.call(page, { detail: { mode: 'COUNT', count: 1 } })
  assert.equal(page.data.action.text, '提交订单')
})

test('⑨打烊强制预约场景下，再点一次已选中的「预约时段」卡片应打开时段选择器（fix-picker）', async function () {
  const { page } = loadConfirm({
    meta: defaultMeta({ isOpen: false, nextOpenText: '明天 09:00 营业', delivery: { scheduleEnabled: true, slotMinutes: 30, earliestScheduleText: '最早明天 12:00–12:30 送达' } }),
    quote: defaultQuote({ isOpen: false, nextOpenText: '明天 09:00 营业' }),
  })
  await settleAll()
  assert.equal(page.data.scheduleMode, 'SCHEDULED', '打烊应已自动切到预约')
  assert.equal(page.data.pickerOpen, false, '弹层初始应关闭')
  page.pickMode.call(page, { currentTarget: { dataset: { mode: 'SCHEDULED' } } })
  assert.equal(page.data.pickerOpen, true, '已是预约模式时再点卡片应打开弹层')
  assert.equal(page.data.scheduleMode, 'SCHEDULED', '模式不应被重复点击改变')
})

// M4/M4b（复审阻塞，2026-09-23）：打烊 + 预约开时，超范围/未达起送这类与「打烊」无关
// 的业务阻塞必须优先展示，不能被 NO_SLOT（请选择送达时段）或竞态纠正悄悄抹掉。
test('T4b M4：打烊+预约开+未达起送，页面判 BLOCKED 而非 NO_SLOT，onSubmit 不提交也不开弹层', async function () {
  const { ctx, page } = loadConfirm({
    meta: defaultMeta({ isOpen: false, nextOpenText: '明天 09:00 营业', delivery: { scheduleEnabled: true, slotMinutes: 30, earliestScheduleText: '' } }),
    quote: defaultQuote({ isOpen: false, nextOpenText: '明天 09:00 营业', belowMin: true, minOrderAmount: 10000, quoteToken: null }),
  })
  await settleAll()
  assert.equal(page.data.action.text, '暂不可配送')
  assert.equal(page.data.action.amountState, 'blocked')
  assert.match(page.data.blockReason, /起送/)
  page.onTablewareConfirm.call(page, { detail: { mode: 'COUNT', count: 1 } })
  const ordersBefore = ctx.requests.filter((r) => r.method === 'POST' && /^\/orders(\?|$)/.test(r.url)).length
  page.onSubmit.call(page)
  await settleAll()
  assert.equal(page.data.pickerOpen, false)
  assert.equal(ctx.requests.filter((r) => r.method === 'POST' && /^\/orders(\?|$)/.test(r.url)).length, ordersBefore)

  // 超出配送范围同理
  const { page: page2 } = loadConfirm({
    meta: defaultMeta({ isOpen: false, nextOpenText: '明天 09:00 营业', delivery: { scheduleEnabled: true, slotMinutes: 30, earliestScheduleText: '' } }),
    quote: defaultQuote({ isOpen: false, nextOpenText: '明天 09:00 营业', inRange: false, distanceM: 12400, quoteToken: null }),
  })
  await settleAll()
  assert.match(page2.data.blockReason, /超出配送范围/)
  assert.equal(page2.data.action.amountState, 'blocked')
})

// M4b：报价先回来时 scheduleAvailable 还是初值 false，若报价本身有超范围/未达起送这类
// 与打烊无关的业务阻塞，loadMeta 后到时的竞态纠正不能无条件把它当「预约开着就放行」，
// 必须按与 refreshQuote 成功分支同一套优先级重新判一次。
test('T4c M4b：打烊竞态纠正遇到未达起送，blockReason 改判为「起送」而不是被无条件清空', async function () {
  const { ctx, page } = loadConfirm({
    holdMeta: true,
    meta: defaultMeta({ isOpen: false, nextOpenText: '明天 09:00 营业', delivery: { scheduleEnabled: true, slotMinutes: 30, earliestScheduleText: '' } }),
    quote: defaultQuote({ isOpen: false, nextOpenText: '明天 09:00 营业', belowMin: true, minOrderAmount: 10000, quoteToken: null }),
  })
  await settleAll()
  // meta 还没回来：报价先落地，此刻按老逻辑判成「打烊」阻塞
  assert.equal(page.data.scheduleMode, 'ASAP')

  ctx.releaseMeta()
  await settleAll()
  assert.match(page.data.blockReason, /起送/, page.data.blockReason)
  assert.equal(page.data.action.text, '暂不可配送')
  assert.equal(page.data.action.amountState, 'blocked')
  assert.equal(page.data.scheduleMode, 'ASAP')
  assert.equal(page.data.quoteToken, null)
})

// T4d：T4c 之后顾客把商品加够、重新报价成功（isOpen 仍 false 但 belowMin 已转 false）——
// 应正常自动切预约并预选最早格，证明 M4b 的守卫不是把这条路彻底堵死，只是不再无条件放行。
test('T4d M4b 出路：加够金额后重新报价成功，自动切预约并预选最早格', async function () {
  const { ctx, page } = loadConfirm({
    quoteSeq: [
      defaultQuote({ isOpen: false, nextOpenText: '明天 09:00 营业', belowMin: true, minOrderAmount: 10000, quoteToken: null }),
      defaultQuote({ isOpen: false, nextOpenText: '明天 09:00 营业', belowMin: false }),
    ],
    meta: defaultMeta({ isOpen: false, nextOpenText: '明天 09:00 营业', delivery: { scheduleEnabled: true, slotMinutes: 30, earliestScheduleText: '' } }),
  })
  await settleAll()
  assert.match(page.data.blockReason, /起送/)
  page.onIncrease.call(page, { currentTarget: { dataset: { id: 1 } } })
  // scheduleQuote 的 500ms 去抖是真实定时器，settleAll 的 setTimeout(0) 追不上，
  // 必须真等过去（与 M1 的 T1a/T1b 同一手法）。
  await new Promise((r) => setTimeout(r, 600))
  await settleAll()
  assert.equal(page.data.blockReason, '')
  assert.equal(page.data.scheduleMode, 'SCHEDULED')
  assert.ok(page.data.slotSelected, '应已自动选中最早格')
  page.onTablewareConfirm.call(page, { detail: { mode: 'COUNT', count: 1 } })
  assert.equal(page.data.action.text, '预约下单')
})

test('onSubmit 在 action:slot 时只打开选择器，不提交订单', async function () {
  const { ctx, page } = loadConfirm({
    meta: defaultMeta({ isOpen: true, delivery: { scheduleEnabled: true, slotMinutes: 30, earliestScheduleText: '' } }),
    quote: defaultQuote({ isOpen: true }),
  })
  await settleAll()
  page.pickMode.call(page, { currentTarget: { dataset: { mode: 'SCHEDULED' } } })
  await settleAll()
  assert.equal(page.data.scheduleMode, 'SCHEDULED')
  assert.equal(page.data.slotSelected, null, '营业中主动切预约不代为选格')
  assert.equal(page.data.action.action, 'slot')
  page.closePicker.call(page)
  page.onSubmit.call(page)
  assert.equal(page.data.pickerOpen, true)
  assert.equal(ctx.requests.some((r) => r.method === 'POST' && /^\/orders(\?|$)/.test(r.url)), false, ctx.urls.join(' '))
})
