// 自取结算页底部按钮的唯一判定 + 金额预览 + 时段选择的三个小函数。
//
// 与 local-checkout-state.js 同一套理由：结算页有七八种可见状态，每种都要同时决定
// 「能不能点 / 写什么 / 金额显示成什么 / 点了干什么」，散在页面里拼三元表达式
// 必然出现「文案改了但按钮还能点」。
//
// 优先级：阻塞 → 时段加载中 → 时段获取失败 → 无可取时段 → 未选时段 → 时段失效 →
// 手机号 → 起送线 → 金额未知 → 餐具 → 优惠重算中 → 提交中。
// 「未选时段」与「时段失效」这两格按钮**都可点**：前者动作是 slot（打开时段选择器），
// 后者是 reslot（重新拉时段并打开选择器）——都不是提交，与「未选餐具」同一套处理，
// 页面必须按 action 分派，绝不能以「按钮没禁用」推断该提交。
// 2026-09-17 起进页不再自动预选第一个时段（顾客自己选），所以「未选时段」不再禁用按钮。
// 「时段加载中 / 获取失败 / 无可取时段」这三格禁用提交（没格子可选，点了也白点），
// 但金额（amountState）不因为这三格而降级——顾客的应付金额只看 payAmount 算不算得出来，
// 与时段是否加载完成无关；这三格与「未选时段」共用同一条 amt 计算，回归缺陷见下。
// 「时段加载中 / 获取失败」这两格只在「尚未选中时段」（!hasSlot）时才生效：已经选好时段
// 与餐具的顾客一返回本页，onShow 会并发重拉 meta 与 slots，slotsLoading 先同步置 true，
// 若这里不加 !hasSlot，按钮会从「提交订单」瞬间翻成禁用态——回归见下方 2026-09-17 记录。
// 「无可取时段」（noSlots）这格反而不能加 !hasSlot：刷新回来一格都没有时，已选的那格
// 必然也不在新列表里了，此时该禁用提交、文案「暂无可取时段」，而不是继续显示旧选择。
//
// ⚠️ 本文件必须保持 ES5（scripts/check-miniapp-es5.mjs 把守）。

var formatPrice = require('./format').formatPrice

var TEXT = {
  BLOCKED: '暂不可自取',
  NO_SLOT: '请选择取餐时间',
  SLOT_LOADING: '正在获取时段…',
  SLOT_LOADING_ERROR: '取餐时段获取失败',
  NO_SLOTS: '暂无可取时段',
  SLOT_STALE: '重新选择时间',
  NO_PHONE: '请填写手机号',
  NO_TABLEWARE: '请选择餐具',
  SUBMIT: '提交订单',
  SUBMITTING: '提交中',
}

function result(disabled, text, amountState, action) {
  return { disabled: disabled, text: text, amountState: amountState, action: action }
}

/**
 * @param {Object} s
 *   blockReason     业务阻塞（休业/暂停/未开通），非空即阻塞
 *   slotsLoading    时段列表正在拉取中
 *   slotsError      时段列表拉取失败
 *   noSlots         时段列表已拉到但没有任何一格可选（区分「还没选」与「真没时段」）
 *   hasSlot         已选中一个取餐时段
 *   slotStale       已选的那格已不在最新时段列表里（过期或店主改了设置）
 *   phoneValid      取餐人手机号合法
 *   belowMinGap     距自取起送线还差多少（分），0 = 达标
 *   payAmount       应付金额（分），null = 还算不出来
 *   hasTableware    已选餐具
 *   benefitsLoading 优惠券/赠品正在重算
 *   submitting      正在提交
 */
function pickupCheckoutAction(s) {
  var st = s || {}
  if (st.blockReason) return result(true, TEXT.BLOCKED, 'blocked', 'none')
  // 金额与时段是否加载完成无关：能算出来就照常显示，别因为时段没格子就把底栏压成「待计算」
  var amt = st.payAmount === null || st.payAmount === undefined ? 'pending' : 'ready'
  if (st.slotsLoading && !st.hasSlot) return result(true, TEXT.SLOT_LOADING, amt, 'none')
  if (st.slotsError && !st.hasSlot) return result(true, TEXT.SLOT_LOADING_ERROR, amt, 'none')
  if (st.noSlots) return result(true, TEXT.NO_SLOTS, amt, 'none')
  // 与「未选餐具」一致：按钮可点，动作是打开时段选择器，不是提交
  if (!st.hasSlot) return result(false, TEXT.NO_SLOT, amt, 'slot')
  if (st.slotStale) return result(false, TEXT.SLOT_STALE, 'pending', 'reslot')
  if (!st.phoneValid) return result(true, TEXT.NO_PHONE, 'ready', 'none')
  if (st.belowMinGap > 0) return result(true, '还差 ¥' + formatPrice(st.belowMinGap) + ' 起', 'ready', 'none')
  if (st.payAmount === null || st.payAmount === undefined) return result(true, TEXT.SUBMIT, 'pending', 'none')
  // 餐具必选（餐具设计 T2）。放在金额未知之后——amountState='ready' 时金额一定算得出来
  // （spec §5.3 的顺序据此勘误）。按钮可点，动作是打开餐具弹层
  if (!st.hasTableware) return result(false, TEXT.NO_TABLEWARE, 'ready', 'tableware')
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

/** 小计 → 自取优惠 → 券（封顶到 小计−自取优惠）→ 打包费 → 实付。运费恒 0，所以这里没有它。
 * 打包费不参与券封顶的判定（封顶只看 小计−自取优惠），只在最后原样加回来——
 * 与服务端 computeCheckout 的口径一致：packingFee 与 shippingFee 同层相加。 */
function computePickupPay(subtotal, rule, couponDiscount, packingFee) {
  var pd = pickupDiscountOf(rule, subtotal)
  var cap = Math.max(0, subtotal - pd)
  var cd = Math.min(couponDiscount || 0, cap)
  var pf = packingFee || 0
  return { pickupDiscount: pd, couponDiscount: cd, packingFee: pf, payAmount: subtotal - pd - cd + pf }
}

/** 单份打包费（分）：优先取行上已解析好的 packingFeeEach（购物车行是扁平字段），
 * 兼容传入 { product: { packingFeeEach } } 这种嵌套形状。 */
function packingFeeEachOf(item) {
  if (!item) return 0
  var p = item.product
  if (p && typeof p.packingFeeEach === 'number') return p.packingFeeEach
  return typeof item.packingFeeEach === 'number' ? item.packingFeeEach : 0
}

/**
 * 打包费预览（2026-09-13 打包费设计 §4.1）：Σ quantity × 单份打包费。
 * 赠品行不在购物车里，不需要额外排除。总开关关闭时服务端下发的 packingFeeEach
 * 本就恒为 0（见 apps/server 侧 packingFeeEach 恒 0 的口径），这里不再额外接一道
 * enabled 门——那道门在 meta 没拉到/拉失败时会把这一项算成 0，
 * 而 items 里的 packingFeeEach 其实是非 0 的，导致明细行与应付金额对不上。
 */
function packingFeeOf(items) {
  return (items || []).reduce(function(sum, item) {
    return sum + (item.quantity || 0) * packingFeeEachOf(item)
  }, 0)
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

// 'YYYY-MM-DD' → { monthDay: '9月12日', weekday: '周六' }。星期按日历日算（Date.UTC 不受手机时区影响）。
// 用途：时段弹层页签副标题、结算页「取餐时间」文案——顾客过了零点还停在这页，光看「今天/明天」会搞混（PO 2026-09-12）。
var WEEKDAY = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
function pickupDateText(dateStr) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr || '')
  if (!m) return { monthDay: '', weekday: '' }
  var y = Number(m[1]), mo = Number(m[2]), d = Number(m[3])
  return { monthDay: mo + '月' + d + '日', weekday: WEEKDAY[new Date(Date.UTC(y, mo - 1, d)).getUTCDay()] }
}

module.exports = {
  pickupDateText: pickupDateText,
  pickupCheckoutAction: pickupCheckoutAction,
  isValidPhone: isValidPhone,
  pickupDiscountOf: pickupDiscountOf,
  computePickupPay: computePickupPay,
  packingFeeOf: packingFeeOf,
  firstSlot: firstSlot,
  slotOffered: slotOffered,
}
