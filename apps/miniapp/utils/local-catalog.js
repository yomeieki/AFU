// 同城菜单的三段判断，抽成纯函数供主页、分类页、购物车页、购物车条共用。
//
// 为什么不各写一遍：这几处都要判「店头显示什么」「车里多少钱」「能不能去结算」。
// 各写一遍迟早有一边漏掉「暂停接单时也要挡住结算」——而那一边看上去完全正常，
// 只有顾客真按下「去结算」、走到服务端 42226 那一刻才炸。
//
// 2026-09-11 起同城有两种履约方式：外送（DELIVERY）与到店自取（PICKUP）。
// mode 参数缺省 DELIVERY，**不传时行为与改前逐字节一致**（tests/miniapp/local-catalog.test.cjs 钉住）。
// 自取读的是 /local/meta 的 pickup 节与 holiday 节；营业时间外自取**不阻塞**（可预约后续时段）。

var formatPrice = require('./format').formatPrice
// 归一化只在 utils/channel.js 一处（Global Constraint）；这里只是取个短名
var normMode = require('./channel').normalizeLocalMode

function pickupMeta(meta) {
  return meta && meta.pickup ? meta.pickup : null
}

/** 「休息中，10月08日恢复」；until 为空只说「休息中」；无休业返回 '' */
function holidayText(meta) {
  var h = meta && meta.holiday
  if (!h) return ''
  return '休息中' + (h.until ? '，' + String(h.until).slice(5).replace('-', '月') + '日恢复' : '')
}

/**
 * 店头那颗状态胶囊。
 * 休业压过一切；自取看 pickup 节；外送沿用原判定（暂停优先于打烊，两段之间是午间休息）。
 * meta 还没回来时给「暂未营业」而不是空字符串——空胶囊是个视觉噪点，且会让人以为在营业。
 */
function storeStatusOf(meta, mode) {
  if (!meta) return { tone: 'closed', label: '暂未营业' }
  if (meta.holiday) return { tone: 'closed', label: '休息中' }
  if (normMode(mode) === 'PICKUP') {
    var pk = pickupMeta(meta)
    if (!pk || !pk.enabled) return { tone: 'closed', label: '暂未开通' }
    if (pk.paused) return { tone: 'paused', label: '暂停接单' }
    return { tone: 'open', label: '可预约' }
  }
  if (meta.paused) return { tone: 'paused', label: '暂停接单' }
  // 两段营业时间中间那段是「午间休息」，不是打烊（PO 2026-09-08）
  if (meta.enabled && !meta.isOpen && meta.closedKind === 'BREAK') return { tone: 'closed', label: '午间休息' }
  if (!meta.enabled || !meta.isOpen) return { tone: 'closed', label: '已打烊' }
  return { tone: 'open', label: '营业中' }
}

/**
 * 页头那条通知。只在**真的挡住下单**时 blocking，blocking 同时给结算态用。
 * 商品在暂停/打烊时仍可浏览、仍可加购（顾客常常先挑好等开门），挡的只是结算。
 * 自取在营业时间外给一条**不阻塞**的提示：顾客可以预约后续时段。
 */
function headNoticeOf(meta, mode) {
  if (!meta) return { text: '', blocking: false }
  if (meta.holiday) return { text: holidayText(meta), blocking: true }
  if (normMode(mode) === 'PICKUP') {
    var pk = pickupMeta(meta)
    if (!pk || !pk.enabled) return { text: '到店自取暂未开通', blocking: true }
    if (pk.paused) {
      return { text: '自取暂停接单' + (pk.paused.reason ? '：' + pk.paused.reason : ''), blocking: true }
    }
    if (meta.closedKind && meta.closedKind !== 'OPEN') return { text: '当前非营业时间，可预约后续时段', blocking: false }
    return { text: '', blocking: false }
  }
  if (!meta.enabled) return { text: '同城配送即将开通', blocking: true }
  if (meta.paused) {
    return {
      text: '暂停接单' + (meta.paused.reason ? '：' + meta.paused.reason : ''),
      blocking: true,
    }
  }
  if (!meta.isOpen) return { text: meta.nextOpenText || '当前非营业时间', blocking: true }
  return { text: '', blocking: false }
}

function summarizeCart(items) {
  return (items || []).reduce(function(summary, item) {
    summary.count += item.quantity || 0
    summary.amount += item.subtotal || 0
    return summary
  }, { count: 0, amount: 0 })
}

/** 起送线（分）：自取看 pickup.minOrderAmountFen，外送看 fee.minOrderAmount；缺则 0 */
function minOrderOf(meta, mode) {
  if (!meta) return 0
  if (normMode(mode) === 'PICKUP') {
    var pk = pickupMeta(meta)
    return pk ? (pk.minOrderAmountFen || 0) : 0
  }
  return meta.fee ? (meta.fee.minOrderAmount || 0) : 0
}

/**
 * 能不能去结算，以及按钮上写什么。
 * 差额一定要说出**具体数字**：顾客看到「还差 ¥15.00 起送」会回去加菜，
 * 看到一句「未达起送」只会直接退出去。
 * 业务阻塞（未开通/暂停/打烊/休业）优先于起送线——加满也不能结，措辞不能误导成「再加点就行」。
 */
function checkoutStateOf(meta, count, amount, blocking, mode) {
  var minimum = minOrderOf(meta, mode)
  var gap = Math.max(0, minimum - amount)
  var disabled = !meta || !!blocking || count <= 0 || gap > 0
  var text = gap > 0 ? '还差 ¥' + formatPrice(gap) + ' 起送' : '去结算'
  if (blocking) text = '暂不可结算'
  return { gap: blocking ? 0 : gap, disabled: disabled, text: text }
}

/** 自取模式的规则行：「自取享 9.5 折 · 满 ¥15 起 · 自流井区丹桂40栋底楼」。缺 pickup 节返回 '' */
function pickupRulesText(meta) {
  var pk = pickupMeta(meta)
  if (!pk) return ''
  var parts = []
  if (pk.discountText) parts.push(pk.discountText)
  if (pk.minOrderAmountFen) parts.push('满 ¥' + (pk.minOrderAmountFen / 100).toFixed(2).replace(/\.00$/, '') + ' 起')
  var store = meta.store
  if (store && store.address) parts.push((store.district || '') + store.address)
  return parts.join(' · ')
}

/** 某个模式此刻能不能下单（不看营业时段：外送打烊只是「现在不行」，自取本来就能约后面的时段） */
function modeAvailable(meta, mode) {
  if (!meta || meta.holiday) return false
  if (normMode(mode) === 'PICKUP') {
    var pk = pickupMeta(meta)
    return !!(pk && pk.enabled && !pk.paused)
  }
  return !!(meta.enabled && !meta.paused)
}

/** 本侧走不通时的另一侧；另一侧也走不通返回 null（此时页面给「去全国邮寄」） */
function altModeOf(meta, mode) {
  var other = normMode(mode) === 'PICKUP' ? 'DELIVERY' : 'PICKUP'
  return modeAvailable(meta, other) ? other : null
}

/**
 * 进同城时定模式：外送关了而自取开着 → 自取；自取关了而外送开着 → 外送；其余尊重当前值。
 * meta 还没回来时不改（拿不到事实就别猜）。
 */
function resolveLocalMode(meta, current) {
  var mode = normMode(current)
  if (!meta) return mode
  var deliveryOn = !!meta.enabled
  var pk = pickupMeta(meta)
  var pickupOn = !!(pk && pk.enabled)
  if (mode === 'DELIVERY' && !deliveryOn && pickupOn) return 'PICKUP'
  if (mode === 'PICKUP' && !pickupOn && deliveryOn) return 'DELIVERY'
  return mode
}

module.exports = {
  storeStatusOf: storeStatusOf,
  headNoticeOf: headNoticeOf,
  summarizeCart: summarizeCart,
  checkoutStateOf: checkoutStateOf,
  minOrderOf: minOrderOf,
  pickupRulesText: pickupRulesText,
  modeAvailable: modeAvailable,
  altModeOf: altModeOf,
  resolveLocalMode: resolveLocalMode,
  holidayText: holidayText,
}
