// 自取结算页底部按钮的行为锁（与 local-checkout-state.test.cjs 同一思路）。
// 自取没有地址与报价，但有三个自己的坑：时段过期了还能提交、手机号没填还能提交、
// 券封顶算错让页面上的应付金额比服务端算的小。
const test = require('node:test')
const assert = require('node:assert/strict')

const st = require('../../apps/miniapp/utils/pickup-checkout-state')

const READY = { hasSlot: true, slotStale: false, phoneValid: true, belowMinGap: 0, payAmount: 4750, hasTableware: true }
const on = function (over) { return Object.assign({}, READY, over) }

test('阻塞（休业/暂停/未开通）压过一切，按钮一句短文案', function () {
  assert.deepEqual(st.pickupCheckoutAction(on({ blockReason: '休息中，10月08日恢复' })),
    { disabled: true, text: '暂不可自取', amountState: 'blocked', action: 'none' })
})
test('时段失效 → 可点但动作是重选，不是提交', function () {
  assert.deepEqual(st.pickupCheckoutAction(on({ slotStale: true })),
    { disabled: false, text: '重新选择时间', amountState: 'pending', action: 'reslot' })
})
// 2026-09-17 起进页不再自动预选第一个时段：与「未选餐具」同一套处理，
// 按钮可点、文案是 NO_SLOT、动作是 slot（打开时段选择器），不是禁用、不是提交。
// 金额照常显示（顾客要先看到要付多少）——这是返工修的回归：改动前时段自动预填，
// 顾客一进页就看得见合计；改成必须自己选之后，这一格若给 'pending' 会让底栏金额
// 在选时间前全变「待计算」，是缺陷不是设计。
test('没选时段（selected 为 null）→ 不禁用，文案「请选择取餐时间」，动作是打开时段选择器，金额照常显示', function () {
  assert.deepEqual(st.pickupCheckoutAction(on({ hasSlot: false })),
    { disabled: false, text: '请选择取餐时间', amountState: 'ready', action: 'slot' })
})
test('没选时段且金额还没算出来（车没回来）→ 金额待计算', function () {
  assert.deepEqual(st.pickupCheckoutAction(on({ hasSlot: false, payAmount: null })),
    { disabled: false, text: '请选择取餐时间', amountState: 'pending', action: 'slot' })
})
test('时段加载中 → 禁用，文案「正在获取时段…」，金额照常显示', function () {
  assert.deepEqual(st.pickupCheckoutAction(on({ hasSlot: false, slotsLoading: true })),
    { disabled: true, text: '正在获取时段…', amountState: 'ready', action: 'none' })
})
test('时段获取失败 → 禁用，文案「取餐时段获取失败」', function () {
  assert.deepEqual(st.pickupCheckoutAction(on({ hasSlot: false, slotsError: true })),
    { disabled: true, text: '取餐时段获取失败', amountState: 'ready', action: 'none' })
})
// 返工回归护栏：onShow 并发重拉 meta 与 slots 时，slotsLoading/slotsError 会先于新列表
// 落地——已经选好时段的顾客这一刻绝不能被这两格截胡退回禁用态。
test('已选时段时，时段加载中/获取失败都不截胡：仍走后面几格判定（提交订单）', function () {
  assert.deepEqual(st.pickupCheckoutAction(on({ slotsLoading: true })), st.pickupCheckoutAction(READY))
  assert.deepEqual(st.pickupCheckoutAction(on({ slotsError: true })), st.pickupCheckoutAction(READY))
})
test('时段拉到了但一格都没有 → 禁用，文案「暂无可取时段」', function () {
  assert.deepEqual(st.pickupCheckoutAction(on({ hasSlot: false, noSlots: true })),
    { disabled: true, text: '暂无可取时段', amountState: 'ready', action: 'none' })
})
// 回归护栏：noSlots 这格故意不加 !hasSlot——已选时段的顾客一返回本页，刷新回来
// 一格都没有时，已选的那格必然也失效了，此时仍要禁用提交、文案「暂无可取时段」，
// 不能因为 hasSlot 仍是 true 就被上面「已选时段」那格截胡。
test('已选时段但刷新后一格都没有 → 仍禁用，文案「暂无可取时段」', function () {
  assert.deepEqual(st.pickupCheckoutAction(on({ noSlots: true })),
    { disabled: true, text: '暂无可取时段', amountState: 'ready', action: 'none' })
})
test('手机号无效 → 禁用，但金额照常显示（顾客要先看到要付多少）', function () {
  assert.deepEqual(st.pickupCheckoutAction(on({ phoneValid: false })),
    { disabled: true, text: '请填写手机号', amountState: 'ready', action: 'none' })
})
test('未达起送：说出具体差额', function () {
  assert.deepEqual(st.pickupCheckoutAction(on({ belowMinGap: 500 })),
    { disabled: true, text: '还差 ¥5.00 起', amountState: 'ready', action: 'none' })
})
// 餐具必选（餐具设计 T2）：放在金额未知之后——amountState='ready' 时金额一定算得出来。
test('没选餐具：按钮可点，动作是打开弹层', function () {
  assert.deepEqual(st.pickupCheckoutAction(on({ hasTableware: false })),
    { disabled: false, text: '请选择餐具', amountState: 'ready', action: 'tableware' })
})
test('优先级：起送与金额未知都排在餐具之前', function () {
  assert.equal(st.pickupCheckoutAction(on({ hasTableware: false, belowMinGap: 500 })).text, '还差 ¥5.00 起')
  assert.equal(st.pickupCheckoutAction(on({ hasTableware: false, payAmount: null })).text, '提交订单')
  assert.equal(st.pickupCheckoutAction(on({ hasTableware: false, benefitsLoading: true })).text, '请选择餐具')
})
test('优惠重算中锁提交但金额不闪；提交中锁死', function () {
  assert.deepEqual(st.pickupCheckoutAction(on({ benefitsLoading: true })),
    { disabled: true, text: '提交订单', amountState: 'ready', action: 'submit' })
  assert.deepEqual(st.pickupCheckoutAction(on({ submitting: true })),
    { disabled: true, text: '提交中', amountState: 'ready', action: 'submit' })
  assert.deepEqual(st.pickupCheckoutAction(READY),
    { disabled: false, text: '提交订单', amountState: 'ready', action: 'submit' })
})
test('应付金额算不出来（车还没回来）按待计算处理', function () {
  assert.deepEqual(st.pickupCheckoutAction(on({ payAmount: null })),
    { disabled: true, text: '提交订单', amountState: 'pending', action: 'none' })
})
test('手机号：11 位 1 开头才算', function () {
  assert.equal(st.isValidPhone('13800001234'), true)
  assert.equal(st.isValidPhone(' 13800001234 '), true)
  assert.equal(st.isValidPhone('1380000123'), false)
  assert.equal(st.isValidPhone('23800001234'), false)
  assert.equal(st.isValidPhone(''), false)
})
test('自取优惠与服务端同一公式：PERCENT 四舍五入、FIXED 封顶、NONE 为 0；券封顶到小计−自取优惠', function () {
  assert.equal(st.pickupDiscountOf({ type: 'PERCENT', value: 95 }, 5000), 250)
  assert.equal(st.pickupDiscountOf({ type: 'PERCENT', value: 95 }, 3333), 167)
  assert.equal(st.pickupDiscountOf({ type: 'FIXED', value: 300 }, 200), 200)
  assert.equal(st.pickupDiscountOf(null, 5000), 0)
  assert.deepEqual(st.computePickupPay(5000, { type: 'PERCENT', value: 95 }, 500),
    { pickupDiscount: 250, couponDiscount: 500, packingFee: 0, payAmount: 4250 })
  // 券面额超过「小计−自取优惠」时封顶，实付不会算成负数
  assert.deepEqual(st.computePickupPay(1000, { type: 'FIXED', value: 300 }, 1000),
    { pickupDiscount: 300, couponDiscount: 700, packingFee: 0, payAmount: 0 })
})

test('打包费：Σ quantity × 单份打包费；每份 packingFeeEach=0 → 该行不计费', function () {
  var items = [
    { quantity: 2, packingFeeEach: 100 },
    { quantity: 1, packingFeeEach: 250 },
  ]
  // 3 份共 450：2×100 + 1×250
  assert.equal(st.packingFeeOf(items), 450)
  assert.equal(st.packingFeeOf([]), 0)
  // 每份 packingFeeEach=0（相当于旧版「总开关关」的效果，服务端此时恒下发 0）→ 0
  assert.equal(st.packingFeeOf([{ quantity: 2, packingFeeEach: 0 }, { quantity: 1, packingFeeEach: 0 }]), 0)
  // 兼容 { product: { packingFeeEach } } 这种嵌套形状
  assert.equal(st.packingFeeOf([{ quantity: 2, product: { packingFeeEach: 100 } }]), 200)
  // 打包费加在券封顶之后，不参与「小计−自取优惠」那个封顶判定
  assert.deepEqual(st.computePickupPay(5000, { type: 'PERCENT', value: 95 }, 500, 300),
    { pickupDiscount: 250, couponDiscount: 500, packingFee: 300, payAmount: 4550 })
})

test('firstSlot：找第一个可选格（页面只用它决定弹层默认落到哪一天）；今天为空时落到明天；已选格不在最新列表里即视为失效', function () {
  const view = { days: [
    { date: '2026-09-11', label: '今天', slots: [] },
    { date: '2026-09-12', label: '明天', slots: [{ startAt: 'A', endAt: 'B', label: '10:00–10:30' }] },
  ] }
  assert.deepEqual(st.firstSlot(view), { dayIndex: 1, slot: { startAt: 'A', endAt: 'B', label: '10:00–10:30' } })
  assert.equal(st.slotOffered(view, 'A'), true)
  assert.equal(st.slotOffered(view, 'Z'), false)
  assert.equal(st.firstSlot({ days: [] }), null)
  assert.equal(st.firstSlot(null), null)
})
test('优先级：阻塞 > 时段加载中 > 时段获取失败 > 无可取时段 > 未选时段 > 时段失效 > 手机号 > 起送 > 金额未知 > 餐具 > 优惠重算 > 提交中', function () {
  const all = { blockReason: 'x', slotsLoading: true, slotsError: true, noSlots: true, hasSlot: false, slotStale: true, phoneValid: false, belowMinGap: 500, hasTableware: false, benefitsLoading: true, submitting: true, payAmount: 100 }
  assert.equal(st.pickupCheckoutAction(all).text, '暂不可自取')
  assert.equal(st.pickupCheckoutAction(Object.assign({}, all, { blockReason: '' })).text, '正在获取时段…')
  assert.equal(st.pickupCheckoutAction(Object.assign({}, all, { blockReason: '', slotsLoading: false })).text, '取餐时段获取失败')
  assert.equal(st.pickupCheckoutAction(Object.assign({}, all, { blockReason: '', slotsLoading: false, slotsError: false })).text, '暂无可取时段')
  assert.equal(st.pickupCheckoutAction(Object.assign({}, all, { blockReason: '', slotsLoading: false, slotsError: false, noSlots: false })).action, 'slot')
  assert.equal(st.pickupCheckoutAction(Object.assign({}, all, { blockReason: '', slotsLoading: false, slotsError: false, noSlots: false, hasSlot: true })).action, 'reslot')
  assert.equal(st.pickupCheckoutAction(Object.assign({}, all, { blockReason: '', slotsLoading: false, slotsError: false, noSlots: false, hasSlot: true, slotStale: false })).text, '请填写手机号')
  assert.equal(st.pickupCheckoutAction(Object.assign({}, all, { blockReason: '', slotsLoading: false, slotsError: false, noSlots: false, hasSlot: true, slotStale: false, phoneValid: true })).text, '还差 ¥5.00 起')
  assert.equal(st.pickupCheckoutAction(Object.assign({}, all, { blockReason: '', slotsLoading: false, slotsError: false, noSlots: false, hasSlot: true, slotStale: false, phoneValid: true, belowMinGap: 0 })).text, '请选择餐具')
  assert.equal(st.pickupCheckoutAction(Object.assign({}, all, { blockReason: '', slotsLoading: false, slotsError: false, noSlots: false, hasSlot: true, slotStale: false, phoneValid: true, belowMinGap: 0, hasTableware: true })).text, '提交订单')
  assert.equal(st.pickupCheckoutAction(Object.assign({}, all, { blockReason: '', slotsLoading: false, slotsError: false, noSlots: false, hasSlot: true, slotStale: false, phoneValid: true, belowMinGap: 0, hasTableware: true, benefitsLoading: false })).text, '提交中')
})

test('pickupDateText：月日 + 星期按日历日算，非法输入给空', function () {
  assert.deepEqual(st.pickupDateText('2026-09-12'), { monthDay: '9月12日', weekday: '周六' })
  assert.deepEqual(st.pickupDateText('2026-10-01'), { monthDay: '10月1日', weekday: '周四' })
  assert.deepEqual(st.pickupDateText(''), { monthDay: '', weekday: '' })
})
