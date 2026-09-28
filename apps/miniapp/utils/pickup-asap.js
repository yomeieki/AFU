// 到店自取「尽快取」（2026-09-28）小程序侧的纯函数：结算页的尽快取卡片、下单载荷、订单详情文案。
//
// 服务端 GET /local/pickup-slots 与 /local/meta 的 pickup 节新增
//   asap: { available, readyAt, minutes, reason }
// 老服务端没有这个字段 → decorateAsap 返回 null，页面按改动前的样子只显示预约时段。
//
// ⚠️ 本文件必须保持 ES5（scripts/check-miniapp-es5.mjs 把守）。

var fmtHHmm = require('./time').fmtHHmm

// 尽快取不可用时，预约区下面那行提示（预览 ③）。DISABLED/PAUSED/HOLIDAY 时整页已被阻塞，不用这里的文案
var REASON_HINT = {
  CLOSED: '现在不在营业时间，只能预约',
  TOO_LATE: '本段营业快结束，来不及备餐，只能预约',
  NONE: '今日已约满，只能预约其他时段',
}

/** 服务端 asap 节 → 页面用的形状；缺失/非对象返回 null（老服务端） */
function decorateAsap(asap) {
  if (!asap || typeof asap !== 'object') return null
  var available = asap.available === true && !!asap.readyAt
  return {
    available: available,
    readyAt: available ? asap.readyAt : null,
    readyText: available ? fmtHHmm(asap.readyAt) : '',
    minutes: available ? asap.minutes : null,
    subText: available ? '约 ' + asap.minutes + ' 分钟' : '当前不可用',
    reason: asap.reason || null,
    hint: available ? '' : (REASON_HINT[asap.reason] || ''),
  }
}

/** 第一次拉到 asap 时的默认模式：营业中可用 → 尽快取；否则停在预约（时段不自动预选） */
function initialPickupMode(asap) {
  return asap && asap.available ? 'ASAP' : 'SCHEDULED'
}

/**
 * 下单载荷里「取餐时间」那一段：尽快取带 pickupMode:'ASAP'、不带 pickupAt；
 * 预约只带 pickupAt（不带 pickupMode——与改动前的请求逐字节一致，老服务端也认）。
 */
function pickupTimePayload(mode, selected) {
  if (mode === 'ASAP') return { pickupMode: 'ASAP' }
  return { pickupAt: selected ? selected.startAt : undefined }
}

/** 是不是尽快单（详情接口顶层 pickupAsap，或 pickup 节的 asap） */
function isAsapOrder(order) {
  if (!order || order.deliveryType !== 'PICKUP') return false
  return order.pickupAsap === true || !!(order.pickup && order.pickup.asap === true)
}

/**
 * 订单详情里尽快单的取餐时间文案（D7）：
 *   待付款 → 不出具体钟点（那是下单时算的，付款成功时会重算），「尽快取 · 付款成功后显示预计可取时间」；
 *   已付款 → 「尽快取 预计 HH:mm 可取」，HH:mm 取服务端 pickup.pickupAt（付款重算后的值）；
 *   未付款就取消了 → 只写「尽快取」。非尽快单返回 ''。
 */
function asapDetailText(order) {
  if (!isAsapOrder(order)) return ''
  if (order.status === 'PENDING_PAYMENT') return '尽快取 · 付款成功后显示预计可取时间'
  if (!order.paidAt) return '尽快取'
  var at = (order.pickup && order.pickup.pickupAt) || order.pickupAt
  var hm = at ? fmtHHmm(at) : ''
  return hm ? '尽快取 预计 ' + hm + ' 可取' : '尽快取'
}

/** 尽快单已付款、店家还没接单、可以自助取消时的提示（预览 ④）；其它情形返回 '' 交给原有文案 */
function asapCancelHint(order, canSelfCancel) {
  if (!isAsapOrder(order)) return ''
  return order.status === 'PAID' && canSelfCancel ? '店家接单前可随时取消，取消后原路退款' : ''
}

/** 尽快单接单后取消卡的文案（预览 ⑤）：一接单就不能取消，也没有申请取消 */
var ASAP_ACCEPTED_TEXT = '店家已接单，不可取消'

module.exports = {
  decorateAsap: decorateAsap,
  initialPickupMode: initialPickupMode,
  pickupTimePayload: pickupTimePayload,
  isAsapOrder: isAsapOrder,
  asapDetailText: asapDetailText,
  asapCancelHint: asapCancelHint,
  ASAP_ACCEPTED_TEXT: ASAP_ACCEPTED_TEXT,
}
