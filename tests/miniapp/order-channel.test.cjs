// 「我的订单」按渠道收口的行为锁。
//
// 两个渠道的单混在一张列表里，顾客要在一堆邮寄单里找自己刚下的那张同城单。
// 但**过滤必须在服务端做**：客户端拿分页结果再筛会漏单——第一页 20 条里可能
// 一条同城都没有，顾客会以为自己的单丢了，而页面不解释为什么。
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const fsForTag = require('node:fs')
const vmForTag = require('node:vm')

// M2/M3：与 tests/miniapp/order-status-tag.test.cjs 同一套 node:vm 加载手法（各自
//维护一份，不跨 .test.cjs 文件 require——node --test 按文件隔离运行，互相 require
// 会把对方的用例又注册执行一遍）。tagLabelOf 让本文件的页面级用例断言「真实渲染出的
// 标签」，而不是 decorate() 算出但已经无人读取的 statusLabel 字段——那正是本文件旧
// 用例测不出 M2 回归（LOCAL SHIPPED 显示「已发货」）的原因：decorate() 里的
// LOCAL_STATUS_LABEL 一直都是对的，假绿出在渲染早就换成了这个组件。
function tagLabelOf(status, deliveryType, scheduled) {
  const file = path.resolve(__dirname, '../../apps/miniapp/components/order-status-tag/index.js')
  let config
  vmForTag.runInNewContext(fsForTag.readFileSync(file, 'utf8'), {
    require: (name) => require(path.resolve(path.dirname(file), name)),
    Component: (c) => { config = c },
  })
  const c = { data: { label: '' }, setData(p) { Object.assign(this.data, p) } }
  config.observers['status, deliveryType, scheduled'].call(c, status, deliveryType, !!scheduled)
  return c.data.label
}

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
  registered.setData = function (patch) {
    Object.keys(patch).forEach((k) => {
      if (k.indexOf('.') === -1 && k.indexOf('[') === -1) { registered.data[k] = patch[k]; return }
      // orders[3].countdown 这种路径式写法，测试里用不到，忽略即可
    })
  }
  registered.selectComponent = () => null
  // 倒计时 ticker 是个真 setInterval，会把 node 的测试进程吊住不退出。
  // 它不是本文件要验的东西（倒计时逻辑与渠道无关），直接换成空实现。
  if (typeof registered.startTicker === 'function') registered.startTicker = () => {}
  return registered
}

function makeCtx(channel, orders) {
  const urls = []
  const nav = []
  const app = {
    globalData: { shoppingChannel: channel || 'EXPRESS' },
    getShoppingChannel: () => app.globalData.shoppingChannel,
    setShoppingChannel: (v) => { app.globalData.shoppingChannel = v; return v },
    updateCartCount() {}, applyCartBadge() {},
  }
  const wx = {
    getStorageSync: () => '',
    setStorageSync: () => {},
    request: (r) => {
      const u = r.url.replace(/^https?:\/\/[^/]+(\/api)?/, '')
      urls.push(u)
      const list = orders || []
      r.success({ statusCode: 200, data: { code: 0, message: 'ok', data: { list, total: list.length } } })
    },
    navigateTo: (a) => { nav.push('navigateTo:' + a.url) },
    switchTab: (a) => { nav.push('switchTab:' + a.url) },
    stopPullDownRefresh() {}, showToast() {}, setNavigationBarTitle() {},
  }
  return { app, wx, urls, nav }
}

const settle = () => new Promise((r) => setTimeout(r, 0))
const lastOrdersUrl = (urls) => urls.filter((u) => u.indexOf('/orders') === 0).pop() || ''

test('从「我的」进订单列表：带上当前渠道，两个渠道各自带对', function () {
  for (const ch of ['LOCAL', 'EXPRESS']) {
    const ctx = makeCtx(ch)
    const page = loadPage('../../apps/miniapp/pages/user/index.js', ctx)
    page.goToOrders.call(page)
    assert.ok(ctx.nav.some((n) => n.indexOf('deliveryType=' + ch) !== -1),
      ch + ' 应带上渠道：' + ctx.nav.join(' '))
  }
})

test('从「我的」的状态快捷入口进列表：渠道与状态一起带', function () {
  const ctx = makeCtx('LOCAL')
  const page = loadPage('../../apps/miniapp/pages/user/index.js', ctx)
  page.goToOrdersByStatus.call(page, { currentTarget: { dataset: { status: 'PAID,PREPARING' } } })
  const url = ctx.nav[0] || ''
  assert.ok(url.indexOf('status=PAID%2CPREPARING') !== -1 || url.indexOf('status=PAID,PREPARING') !== -1,
    '状态要带上：' + url)
  assert.ok(url.indexOf('deliveryType=LOCAL') !== -1, '渠道也要带上：' + url)
})

test('订单列表默认只看当前渠道；请求里必须出现 channel', async function () {
  const ctx = makeCtx('LOCAL')
  const page = loadPage('../../apps/miniapp/pages/order/list.js', ctx)
  page.onLoad.call(page, { deliveryType: 'LOCAL' })
  page.onShow.call(page)
  await settle(); await settle()
  assert.ok(lastOrdersUrl(ctx.urls).indexOf('channel=LOCAL') !== -1,
    '默认应只查同城：' + ctx.urls.join(' '))
  page.onUnload.call(page)
})

test('切到「全部订单」：不再带 deliveryType，两个渠道都回来', async function () {
  const ctx = makeCtx('LOCAL')
  const page = loadPage('../../apps/miniapp/pages/order/list.js', ctx)
  page.onLoad.call(page, { deliveryType: 'LOCAL' })
  page.onShow.call(page)
  await settle(); await settle()
  ctx.urls.length = 0
  page.onScopeChange.call(page, { currentTarget: { dataset: { scope: 'all' } } })
  await settle(); await settle()
  assert.ok(lastOrdersUrl(ctx.urls).indexOf('channel=') === -1,
    '「全部」不该带渠道：' + ctx.urls.join(' '))
  page.onUnload.call(page)
})

// 状态与分页在切渠道范围时必须留住/归零得当：
// 状态是顾客当前想看的那一类，换范围不该把它丢掉；分页必须回到第 1 页，
// 否则新范围的第一屏会从第 N 页开始，看起来像是「什么都没有」。
test('切换范围：保留状态筛选、页码回到 1、清掉旧列表', async function () {
  const ctx = makeCtx('LOCAL', [{ id: 1, deliveryType: 'LOCAL', status: 'COMPLETED', items: [], actualAmount: 100 }])
  const page = loadPage('../../apps/miniapp/pages/order/list.js', ctx)
  page.onLoad.call(page, { status: 'COMPLETED', deliveryType: 'LOCAL' })
  page.onShow.call(page)
  await settle(); await settle()
  const tabBefore = page.data.activeTab
  page.setData({ page: 3 })
  ctx.urls.length = 0
  page.onScopeChange.call(page, { currentTarget: { dataset: { scope: 'all' } } })
  await settle(); await settle()
  assert.equal(page.data.activeTab, tabBefore, '换范围不该把状态筛选丢掉')
  assert.ok(lastOrdersUrl(ctx.urls).indexOf('page=1') !== -1, '必须回到第 1 页：' + ctx.urls.join(' '))
  assert.ok(lastOrdersUrl(ctx.urls).indexOf('status=COMPLETED') !== -1, '状态要跟着一起查')
  page.onUnload.call(page)
})

// 晚到的响应会把新筛选的结果盖掉——顾客刚切到「全部」，屏幕上却又变回只有同城单。
test('切范围时的在途响应作废，不覆盖新筛选的结果', async function () {
  const ctx = makeCtx('LOCAL')
  let pending = null
  ctx.wx.request = (r) => {
    ctx.urls.push(r.url.replace(/^https?:\/\/[^/]+(\/api)?/, ''))
    pending = () => r.success({ statusCode: 200, data: { code: 0, data: { list: [{ id: 9, deliveryType: 'LOCAL', items: [], actualAmount: 1 }], total: 1 } } })
  }
  const page = loadPage('../../apps/miniapp/pages/order/list.js', ctx)
  page.onLoad.call(page, { deliveryType: 'LOCAL' })
  page.onShow.call(page)
  const stale = pending
  page.onScopeChange.call(page, { currentTarget: { dataset: { scope: 'all' } } })
  stale()                       // 旧请求现在才回来
  await settle()
  assert.deepEqual(page.data.orders, [], '旧响应必须被丢弃')
  page.onUnload.call(page)
})

test('订单列表页不再有任何「我的订单 ›」残留入口（改版后统一从底部「我的」进）', function () {
  const fs = require('node:fs')
  const dir = path.join(__dirname, '../../apps/miniapp')
  const hits = []
  const walk = (d) => {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, f.name)
      if (f.isDirectory()) { if (f.name !== 'node_modules') walk(p); continue }
      if (!/\.(js|wxml)$/.test(f.name)) continue
      // 先剥注释：组件里那句「原来的『我的订单 ›』已删除」正是在记录这次改动，
      // 连注释一起扫会逼人删掉有用的说明来讨好测试。
      const src = fs.readFileSync(p, 'utf8')
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '')
      if (/head-orders-link|我的订单 ›|cover-orders/.test(src)) hits.push(p)
    }
  }
  walk(dir)
  assert.deepEqual(hits, [], '仍有残留：' + hits.join(', '))
})

// ── 同城订单详情的三条回归护栏 ─────────────────────────────────────
//
// ⚠️ 这三条是**源码级**断言，只证明「那行代码还在」，不证明运行时真的对。
// 详情页 700 行、依赖十来个接口，为这三条搭一整套运行时桩不划算；
// 真正的行为验收在开发者工具（Task 10 的操作矩阵）。
// 放在这里的理由是它们各自都曾经或可能出真事故，且都极易在重构中被顺手删掉。
const readSrc = (rel) => require('node:fs')
  .readFileSync(path.join(__dirname, '../../apps/miniapp', rel), 'utf8')
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')

test('同城单不显示「确认收货」', function () {
  // 同城单由骑手回调 520 或店员标记送达置为完成。留着这个按钮，顾客在骑手刚取货时
  // 误点一下，订单就提前变成「已完成」——之后配送出问题，退款与售后的判定全乱。
  const src = readSrc('pages/order/detail.wxml')
  const btn = /<view[^>]*bindtap="onConfirmReceipt"/.exec(src)
  assert.ok(btn, '找不到确认收货按钮')
  const line = src.slice(Math.max(0, btn.index - 400), btn.index + 200)
  assert.ok(/!order\.isLocal/.test(line), '确认收货按钮必须排除同城单：' + line.slice(-200))
})

test('骑手轮询在页面隐藏与卸载时都停', function () {
  // 只在 onUnload 停的话，顾客切到别的小程序、或者进了另一个页面，
  // 这个 30 秒一次的轮询会一直打下去——耗电，也白占服务端的 courier 缓存。
  const src = readSrc('pages/order/detail.js')
  for (const hook of ['onHide', 'onUnload']) {
    const at = src.indexOf(hook + '() {')
    assert.ok(at !== -1, '找不到 ' + hook)
    const body = src.slice(at, at + 300)
    assert.ok(body.indexOf('stopCourierPoll') !== -1, hook + ' 必须停掉骑手轮询')
  }
  assert.ok(/COURIER_LIVE_STATUSES\.indexOf\([^)]*\) === -1[\s\S]{0,60}stopCourierPoll/.test(src),
    '订单进终态后也要停止轮询，不能一直打到顾客离开页面')
})

test('取消申请有防双击，且在弹窗确认后再判一次', function () {
  // 只在弹窗前判一次是不够的：弹窗是异步的，顾客可以在第一个弹窗还开着时
  // 触发第二个（快速双击会排队两个 showModal），两次 confirm 会发两个请求。
  const src = readSrc('pages/order/detail.js')
  const m = /onRequestCancel\(\)\s*\{[\s\S]*?\n  \},/.exec(src)
  assert.ok(m, '找不到 onRequestCancel')
  const guards = (m[0].match(/_requestCanceling/g) || []).length
  assert.ok(guards >= 3, '弹窗前、确认后各要判一次并置位，实际出现 ' + guards + ' 次')
})

test('自取单卡片：标签「自取」、待取餐/已取餐文案（按真实渲染出的组件标签断言）', async function () {
  const ctx = makeCtx('LOCAL', [
    { id: 11, deliveryType: 'PICKUP', status: 'SHIPPED', items: [], actualAmount: 1200 },
    { id: 12, deliveryType: 'PICKUP', status: 'COMPLETED', items: [], actualAmount: 1200 },
    { id: 13, deliveryType: 'LOCAL', status: 'SHIPPED', items: [], actualAmount: 1200 },
  ])
  const page = loadPage('../../apps/miniapp/pages/order/list.js', ctx)
  page.onLoad.call(page, { deliveryType: 'LOCAL' })
  page.onShow.call(page)
  await settle(); await settle()
  const byId = (id) => page.data.orders.find((o) => o.id === id)
  assert.equal(byId(11).typeLabel, '自取'); assert.equal(byId(11).typeClass, 'pickup')
  // T2b（M2）：列表页实际渲染的是 <order-status-tag> 组件算出的标签，不是 decorate()
  // 算出但已经无人读取的 item.statusLabel——用同一份组件逻辑复算，断言真实会显示的文案。
  assert.equal(tagLabelOf(byId(11).status, byId(11).deliveryType, !!byId(11).scheduledAt), '待取餐')
  assert.equal(tagLabelOf(byId(12).status, byId(12).deliveryType, !!byId(12).scheduledAt), '已取餐')
  assert.equal(tagLabelOf(byId(13).status, byId(13).deliveryType, !!byId(13).scheduledAt), '配送中', '同城配送中不应显示「已发货」')
  page.onUnload.call(page)
})

// T3b（M3，复审阻塞）：同城预约单进入 SHIPPED（配送中）后，取消卡的五个析取项
// 必须全假——不能因为服务端仍下发 schedule.readyAt 就显示「餐品已在准备」。
// 附带 D3（店主决定）：详情页顶部同城 SHIPPED 也改「配送中」，与列表页 M2 一致。
test('T3b M3：预约单进入 SHIPPED 后取消卡五项全假，横幅仍在；D3 顶部状态改「配送中」', async function () {
  const order = {
    id: 31, orderNo: 'ORD31', deliveryType: 'LOCAL', status: 'SHIPPED',
    scheduledAt: '2026-09-23T04:00:00Z',
    createdAt: '2026-09-23T01:00:00Z', paidAt: '2026-09-23T01:01:00Z', acceptedAt: '2026-09-23T01:05:00Z',
    receiverName: '张三', receiverPhone: '13800001234', receiverFullAddress: '自流井区丹桂路1号',
    totalAmount: 1200, shippingFee: 500, actualAmount: 1700, refundedAmount: 0, discountAmount: 0, pointsUsed: 0,
    items: [{ id: 1, productName: '凉拌牛肉', productPrice: 1200, quantity: 1, subtotal: 1200 }], refunds: [], afterSale: null,
    canSelfCancel: false, canRequestCancel: false, cancelRequestedAt: null, cancelRequestRejectedAt: null,
    subscribeTemplateIds: [],
    schedule: { slotLabel: '明天 12:00–12:30', selfCancelUntil: '2026-09-23T02:00:00Z', readyAt: '2026-09-23T01:30:00Z', acceptDueAt: '2026-09-23T01:10:00Z', prepStartAt: '2026-09-23T01:06:00Z' },
    readyAt: '2026-09-23T01:30:00Z',
  }
  const ctx = makeCtx('LOCAL', [])
  ctx.wx.request = (r) => {
    ctx.urls.push(r.url)
    r.success({ statusCode: 200, data: { code: 0, message: 'ok', data: order } })
  }
  Object.assign(ctx.wx, { showLoading() {}, hideLoading() {}, openLocation() {}, makePhoneCall() {} })
  const page = loadPage('../../apps/miniapp/pages/order/detail.js', ctx)
  page.startCourierPoll = () => {}
  page.onLoad.call(page, { id: '31' })
  await settle(); await settle()
  const o = page.data.order
  assert.equal(o.scheduleCancelCopy, '')
  assert.equal(o.showLocalCancelUnavailable, false)
  assert.equal(o.showLocalCancelRejected, false)
  assert.equal(o.canRequestCancel, false)
  assert.ok(!o.cancelRequestedAt)
  assert.ok(o.scheduleBanner, '横幅不受影响')
  // D3：顶部状态标签同 M2 一致改「配送中」
  assert.equal(o.statusLabel, '配送中')
  page.onUnload.call(page)
})

// 源码级：锁住 detail.wxml:107 取消卡的 wx:if 仍恰由这五个析取项组成，不多不少——
// 证明上面 T3b 的「五项全假」真的对应到会渲染的那一行判断，而不是巧合。
test('T3b 源码级：取消卡 wx:if 恰由五个析取项组成', function () {
  const wxml = readSrc('pages/order/detail.wxml')
  const line = /<view class="card local-cancel-card" wx:if="\{\{[\s\S]*?\}\}">/.exec(wxml)
  assert.ok(line, '找不到取消卡这一行')
  const names = ['canRequestCancel', 'cancelRequestedAt', 'showLocalCancelRejected', 'showLocalCancelUnavailable', 'scheduleCancelCopy']
  names.forEach((n) => {
    const count = (line[0].match(new RegExp('order\\.' + n + '(?![A-Za-z])', 'g')) || []).length
    assert.equal(count, 1, n + ' 应恰出现一次：' + line[0])
  })
  const otherOrderRefs = (line[0].match(/order\.[A-Za-z]+/g) || []).filter((s) => names.indexOf(s.slice(6)) === -1 && s !== 'order.isLocal' && s !== 'order.isExpress' && s !== 'order.isPickup')
  assert.deepEqual(otherOrderRefs, [], '不应有其它 order.* 项：' + otherOrderRefs.join(','))
})

// T11b（M11，源码级）：详情页把 schedulePaidExtra/scheduleCancelCopy 的第二实参
// 从 fmtHHmm 换成 fmtDayHHmm——预约可以约到三天后，只给钟点不给日期分不清是哪天。
test('T11b M11：detail.js 传给 schedulePaidExtra/scheduleCancelCopy 的格式化函数是 fmtDayHHmm', function () {
  const src = readSrc('pages/order/detail.js')
  const calls = src.match(/schedule(PaidExtra|CancelCopy)\(order, \w+\)/g) || []
  assert.ok(calls.length >= 3, '至少应有三处调用（两处 schedulePaidExtra + 一处 scheduleCancelCopy）：' + calls.join(', '))
  calls.forEach((c) => {
    assert.match(c, /fmtDayHHmm/, c + ' 应传 fmtDayHHmm')
    assert.doesNotMatch(c, /,\s*fmtHHmm\)/, c + ' 不该再传 fmtHHmm')
  })
})

test('自取单详情：门店卡、尾号+时段、时间线、按钮按服务端 canSelfCancel', async function () {
  const order = {
    id: 21, orderNo: 'ORD21', deliveryType: 'PICKUP', status: 'SHIPPED',
    createdAt: '2026-09-11T02:00:00Z', paidAt: '2026-09-11T02:01:00Z', acceptedAt: '2026-09-11T02:05:00Z',
    pickupAt: '2026-09-11T04:00:00Z', pickupReadyAt: '2026-09-11T03:40:00Z', pickupDiscountAmount: 60,
    receiverName: '张三', receiverPhone: '13800001234', receiverFullAddress: '四川省自贡市自流井区丹桂40栋底楼',
    totalAmount: 1200, shippingFee: 0, actualAmount: 1140, refundedAmount: 0, discountAmount: 0, pointsUsed: 0,
    items: [{ id: 1, productName: '凉拌牛肉', productPrice: 1200, quantity: 1, subtotal: 1200 }], refunds: [], afterSale: null,
    canSelfCancel: false, canRequestCancel: false, subscribeTemplateIds: [],
    pickup: { pickupAt: '2026-09-11T04:00:00Z', pickupReadyAt: '2026-09-11T03:40:00Z', prepStartAt: '2026-09-11T03:35:00Z', slotLabel: '今天 12:00–12:30', store: { name: '阿福凉菜', phone: '15309003232', address: '自流井区丹桂40栋底楼', latE6: 29341126, lngE6: 104779018 } },
  }
  const ctx = makeCtx('LOCAL', [])
  ctx.wx.request = (r) => {
    ctx.urls.push(r.url)
    r.success({ statusCode: 200, data: { code: 0, message: 'ok', data: order } })
  }
  Object.assign(ctx.wx, { showLoading() {}, hideLoading() {}, openLocation() {}, makePhoneCall() {} })
  const page = loadPage('../../apps/miniapp/pages/order/detail.js', ctx)
  page.startCourierPoll = () => {}
  page.onLoad.call(page, { id: '21' })
  await settle(); await settle()
  const o = page.data.order
  assert.equal(o.isPickup, true)
  assert.equal(o.statusLabel, '待取餐')
  assert.equal(o.phoneTail, '1234')
  assert.equal(o.pickupSlotLabel, '今天 12:00–12:30')
  assert.equal(o.pickupStore.name, '阿福凉菜')
  assert.equal(o.canSelfCancel, false, '以服务端 canSelfCancel 为准')
  assert.equal(o.pickupDiscountAmountText, '0.60')
  assert.ok(o.timeline.some((s) => s.label === '已备好 · 请来取餐' && s.done), JSON.stringify(o.timeline))
  assert.ok(o.timeline.some((s) => s.label === '已取餐' && !s.done))
  page.onUnload.call(page)
})
