// 自取结算页底部按钮的行为锁（与 local-checkout-state.test.cjs 同一思路）。
// 自取没有地址与报价，但有三个自己的坑：时段过期了还能提交、手机号没填还能提交、
// 券封顶算错让页面上的应付金额比服务端算的小。
const test = require('node:test')
const assert = require('node:assert/strict')

const st = require('../../apps/miniapp/utils/pickup-checkout-state')

const READY = { hasSlot: true, slotStale: false, phoneValid: true, belowMinGap: 0, payAmount: 4750 }
const on = function (over) { return Object.assign({}, READY, over) }

test('阻塞（休业/暂停/未开通）压过一切，按钮一句短文案', function () {
  assert.deepEqual(st.pickupCheckoutAction(on({ blockReason: '休息中，10月08日恢复' })),
    { disabled: true, text: '暂不可自取', amountState: 'blocked', action: 'none' })
})
test('没选时段 → 禁用；时段失效 → 可点但动作是重选，不是提交', function () {
  assert.deepEqual(st.pickupCheckoutAction(on({ hasSlot: false })),
    { disabled: true, text: '请选择取餐时间', amountState: 'pending', action: 'none' })
  assert.deepEqual(st.pickupCheckoutAction(on({ slotStale: true })),
    { disabled: false, text: '重新选择时间', amountState: 'pending', action: 'reslot' })
})
test('手机号无效 → 禁用，但金额照常显示（顾客要先看到要付多少）', function () {
  assert.deepEqual(st.pickupCheckoutAction(on({ phoneValid: false })),
    { disabled: true, text: '请填写手机号', amountState: 'ready', action: 'none' })
})
test('未达起送：说出具体差额', function () {
  assert.deepEqual(st.pickupCheckoutAction(on({ belowMinGap: 500 })),
    { disabled: true, text: '还差 ¥5.00 起', amountState: 'ready', action: 'none' })
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
    { pickupDiscount: 250, couponDiscount: 500, payAmount: 4250 })
  // 券面额超过「小计−自取优惠」时封顶，实付不会算成负数
  assert.deepEqual(st.computePickupPay(1000, { type: 'FIXED', value: 300 }, 1000),
    { pickupDiscount: 300, couponDiscount: 700, payAmount: 0 })
})
test('时段：默认选第一个可选格；今天为空时落到明天；已选格不在最新列表里即视为失效', function () {
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
test('优先级：阻塞 > 未选时段 > 时段失效 > 手机号 > 起送 > 优惠重算 > 提交中', function () {
  const all = { blockReason: 'x', hasSlot: false, slotStale: true, phoneValid: false, belowMinGap: 500, benefitsLoading: true, submitting: true, payAmount: 100 }
  assert.equal(st.pickupCheckoutAction(all).text, '暂不可自取')
  assert.equal(st.pickupCheckoutAction(Object.assign({}, all, { blockReason: '' })).text, '请选择取餐时间')
  assert.equal(st.pickupCheckoutAction(Object.assign({}, all, { blockReason: '', hasSlot: true })).action, 'reslot')
  assert.equal(st.pickupCheckoutAction(Object.assign({}, all, { blockReason: '', hasSlot: true, slotStale: false })).text, '请填写手机号')
  assert.equal(st.pickupCheckoutAction(Object.assign({}, all, { blockReason: '', hasSlot: true, slotStale: false, phoneValid: true })).text, '还差 ¥5.00 起')
  assert.equal(st.pickupCheckoutAction(Object.assign({}, all, { blockReason: '', hasSlot: true, slotStale: false, phoneValid: true, belowMinGap: 0 })).text, '提交订单')
  assert.equal(st.pickupCheckoutAction(Object.assign({}, all, { blockReason: '', hasSlot: true, slotStale: false, phoneValid: true, belowMinGap: 0, benefitsLoading: false })).text, '提交中')
})
