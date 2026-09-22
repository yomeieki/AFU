// 预约送达（同城外送）在订单详情/列表页要用到的纯文案函数。
//
// 全部读服务端已经算好的字段（order.schedule.* / order.canSelfCancel / order.canRequestCancel /
// order.scheduledAt），本文件不倒推、不算时区——时刻格式化由调用方传入（utils/time 的 fmtHHmm），
// 这样才可测：传一个假的 fmtHHmm 就能钉住文案，不用在用例里摆弄真实时间戳的时区换算。
//
// 非预约单（没有 order.schedule 也没有 order.scheduledAt）时，下面每个函数都退回 ''（或 null），
// 调用方用 `fn(order) || 原表達式` 的写法接回旧逻辑——立即单/自取/邮寄因此不用改一个字。
//
// ⚠️ 新文件，保持 ES5：不用 const/let/箭头函数/模板字符串。不 require 页面或 wx API。

/**
 * 详情顶部横幅：「预约配送 · 明天 12:00–12:30 送达」；非预约单返回 ''
 */
function scheduleBannerText(order) {
  if (!order || !order.schedule || !order.schedule.slotLabel) return ''
  return '预约配送 · ' + order.schedule.slotLabel + ' 送达'
}

/**
 * 时间线「已付款」步的 extra：
 *   接单前「商家将在 HH:mm 前确认」（读 schedule.acceptDueAt）
 *   接单后「商家已确认，HH:mm 开始备餐」（读 schedule.prepStartAt）
 * 非预约单返回 ''。是否已接单由 order.acceptedAt 判断——调用方按这一位再决定
 * 把这句话放在「支付成功」还是「商家接单」那一步的 extra 上。
 */
function schedulePaidExtra(order, fmtHHmm) {
  if (!order || !order.schedule) return ''
  var schedule = order.schedule
  if (!order.acceptedAt) {
    if (!schedule.acceptDueAt) return ''
    return '商家将在 ' + fmtHHmm(schedule.acceptDueAt) + ' 前确认'
  }
  if (!schedule.prepStartAt) return ''
  return '商家已确认，' + fmtHHmm(schedule.prepStartAt) + ' 开始备餐'
}

/**
 * 状态标签：预约单 PAID → 「已预约」；其余返回 null（调用方沿用原状态表）
 */
function scheduleStatusLabel(order) {
  if (!order || !order.scheduledAt) return null
  if (order.status === 'PAID') return '已预约'
  return null
}

/**
 * 取消卡文案（三段，读 canSelfCancel / canRequestCancel / schedule.selfCancelUntil / schedule.readyAt）：
 *   两小时外（canSelfCancel）  ：「HH:mm 前可直接取消」
 *   两小时内且未备好（canRequestCancel）：「可申请取消，商家确认后全额退款」
 *   已备好（schedule.readyAt 非空，两个取消权限都没有了）：「餐品已在准备，如有问题请联系商家」
 * 非预约单返回 ''。
 */
function scheduleCancelCopy(order, fmtHHmm) {
  if (!order || !order.schedule) return ''
  var schedule = order.schedule
  if (order.canSelfCancel) {
    return schedule.selfCancelUntil ? (fmtHHmm(schedule.selfCancelUntil) + ' 前可直接取消') : ''
  }
  if (order.canRequestCancel) {
    return '可申请取消，商家确认后全额退款'
  }
  if (schedule.readyAt) {
    return '餐品已在准备，如有问题请联系商家'
  }
  return ''
}

/**
 * 列表卡标签：预约单 '同城 · 预约'，否则 null（调用方沿用 TYPE_META 的原标签）
 */
function scheduleTypeLabel(order) {
  if (order && order.scheduledAt) return '同城 · 预约'
  return null
}

module.exports = {
  scheduleBannerText: scheduleBannerText,
  schedulePaidExtra: schedulePaidExtra,
  scheduleStatusLabel: scheduleStatusLabel,
  scheduleCancelCopy: scheduleCancelCopy,
  scheduleTypeLabel: scheduleTypeLabel,
}
