// 同城菜单的三段判断，抽成纯函数供主页、分类页、购物车页、购物车条共用。
//
// 为什么不各写一遍：这几处都要判「店头显示什么」「车里多少钱」「能不能去结算」。
// 各写一遍迟早有一边漏掉「暂停接单时也要挡住结算」——而那一边看上去完全正常，
// 只有顾客真按下「去结算」、走到服务端 42226 那一刻才炸。
//
// 2026-09-11 起同城有两种履约方式：外送（DELIVERY）与到店自取（PICKUP）。
// mode 参数缺省 DELIVERY，**不传时行为与改前逐字节一致**（tests/miniapp/local-catalog.test.cjs 钉住）。
// 自取读的是 /local/meta 的 pickup 节与 holiday 节；营业时间外自取通常**不阻塞**（可预约后续时段）——
// 但 2026-09-23 修订 1 起，服务端给的 pickup.earliestPickupWhen==='NONE'（daysAhead 内一格都约不到）
// 时例外：这时才是**真的**约不了，阻塞与「暂停/未开通」同一类（见 storeStatusOf/headNoticeOf）。

var formatPrice = require('./format').formatPrice
// 归一化只在 utils/channel.js 一处（Global Constraint）；这里只是取个短名
var normMode = require('./channel').normalizeLocalMode

function pickupMeta(meta) {
  return meta && meta.pickup ? meta.pickup : null
}

/** 不在营业时段（打烊或午间休息），不看 isOpen——isOpen 会被外送暂停/关闭带偏，closedKind 只看时段与休业 */
function outOfHours(meta) {
  return !!(meta.closedKind && meta.closedKind !== 'OPEN')
}

/** 「已打烊」还是「午间休息」，两段营业时间中间那段是午休（PO 2026-09-08），不是打烊 */
function closedLabel(meta) {
  return meta.closedKind === 'BREAK' ? '午间休息' : '已打烊'
}

/** 「休息中，10月08日后恢复」；until 为空只说「休息中」；无休业返回 '' */
function holidayText(meta) {
  var h = meta && meta.holiday
  if (!h) return ''
  return '休息中' + (h.until ? '，' + String(h.until).slice(5).replace('-', '月') + '日后恢复' : '')
}

/**
 * 店头那颗状态胶囊。
 * 休业压过一切；自取只看自己的营业时段与服务端给的 earliestPickupWhen（不受外送暂停/关闭影响，
 * 自取有自己的暂停开关，2026-09-23）：一格都约不到（NONE）是灰「已打烊」；约得到（CURRENT/LATER，
 * 含"现在就在营业段内、稍后再约"与"本段已约不到，最早是下一段/明天"两种）都是绿「营业中」，除非
 * 此刻确实不在营业时段——那种情形（LATER 且当下不在营业时段）沿用 HEAD 的「打烊/午休 · 可预约」。
 * 老服务端没给 earliestPickupWhen 时按 HEAD 行为（outOfHours 判）兜底。外送沿用原判定（暂停优先于
 * 打烊，两段之间是午间休息）。
 * meta 还没回来时给「暂未营业」而不是空字符串——空胶囊是个视觉噪点，且会让人以为在营业。
 */
function storeStatusOf(meta, mode) {
  if (!meta) return { tone: 'closed', label: '暂未营业' }
  if (meta.holiday) return { tone: 'closed', label: holidayText(meta) }
  if (normMode(mode) === 'PICKUP') {
    var pk = pickupMeta(meta)
    if (!pk || !pk.enabled) return { tone: 'closed', label: '暂未开通' }
    if (pk.paused) return { tone: 'paused', label: '暂停接单' }
    var when = pk.earliestPickupWhen
    if (when === 'NONE') return { tone: 'closed', label: '已打烊' }
    // LATER 且此刻不在营业时段：与 HEAD 一致画「打烊/午休 · 可预约」；LATER 但此刻仍在营业时段
    // （尾段——本段已约不到，最早是下一段/明天）与 CURRENT 都画「营业中」（店主 2026-09-23 拍板）。
    // when 缺失（老服务端）按 outOfHours 兜底，与 HEAD 逐字节一致。
    if (when === undefined ? outOfHours(meta) : (when === 'LATER' && outOfHours(meta))) {
      return { tone: 'schedule', label: closedLabel(meta) + ' · 可预约' }
    }
    return { tone: 'open', label: '营业中' }
  }
  if (meta.paused) return { tone: 'paused', label: '暂停接单' }
  // 打烊但预约开着（2026-09-21 预约送达 §5.1）：不是灰胶囊，是「可预约」——顾客现在下单是预约配送
  if (deliveryScheduleOnly(meta)) return { tone: 'schedule', label: closedLabel(meta) + ' · 可预约' }
  // 两段营业时间中间那段是「午间休息」，不是打烊（PO 2026-09-08）
  if (meta.enabled && !meta.isOpen && meta.closedKind === 'BREAK') return { tone: 'closed', label: '午间休息' }
  if (!meta.enabled || !meta.isOpen) return { tone: 'closed', label: '已打烊' }
  return { tone: 'open', label: '营业中' }
}

/**
 * 页头那条通知。只在**真的挡住下单**时 blocking，blocking 同时给结算态用。
 * 商品在暂停/打烊时仍可浏览、仍可加购（顾客常常先挑好等开门），挡的只是结算。
 * 自取通常给一条**不阻塞**的软提示：顾客可以预约后续时段；但 earliestPickupWhen==='NONE'
 * （daysAhead 内一格都约不到）时是例外——这时是真的挡住下单，与「暂停/未开通」同一类阻塞
 * （2026-09-23 修订 1，店主拍板：措辞用「暂无可取时段」）。
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
    var when = pk.earliestPickupWhen
    if (when === 'NONE') return { text: '暂无可取时段', blocking: true }
    if (when === 'CURRENT') return { text: '', blocking: false }
    // LATER（任一种——营业时间外，或此刻仍在营业时段但本段已约不到）都给软提示；
    // when 缺失（老服务端）按 outOfHours 兜底，与 HEAD 逐字节一致。
    if (when === 'LATER' || (when === undefined && outOfHours(meta))) {
      var earliestPickup = pk.earliestPickupText
      return { text: '现在下单为预约自取' + (earliestPickup ? '，' + earliestPickup : ''), blocking: false }
    }
    return { text: '', blocking: false }
  }
  if (!meta.enabled) return { text: '同城配送即将开通', blocking: true }
  if (meta.paused) {
    return {
      text: '暂停接单' + (meta.paused.reason ? '：' + meta.paused.reason : ''),
      blocking: true,
    }
  }
  if (deliveryScheduleOnly(meta)) {
    var earliest = meta.delivery && meta.delivery.earliestScheduleText
    return { text: '现在下单为预约配送' + (earliest ? '，' + earliest : ''), blocking: false }
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

/**
 * 某个模式此刻能不能下单。外送不看营业时段：打烊只是「现在不行」，不代表走不通（可能能预约）。
 * 自取原则上也不看时段（本来就能约后面的时段），但看服务端给的 earliestPickupWhen——
 * ==='NONE' 时是真的一格都约不到，判不可用（2026-09-23 修订 1）；老服务端没给这个字段时
 * 不受影响，仍是 HEAD 的口径（只看开通/暂停开关）。
 */
function modeAvailable(meta, mode) {
  if (!meta || meta.holiday) return false
  if (normMode(mode) === 'PICKUP') {
    var pk = pickupMeta(meta)
    if (!pk || !pk.enabled || pk.paused) return false
    return pk.earliestPickupWhen !== 'NONE'
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

// 切换栏「自取」下的小字（PO 2026-09-11，2026-09-23 改为只看自取自己的营业时段；同日修订 1
// 改按服务端 earliestPickupWhen 判）：顶部胶囊已经说了营业状态，切换栏不再常驻状态字；
// LATER（含"此刻在营业段内但本段已约不到"的尾段、以及营业时间外）时补一句「可预约」——
// CURRENT（正在营业段内，约的是本段稍后）与 NONE（一格都约不到）都不补。modeAvailable 已经把
// NONE 挡在前面（判不可用），这里的 NONE 分支只是防御性兜底。老服务端没给 when 时按 outOfHours
// 兜底，与 HEAD 逐字节一致。不再依赖外送那一侧的状态，自取有自己的暂停/开通开关。
function pickupModeHint(meta) {
  if (!meta || meta.holiday) return ''
  if (!modeAvailable(meta, 'PICKUP')) return ''
  var pk = pickupMeta(meta)
  var when = pk && pk.earliestPickupWhen
  if (when === undefined) return outOfHours(meta) ? '（可预约）' : ''
  return when === 'LATER' ? '（可预约）' : ''
}

/** 外送此刻只能预约：开着、没暂停、没休业、不在营业时段、预约开着。营业中或预约关着都返回 false */
function deliveryScheduleOnly(meta) {
  if (!meta || meta.holiday || !meta.enabled || meta.paused) return false
  var d = meta.delivery
  return !!(d && d.scheduleEnabled && !meta.isOpen)
}
// 切换栏「外送」下的小字：只在打烊而预约可用时补「（可预约）」——与自取的 pickupModeHint 各自只看
// 自己这一侧的营业时段，两侧互不依赖（2026-09-23 起 pickupModeHint 不再读外送状态）
function deliveryModeHint(meta) {
  return deliveryScheduleOnly(meta) ? '（可预约）' : ''
}

module.exports = {
  storeStatusOf: storeStatusOf,
  pickupModeHint: pickupModeHint,
  headNoticeOf: headNoticeOf,
  summarizeCart: summarizeCart,
  checkoutStateOf: checkoutStateOf,
  minOrderOf: minOrderOf,
  pickupRulesText: pickupRulesText,
  modeAvailable: modeAvailable,
  altModeOf: altModeOf,
  resolveLocalMode: resolveLocalMode,
  holidayText: holidayText,
  deliveryScheduleOnly: deliveryScheduleOnly,
  deliveryModeHint: deliveryModeHint,
}
