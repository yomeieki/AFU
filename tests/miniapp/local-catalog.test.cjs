// 同城菜单的三段判断：店头状态 / 购物车合计 / 能不能去结算。
//
// 抽成纯函数是因为它们要同时出现在主页和分类页——两个页面各写一遍，迟早会有一边
// 忘了「暂停接单时也要挡结算」，而那一边看起来完全正常，只有下单那一刻才炸。
const test = require('node:test')
const assert = require('node:assert/strict')

const { headNoticeOf, storeStatusOf, summarizeCart, checkoutStateOf, pickupModeHint } =
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

const { minOrderOf, pickupRulesText, resolveLocalMode, altModeOf, modeAvailable, holidayText, deliveryModeHint, deliveryScheduleOnly } =
  require('../../apps/miniapp/utils/local-catalog')
const PK = Object.assign({}, OPEN, {
  closedKind: 'OPEN',
  pickup: { enabled: true, paused: null, minOrderAmountFen: 1500, discountText: '自取享 9.5 折', slotMinutes: 30 },
  store: { name: '阿福凉菜', district: '自流井区', address: '丹桂40栋底楼', latE6: 1, lngE6: 2 },
})

test('不传 mode 时三段判断与改前逐字节一致', function () {
  assert.deepEqual(storeStatusOf(OPEN), { tone: 'open', label: '营业中' })
  assert.deepEqual(headNoticeOf({ enabled: false }), { text: '同城配送即将开通', blocking: true })
  assert.deepEqual(checkoutStateOf(OPEN, 1, 3000, false), { gap: 1000, disabled: true, text: '还差 ¥10.00 起送' })
})

test('自取模式的店头状态与通知：未开通 / 暂停 / 营业中 / 打烊或午休 · 可预约', function () {
  assert.deepEqual(storeStatusOf(PK, 'PICKUP'), { tone: 'open', label: '营业中' })
  assert.deepEqual(headNoticeOf(PK, 'PICKUP'), { text: '', blocking: false })
  // 营业时间外：胶囊「已打烊 · 可预约」/「午间休息 · 可预约」，提示带最早可取时段（新服务端）或不带（老服务端）
  assert.deepEqual(storeStatusOf(Object.assign({}, PK, { closedKind: 'CLOSED' }), 'PICKUP'),
    { tone: 'schedule', label: '已打烊 · 可预约' })
  assert.deepEqual(storeStatusOf(Object.assign({}, PK, { closedKind: 'BREAK' }), 'PICKUP'),
    { tone: 'schedule', label: '午间休息 · 可预约' })
  assert.deepEqual(headNoticeOf(Object.assign({}, PK, {
    closedKind: 'CLOSED',
    pickup: Object.assign({}, PK.pickup, { earliestPickupText: '最早明天 10:30–11:00 可取' }),
  }), 'PICKUP'), { text: '现在下单为预约自取，最早明天 10:30–11:00 可取', blocking: false })
  assert.deepEqual(headNoticeOf(Object.assign({}, PK, { closedKind: 'CLOSED' }), 'PICKUP'),
    { text: '现在下单为预约自取', blocking: false })
  const off = Object.assign({}, PK, { pickup: Object.assign({}, PK.pickup, { enabled: false }) })
  assert.deepEqual(storeStatusOf(off, 'PICKUP'), { tone: 'closed', label: '暂未开通' })
  assert.deepEqual(headNoticeOf(off, 'PICKUP'), { text: '到店自取暂未开通', blocking: true })
  // 暂停优先于打烊——即使 closedKind 非 OPEN，暂停胶囊/文案不能被打烊/午休盖过
  const paused = Object.assign({}, PK, { closedKind: 'CLOSED', pickup: Object.assign({}, PK.pickup, { paused: { reason: '后厨忙' } }) })
  assert.deepEqual(storeStatusOf(paused, 'PICKUP'), { tone: 'paused', label: '暂停接单' })
  assert.deepEqual(headNoticeOf(paused, 'PICKUP'), { text: '自取暂停接单：后厨忙', blocking: true })
})

// 修订 1（2026-09-23，复核 R2）：服务端给 pickup.earliestPickupWhen 后，营业段尾段（此刻仍在
// 营业时段内、但本段已约不到）与营业时间外都要区分对待；一格都约不到（NONE）是真的挡住下单。
test('自取 earliestPickupWhen：尾段/当前段/一格都约不到，三件套（胶囊·提示·切换栏小字）', function () {
  // 尾段（LATER 但此刻仍在营业时段内）：胶囊「营业中」（店主 2026-09-23 拍板），提示带最早可取，
  // 切换栏仍给「（可预约）」
  const later = Object.assign({}, PK, {
    closedKind: 'OPEN',
    pickup: Object.assign({}, PK.pickup, { earliestPickupWhen: 'LATER', earliestPickupText: '最早今天 17:00–17:30 可取' }),
  })
  assert.deepEqual(storeStatusOf(later, 'PICKUP'), { tone: 'open', label: '营业中' })
  assert.deepEqual(headNoticeOf(later, 'PICKUP'), { text: '现在下单为预约自取，最早今天 17:00–17:30 可取', blocking: false })
  assert.equal(pickupModeHint(later), '（可预约）')

  // 当前段（CURRENT）：与营业中无区别，无提示、无切换栏小字
  const current = Object.assign({}, PK, {
    closedKind: 'OPEN',
    pickup: Object.assign({}, PK.pickup, { earliestPickupWhen: 'CURRENT' }),
  })
  assert.deepEqual(storeStatusOf(current, 'PICKUP'), { tone: 'open', label: '营业中' })
  assert.deepEqual(headNoticeOf(current, 'PICKUP'), { text: '', blocking: false })
  assert.equal(pickupModeHint(current), '')

  // 一格都约不到（NONE）：灰「已打烊」（不分 BREAK/CLOSED）、阻塞提示「暂无可取时段」、
  // 切换栏不给「可预约」、modeAvailable 判不可用、altModeOf 走不到自取
  const noneClosed = Object.assign({}, PK, {
    closedKind: 'CLOSED',
    pickup: Object.assign({}, PK.pickup, { earliestPickupWhen: 'NONE', earliestPickupText: '' }),
  })
  assert.deepEqual(storeStatusOf(noneClosed, 'PICKUP'), { tone: 'closed', label: '已打烊' })
  assert.deepEqual(headNoticeOf(noneClosed, 'PICKUP'), { text: '暂无可取时段', blocking: true })
  assert.equal(pickupModeHint(noneClosed), '')
  assert.equal(modeAvailable(noneClosed, 'PICKUP'), false)
  assert.equal(altModeOf(Object.assign({}, noneClosed, { paused: { reason: '骑手不够' } }), 'DELIVERY'), null)
  // BREAK 叠 NONE：胶囊仍是「已打烊」，不写「午间休息」
  const noneBreak = Object.assign({}, PK, {
    closedKind: 'BREAK',
    pickup: Object.assign({}, PK.pickup, { earliestPickupWhen: 'NONE', earliestPickupText: '' }),
  })
  assert.deepEqual(storeStatusOf(noneBreak, 'PICKUP'), { tone: 'closed', label: '已打烊' })

  // LATER 且此刻不在营业时段（营业时间外）：与 HEAD 的「已打烊/午间休息 · 可预约」三件套逐字节一致
  const closedLater = Object.assign({}, PK, {
    closedKind: 'CLOSED',
    pickup: Object.assign({}, PK.pickup, { earliestPickupWhen: 'LATER', earliestPickupText: '最早明天 10:30–11:00 可取' }),
  })
  assert.deepEqual(storeStatusOf(closedLater, 'PICKUP'), { tone: 'schedule', label: '已打烊 · 可预约' })
  assert.deepEqual(headNoticeOf(closedLater, 'PICKUP'), { text: '现在下单为预约自取，最早明天 10:30–11:00 可取', blocking: false })
  assert.equal(pickupModeHint(closedLater), '（可预约）')
  const breakLater = Object.assign({}, closedLater, { closedKind: 'BREAK' })
  assert.deepEqual(storeStatusOf(breakLater, 'PICKUP'), { tone: 'schedule', label: '午间休息 · 可预约' })

  // 老服务端（无 earliestPickupWhen 字段）：维持 HEAD 行为，逐字节不变
  assert.deepEqual(storeStatusOf(Object.assign({}, PK, { closedKind: 'CLOSED' }), 'PICKUP'),
    { tone: 'schedule', label: '已打烊 · 可预约' })
  assert.deepEqual(headNoticeOf(Object.assign({}, PK, { closedKind: 'CLOSED' }), 'PICKUP'),
    { text: '现在下单为预约自取', blocking: false })
  assert.equal(pickupModeHint(Object.assign({}, PK, { isOpen: false, closedKind: 'CLOSED' })), '（可预约）')
  assert.deepEqual(storeStatusOf(PK, 'PICKUP'), { tone: 'open', label: '营业中' })
  assert.deepEqual(headNoticeOf(PK, 'PICKUP'), { text: '', blocking: false })
  assert.equal(pickupModeHint(PK), '')

  // 暂停/未开通/休业叠 when:'NONE' → 优先级不变，仍是各自原结果
  const pausedNone = Object.assign({}, PK, {
    closedKind: 'CLOSED',
    pickup: Object.assign({}, PK.pickup, { paused: { reason: '后厨忙' }, earliestPickupWhen: 'NONE' }),
  })
  assert.deepEqual(storeStatusOf(pausedNone, 'PICKUP'), { tone: 'paused', label: '暂停接单' })
  assert.deepEqual(headNoticeOf(pausedNone, 'PICKUP'), { text: '自取暂停接单：后厨忙', blocking: true })
  const offNone = Object.assign({}, PK, {
    closedKind: 'CLOSED',
    pickup: Object.assign({}, PK.pickup, { enabled: false, earliestPickupWhen: 'NONE' }),
  })
  assert.deepEqual(storeStatusOf(offNone, 'PICKUP'), { tone: 'closed', label: '暂未开通' })
  assert.deepEqual(headNoticeOf(offNone, 'PICKUP'), { text: '到店自取暂未开通', blocking: true })
  const holidayNone = Object.assign({}, PK, {
    holiday: { until: null, reason: '装修' },
    pickup: Object.assign({}, PK.pickup, { earliestPickupWhen: 'NONE' }),
  })
  assert.deepEqual(storeStatusOf(holidayNone, 'PICKUP'), { tone: 'closed', label: '休息中' })
  assert.deepEqual(headNoticeOf(holidayNone, 'PICKUP'), { text: '休息中', blocking: true })
})

test('休业：两种模式都灰、都阻塞、文案带恢复日期', function () {
  const h = Object.assign({}, PK, { holiday: { until: '2026-10-08', reason: '国庆' } })
  assert.equal(holidayText(h), '休息中，10月08日后恢复')
  assert.deepEqual(storeStatusOf(h, 'DELIVERY'), { tone: 'closed', label: '休息中，10月08日后恢复' })
  assert.deepEqual(storeStatusOf(h, 'PICKUP'), { tone: 'closed', label: '休息中，10月08日后恢复' })
  assert.deepEqual(headNoticeOf(h, 'PICKUP'), { text: '休息中，10月08日后恢复', blocking: true })
  assert.deepEqual(headNoticeOf(h, 'DELIVERY'), { text: '休息中，10月08日后恢复', blocking: true })
  assert.equal(holidayText(Object.assign({}, PK, { holiday: { until: null, reason: '' } })), '休息中')
})

test('起送线按模式取：自取看 pickup.minOrderAmountFen，外送看 fee.minOrderAmount', function () {
  assert.equal(minOrderOf(PK, 'PICKUP'), 1500)
  assert.equal(minOrderOf(PK, 'DELIVERY'), 4000)
  assert.deepEqual(checkoutStateOf(PK, 1, 1000, false, 'PICKUP'), { gap: 500, disabled: true, text: '还差 ¥5.00 起送' })
  assert.deepEqual(checkoutStateOf(PK, 1, 1500, false, 'PICKUP'), { gap: 0, disabled: false, text: '去结算' })
})

test('自取规则行：折扣 · 起送 · 门店地址；缺 pickup 节为空串', function () {
  assert.equal(pickupRulesText(PK), '自取享 9.5 折 · 满 ¥15 起 · 自流井区丹桂40栋底楼')
  assert.equal(pickupRulesText(OPEN), '')
})

test('模式回落：外送关自取开 → PICKUP；自取关外送开 → DELIVERY；都开尊重当前值', function () {
  assert.equal(resolveLocalMode(Object.assign({}, PK, { enabled: false }), 'DELIVERY'), 'PICKUP')
  assert.equal(resolveLocalMode(Object.assign({}, PK, { pickup: Object.assign({}, PK.pickup, { enabled: false }) }), 'PICKUP'), 'DELIVERY')
  assert.equal(resolveLocalMode(PK, 'PICKUP'), 'PICKUP')
  assert.equal(resolveLocalMode(null, 'PICKUP'), 'PICKUP')
})

test('替代出路：本侧阻塞时给另一侧，另一侧也不可用时给 null', function () {
  assert.equal(modeAvailable(PK, 'PICKUP'), true)
  assert.equal(altModeOf(Object.assign({}, PK, { paused: { reason: '骑手不够' } }), 'DELIVERY'), 'PICKUP')
  assert.equal(altModeOf(Object.assign({}, PK, { holiday: { until: null, reason: '' } }), 'DELIVERY'), null)
  assert.equal(altModeOf(Object.assign({}, PK, { pickup: Object.assign({}, PK.pickup, { enabled: false }) }), 'PICKUP'), 'DELIVERY')
})

// 切换栏小字（PO 2026-09-11，2026-09-23 改为只看自取自己的营业时段）：顶部胶囊已有状态，
// 只在自取不在营业时段时提示「可预约」——不再依赖外送那一侧的状态
test('pickupModeHint：自取不在营业时段才显示「可预约」，营业中/休业/自取暂停/未开通都为空', function () {
  assert.equal(pickupModeHint(PK), '')
  assert.equal(pickupModeHint(Object.assign({}, PK, { isOpen: false, closedKind: 'CLOSED' })), '（可预约）')
  assert.equal(pickupModeHint(Object.assign({}, PK, { isOpen: false, closedKind: 'BREAK' })), '（可预约）')
  assert.equal(pickupModeHint(Object.assign({}, PK, { isOpen: false, holiday: { until: null, reason: '装修' } })), '')
  assert.equal(pickupModeHint(Object.assign({}, PK, { isOpen: false, pickup: Object.assign({}, PK.pickup, { paused: { reason: 'x', until: null } }) })), '')
  assert.equal(pickupModeHint(null), '')
  // 回归场景：预约送达上线后外送打烊时 tone 是 'schedule'（不是 'closed'）——旧实现靠比较两侧 tone
  // 会在这里漏判，新实现只看自取自己的 closedKind，不受影响
  assert.equal(pickupModeHint(Object.assign({}, PK, {
    isOpen: false, closedKind: 'CLOSED', delivery: { scheduleEnabled: true, earliestScheduleText: '' },
  })), '（可预约）')
  // 外送暂停时（旧实现靠外送 tone==='closed' 才会漏判成 'paused'，同样与自取无关）
  assert.equal(pickupModeHint(Object.assign({}, PK, { closedKind: 'BREAK', paused: { reason: 'x' } })), '（可预约）')
  // 自取本身未开通：即使打烊也不该提示「可预约」
  assert.equal(pickupModeHint(Object.assign({}, PK, {
    closedKind: 'CLOSED', pickup: Object.assign({}, PK.pickup, { enabled: false }),
  })), '')
})


const openMeta = { enabled: true, isOpen: true, paused: null, holiday: null, closedKind: 'OPEN', nextOpenText: '', fee: { minOrderAmount: 4000 }, delivery: { scheduleEnabled: true, earliestScheduleText: '' } }
const closedSched = Object.assign({}, openMeta, { isOpen: false, closedKind: 'CLOSED', nextOpenText: '明天 09:00 营业', delivery: { scheduleEnabled: true, earliestScheduleText: '最早明天 09:30–10:00送达' } })
const closedNoSched = Object.assign({}, closedSched, { delivery: { scheduleEnabled: false, earliestScheduleText: '' } })

test('打烊 + 预约开：胶囊「已打烊 · 可预约」、通知软提示带最早送达、外送副标「（可预约）」', () => {
  assert.deepEqual(storeStatusOf(closedSched, 'DELIVERY'), { tone: 'schedule', label: '已打烊 · 可预约' })
  assert.deepEqual(headNoticeOf(closedSched, 'DELIVERY'), { text: '现在下单为预约配送，最早明天 09:30–10:00送达', blocking: false })
  assert.equal(deliveryModeHint(closedSched), '（可预约）')
  assert.equal(deliveryScheduleOnly(closedSched), true)
})
test('午休 + 预约开：胶囊「午间休息 · 可预约」（不是「已打烊」）', () => {
  const breakSched = Object.assign({}, closedSched, { closedKind: 'BREAK' })
  assert.deepEqual(storeStatusOf(breakSched, 'DELIVERY'), { tone: 'schedule', label: '午间休息 · 可预约' })
})
test('打烊 + 预约关：与改前逐字节一致（阻塞）', () => {
  assert.deepEqual(storeStatusOf(closedNoSched, 'DELIVERY'), { tone: 'closed', label: '已打烊' })
  assert.deepEqual(headNoticeOf(closedNoSched, 'DELIVERY'), { text: '明天 09:00 营业', blocking: true })
  assert.equal(deliveryModeHint(closedNoSched), '')
  // 午休 + 预约关：仍是灰胶囊「午间休息」，不因预约关着而变成「已打烊」
  assert.deepEqual(storeStatusOf(Object.assign({}, closedNoSched, { closedKind: 'BREAK' }), 'DELIVERY'),
    { tone: 'closed', label: '午间休息' })
})
test('营业中 / 暂停 / 休业：预约开关不影响原判定', () => {
  assert.deepEqual(storeStatusOf(openMeta, 'DELIVERY'), { tone: 'open', label: '营业中' })
  assert.equal(deliveryScheduleOnly(Object.assign({}, closedSched, { paused: { reason: '忙' } })), false)
  assert.equal(deliveryScheduleOnly(Object.assign({}, closedSched, { holiday: { until: null } })), false)
})
