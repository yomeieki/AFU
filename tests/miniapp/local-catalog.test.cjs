// 同城菜单的三段判断：店头状态 / 购物车合计 / 能不能去结算。
//
// 抽成纯函数是因为它们要同时出现在主页和分类页——两个页面各写一遍，迟早会有一边
// 忘了「暂停接单时也要挡结算」，而那一边看起来完全正常，只有下单那一刻才炸。
const test = require('node:test')
const assert = require('node:assert/strict')

const { headNoticeOf, storeStatusOf, summarizeCart, checkoutStateOf } =
  require('../../apps/miniapp/utils/local-catalog')

const OPEN = { enabled: true, isOpen: true, paused: null, fee: { minOrderAmount: 4000 } }

test('店头状态：三种业务态各自的措辞与色调', function () {
  assert.deepEqual(storeStatusOf(OPEN), { tone: 'open', label: '营业中' })
  assert.deepEqual(storeStatusOf(Object.assign({}, OPEN, { paused: { reason: '' } })),
    { tone: 'paused', label: '暂停接单' })
  assert.deepEqual(storeStatusOf(Object.assign({}, OPEN, { isOpen: false })),
    { tone: 'closed', label: '已打烊' })
  // 暂停优先于打烊：店主主动按下的暂停，比「不在营业时段」更需要被看到
  assert.deepEqual(storeStatusOf(Object.assign({}, OPEN, { isOpen: false, paused: { reason: 'x' } })),
    { tone: 'paused', label: '暂停接单' })
})

test('店头状态：meta 还没回来时按「已打烊」画，不留一个空胶囊', function () {
  assert.deepEqual(storeStatusOf(null), { tone: 'closed', label: '暂未营业' })
})

test('页头通知：只有真的挡住下单时才出现，并带上店主写的理由', function () {
  assert.deepEqual(headNoticeOf(OPEN), { text: '', blocking: false })
  assert.deepEqual(headNoticeOf({ enabled: false }), { text: '同城配送即将开通', blocking: true })
  assert.deepEqual(headNoticeOf(Object.assign({}, OPEN, { paused: { reason: '今日售罄' } })),
    { text: '暂停接单：今日售罄', blocking: true })
  assert.deepEqual(headNoticeOf(Object.assign({}, OPEN, { paused: { reason: '' } })),
    { text: '暂停接单', blocking: true })
  assert.deepEqual(headNoticeOf(Object.assign({}, OPEN, { isOpen: false, nextOpenText: '明天 09:00 开始接单' })),
    { text: '明天 09:00 开始接单', blocking: true })
})

test('购物车合计：件数与金额分别累加，缺字段按 0 算不抛', function () {
  assert.deepEqual(summarizeCart([{ quantity: 2, subtotal: 5000 }, { quantity: 1, subtotal: 1500 }]),
    { count: 3, amount: 6500 })
  assert.deepEqual(summarizeCart([{}, { quantity: 1 }]), { count: 1, amount: 0 })
  assert.deepEqual(summarizeCart(null), { count: 0, amount: 0 })
})

test('结算态：差多少起送要说出具体数字，不是一句「未达起送」', function () {
  // 顾客看到「还差 ¥15.00 起送」会去加菜；看到「未达起送」只会退出去。
  assert.deepEqual(checkoutStateOf(OPEN, 1, 2500, false),
    { gap: 1500, disabled: true, text: '还差 ¥15.00 起送' })
  assert.deepEqual(checkoutStateOf(OPEN, 2, 4000, false),
    { gap: 0, disabled: false, text: '去结算' })
})

test('结算态：业务阻塞优先于起送线——暂停接单时加满也不能结', function () {
  assert.deepEqual(checkoutStateOf(OPEN, 3, 9900, true),
    { gap: 0, disabled: true, text: '暂不可结算' })
})

test('结算态：空车、meta 未到都不放行', function () {
  assert.equal(checkoutStateOf(OPEN, 0, 0, false).disabled, true)
  assert.equal(checkoutStateOf(null, 2, 9900, false).disabled, true)
})
