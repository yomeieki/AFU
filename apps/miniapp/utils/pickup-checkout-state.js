// 自取结算页底部按钮的唯一判定 + 金额预览 + 时段选择的三个小函数。
//
// 与 local-checkout-state.js 同一套理由：结算页有七八种可见状态，每种都要同时决定
// 「能不能点 / 写什么 / 金额显示成什么 / 点了干什么」，散在页面里拼三元表达式
// 必然出现「文案改了但按钮还能点」。
//
// 优先级：阻塞 → 未选时段 → 时段失效 → 手机号 → 起送线 → 金额未知 → 优惠重算中 → 提交中。
// 「时段失效」那一格按钮**可点**，动作是 reslot（重新拉时段并打开选择器），不是提交——
// 页面必须按 action 分派，绝不能以「按钮没禁用」推断该提交。
//
// ⚠️ 本文件必须保持 ES5（scripts/check-miniapp-es5.mjs 把守）。

var formatPrice = require('./format').formatPrice

var TEXT = {
  BLOCKED: '暂不可自取',
  NO_SLOT: '请选择取餐时间',
  SLOT_STALE: '重新选择时间',
  NO_PHONE: '请填写手机号',
  SUBMIT: '提交订单',
  SUBMITTING: '提交中',
}

function result(disabled, text, amountState, action) {
  return { disabled: disabled, text: text, amountState: amountState, action: action }
}

/**
 * @param {Object} s
 *   blockReason     业务阻塞（休业/暂停/未开通），非空即阻塞
 *   hasSlot         已选中一个取餐时段
 *   slotStale       已选的那格已不在最新时段列表里（过期或店主改了设置）
 *   phoneValid      取餐人手机号合法
 *   belowMinGap     距自取起送线还差多少（分），0 = 达标
 *   payAmount       应付金额（分），null = 还算不出来
 *   benefitsLoading 优惠券/赠品正在重算
 *   submitting      正在提交
 */
function pickupCheckoutAction(s) {
  var st = s || {}
  if (st.blockReason) return result(true, TEXT.BLOCKED, 'blocked', 'none')
  if (!st.hasSlot) return result(true, TEXT.NO_SLOT, 'pending', 'none')
  if (st.slotStale) return result(false, TEXT.SLOT_STALE, 'pending', 'reslot')
  if (!st.phoneValid) return result(true, TEXT.NO_PHONE, 'ready', 'none')
  if (st.belowMinGap > 0) return result(true, '还差 ¥' + formatPrice(st.belowMinGap) + ' 起', 'ready', 'none')
  if (st.payAmount === null || st.payAmount === undefined) return result(true, TEXT.SUBMIT, 'pending', 'none')
  if (st.benefitsLoading) return result(true, TEXT.SUBMIT, 'ready', 'submit')
  if (st.submitting) return result(true, TEXT.SUBMITTING, 'ready', 'submit')
  return result(false, TEXT.SUBMIT, 'ready', 'submit')
}

/** 与服务端 zod 校验同一条正则 */
function isValidPhone(phone) {
  return /^1\d{10}$/.test(String(phone === undefined || phone === null ? '' : phone).trim())
}

/**
 * 自取优惠（分）。**公式与服务端 services/pickup.ts 的 pickupDiscountOf 逐字相同**：
 * PERCENT：小计 − round(小计 × value / 100)；FIXED：min(value, 小计)；其它 0。
 * 页面只用它做预览，实收以服务端为准。
 */
function pickupDiscountOf(rule, subtotal) {
  if (!rule || !subtotal) return 0
  if (rule.type === 'PERCENT') return Math.max(0, subtotal - Math.round((subtotal * rule.value) / 100))
  if (rule.type === 'FIXED') return Math.min(rule.value || 0, subtotal)
  return 0
}

/** 小计 → 自取优惠 → 券（封顶到 小计−自取优惠）→ 实付。运费恒 0，所以这里没有它 */
function computePickupPay(subtotal, rule, couponDiscount) {
  var pd = pickupDiscountOf(rule, subtotal)
  var cap = Math.max(0, subtotal - pd)
  var cd = Math.min(couponDiscount || 0, cap)
  return { pickupDiscount: pd, couponDiscount: cd, payAmount: subtotal - pd - cd }
}

/** 第一个可选格：{ dayIndex, slot }；一格都没有返回 null */
function firstSlot(view) {
  var days = (view && view.days) || []
  for (var i = 0; i < days.length; i++) {
    var slots = days[i].slots || []
    if (slots.length) return { dayIndex: i, slot: slots[0] }
  }
  return null
}

/** 某个 startAt 是否仍在最新的时段列表里 */
function slotOffered(view, startAt) {
  var days = (view && view.days) || []
  for (var i = 0; i < days.length; i++) {
    var slots = days[i].slots || []
    for (var j = 0; j < slots.length; j++) if (slots[j].startAt === startAt) return true
  }
  return false
}

module.exports = {
  pickupCheckoutAction: pickupCheckoutAction,
  isValidPhone: isValidPhone,
  pickupDiscountOf: pickupDiscountOf,
  computePickupPay: computePickupPay,
  firstSlot: firstSlot,
  slotOffered: slotOffered,
}
