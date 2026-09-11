const { getOrderDetail, confirmOrder, cancelOrder, requestCancelOrder, getCourierLocation } = require('../../api/order')
const { getLocalMeta } = require('../../api/local')
const { callShop } = require('../../utils/contact')
const { payOrder } = require('../../api/payment')
const { formatPrice } = require('../../utils/format')
const { requestSubscribe } = require('../../utils/subscribe')
var timeUtil = require('../../utils/time')
var fmtDateTime = timeUtil.fmtDateTime
var fmtHHmm = timeUtil.fmtHHmm
var expressTrackUtil = require('../../utils/express-track')

var STATUS_LABEL = {
  PENDING_PAYMENT: '待付款',
  PAID: '待发货',
  PREPARING: '备餐中',
  REFUNDING: '退款中',
  SHIPPED: '已发货',
  COMPLETED: '已完成',
  CANCELLED: '已取消',
  REFUNDED: '已退款',
}

var PICKUP_STATUS_LABEL = Object.assign({}, STATUS_LABEL, { PAID: '待接单', SHIPPED: '待取餐', COMPLETED: '已取餐' })

// 同城配送的异常状态不展示运力侧的内部处理术语，避免顾客误解为订单出错。
var DELIVERY_CUSTOMER_LABEL = {
  PENDING: '商家正在安排配送', CALLING: '正在为您呼叫骑手',
  ACCEPTED: '骑手已接单', ARRIVING: '骑手正在赶往门店', ARRIVED: '骑手已到店取餐',
  DELIVERING: '配送中', DELIVERED: '已送达',
  REASSIGNING: '配送正在协调中', ABNORMAL: '配送正在协调中',
  UNKNOWN: '配送正在协调中', FAILED: '配送正在协调中', CANCELLED: '配送正在协调中',
}
var DELIVERY_NEUTRAL = ['REASSIGNING', 'ABNORMAL', 'UNKNOWN', 'FAILED', 'CANCELLED']
var COURIER_LIVE_STATUSES = ['ACCEPTED', 'ARRIVING', 'ARRIVED', 'DELIVERING']

// 退款单状态 → 顾客可见文案
var REFUND_STATUS_LABEL = {
  PENDING: '处理中',
  PROCESSING: '微信处理中',
  SUCCESS: '已原路退回',
  ABNORMAL: '处理中（银行侧异常，商家跟进中）',
  CLOSED: '未成功，商家将重新处理',
  FAILED: '未成功，商家将重新处理',
}

var AFTER_SALE_REASON_LABEL = { SHORTAGE: '少发/漏发', WRONG: '错发', DAMAGED: '变质/破损', OTHER: '其他' }
var AFTER_SALE_STATUS_LABEL = {
  PENDING: '待商家处理',
  APPROVED: '商家已同意，退款中',
  DONE: '已退款',
  REJECTED: '商家已拒绝',
}

// 时间一律按北京时间渲染（utils/time.js）。原来用 toLocaleString()：那按**运行设备**的
// 时区解读，开发者工具跑在别的时区的电脑上会显示错的时间，且不会报错。
function t(v) {
  return fmtDateTime(v)
}

// 商家拒单原因前缀（服务端 apps/server/src/routes/admin/orders.ts 拼的 cancelReason 格式，服务端不会改）：
// 「商家拒单：菜品售罄」「商家拒单：其他原因（说明）」。命中前缀才认为是拒单，其余取消原因原样展示。
var REJECT_REASON_PREFIX = '商家拒单：'
function rejectReasonText(cancelReason) {
  if (!cancelReason || cancelReason.indexOf(REJECT_REASON_PREFIX) !== 0) return ''
  return cancelReason.slice(REJECT_REASON_PREFIX.length)
}

// 退款事实这一行只认服务端权威字段（order.status / order.refundedAmount / 最新退款单状态），
// 不解析 cancelReason 文案——同一个 cancelReason 还被后台订单列表和退款订阅消息消费，
// 顾客端在这里画蛇添足地拼串会导致退款单状态变化时（PENDING→SUCCESS）文案不同步刷新。
// order.refundedAmount 是「已确认到账的累计值」（仅在退款单 SUCCESS 落库时才 increment，
// 见 apps/server/src/services/refund.ts:243），所以只有它 >0 时才敢说「已原路退回」。
function refundFactText(order) {
  if (order.status === 'REFUNDED' && order.refundedAmount > 0) {
    return { label: '款项 ¥' + formatPrice(order.refundedAmount) + ' 已原路退回', extra: '' }
  }
  var latest = order.refunds && order.refunds[0]
  var stuck = latest && (latest.status === 'ABNORMAL' || latest.status === 'CLOSED' || latest.status === 'FAILED')
  // 「钱什么时候回来」是顾客此刻最想知道的，所以处理中也必须给出预期，不能只说一句「处理中」就没了。
  // 异常态不写「退款失败」——顾客拿这四个字既没法自救也只会更慌；说清去找谁才有用。
  return stuck
    ? { label: '退款处理中', extra: '银行处理异常，如有疑问请联系商家' }
    : { label: '退款处理中', extra: '预计 1-3 个工作日原路退回' }
}

// 待付款倒计时文案：hh:mm:ss；到期返回 ''
function countdownText(expireAt) {
  if (!expireAt) return ''
  var left = Math.floor((new Date(expireAt).getTime() - Date.now()) / 1000)
  if (left <= 0) return ''
  var p = function(n) { return n < 10 ? '0' + n : '' + n }
  return p(Math.floor(left / 3600)) + ':' + p(Math.floor((left % 3600) / 60)) + ':' + p(left % 60)
}

// 支付截止时刻：HH:mm（横幅「请在 19:23 前完成支付」）。
// 同时被 :265 的顾客端「预计送达」复用，两处都必须是北京时间。
function deadlineText(expireAt) {
  return fmtHHmm(expireAt)
}

// 订单进度时间线：已达节点亮起并带时间，未达灰显
function buildTimeline(order) {
  var shipped = order.shipment && order.shipment.shippedAt
  var shipExtra = order.shipment && order.shipment.expressNo
    ? (order.shipment.expressCompany || '') + ' ' + order.shipment.expressNo
    : ''
  var steps = [{ label: '提交订单', time: t(order.createdAt), done: true }]

  if (order.status === 'CANCELLED') {
    if (order.paidAt) steps.push({ label: '支付成功', time: t(order.paidAt), done: true })
    var rejectReasonCancelled = rejectReasonText(order.cancelReason)
    // 未付款就被拒单：没收过钱，不欠顾客第二行「退款」事实——那是假话，见 refundFactText 的注释。
    steps.push({
      label: rejectReasonCancelled ? ('商家已拒单 · ' + rejectReasonCancelled) : '订单已取消',
      time: t(order.cancelledAt),
      done: true,
      extra: rejectReasonCancelled ? '' : (order.cancelReason || ''),
    })
    return steps
  }

  if (order.status === 'REFUNDING' || order.status === 'REFUNDED') {
    steps.push({ label: '支付成功', time: t(order.paidAt), done: !!order.paidAt })
    if (order.acceptedAt) steps.push({ label: '商家接单 · 备餐中', time: t(order.acceptedAt), done: true })
    if (shipped) steps.push({ label: '已发货', time: t(shipped), done: true, extra: shipExtra })
    if (order.completedAt) steps.push({ label: '已完成', time: t(order.completedAt), done: true })

    var rejectReason = rejectReasonText(order.cancelReason)
    // 顾客自助发起的取消/退款：cancelReason 固定以「用户」开头（见 apps/server/src/routes/orders.ts
    // 的「用户取消」「用户申请退款」）。用前缀匹配代替原来的 === '用户申请退款' 精确比较——
    // 精确比较只要文案措辞一改就会静默判错且没有任何报错。这仍是字符串猜测，真要根治
    // 得服务端加一个结构化字段（如 cancelledBy），本轮先在顾客端做得更稳健，见任务报告。
    var byCustomer = !rejectReason && !!order.cancelReason && order.cancelReason.indexOf('用户') === 0
    steps.push({
      label: rejectReason ? ('商家已拒单 · ' + rejectReason) : (byCustomer ? '申请退款' : '商家发起退款'),
      time: t(order.cancelledAt),
      done: true,
      extra: (rejectReason || byCustomer) ? '' : (order.cancelReason || ''),
    })
    // 第二行：退款事实，按退款单实时状态渲染（PENDING/PROCESSING「退款处理中」，SUCCESS 才「已原路退回」）。
    var refundDone = order.status === 'REFUNDED' && order.refundedAmount > 0
    var refundFact = refundFactText(order)
    steps.push({
      label: refundFact.label,
      time: refundDone ? t(order.refundedAt) : '',
      done: refundDone,
      extra: refundFact.extra,
    })
    return steps
  }

  steps.push({ label: '支付成功', time: t(order.paidAt), done: !!order.paidAt })
  // 直接发货未接单：跳过接单节点
  if (order.acceptedAt || !shipped) {
    steps.push({ label: '商家接单 · 备餐中', time: t(order.acceptedAt), done: !!order.acceptedAt })
  }
  steps.push({ label: '已发货', time: t(shipped), done: !!shipped, extra: shipExtra })
  steps.push({ label: '已完成', time: t(order.completedAt), done: !!order.completedAt })
  return steps
}

function buildLocalTimeline(order) {
  var delivery = order.delivery
  var deliveryStatus = delivery && delivery.status
  var riderAccepted = delivery && ['ACCEPTED', 'ARRIVING', 'ARRIVED', 'DELIVERING', 'DELIVERED'].indexOf(deliveryStatus) !== -1
  var riderAtStore = delivery && (delivery.pickedUpAt || ['ARRIVED', 'DELIVERING', 'DELIVERED'].indexOf(deliveryStatus) !== -1)
  var riderExtra = delivery && [delivery.courierName, delivery.courierCompany].filter(Boolean).join(' · ')
  var steps = [{ label: '提交订单', time: t(order.createdAt), done: true }]

  // 与邮寄订单相同的取消/退款事实表达，仅将物流节点的文案换成同城配送。
  if (order.status === 'CANCELLED') {
    if (order.paidAt) steps.push({ label: '支付成功', time: t(order.paidAt), done: true })
    var rejectReasonCancelled = rejectReasonText(order.cancelReason)
    steps.push({
      label: rejectReasonCancelled ? ('商家已拒单 · ' + rejectReasonCancelled) : '订单已取消',
      time: t(order.cancelledAt),
      done: true,
      extra: rejectReasonCancelled ? '' : (order.cancelReason || ''),
    })
    return steps
  }

  if (order.status === 'REFUNDING' || order.status === 'REFUNDED') {
    steps.push({ label: '支付成功', time: t(order.paidAt), done: !!order.paidAt })
    if (order.acceptedAt) steps.push({ label: '商家接单 · 备餐中', time: t(order.acceptedAt), done: true })
    if (order.status === 'SHIPPED' || (delivery && delivery.pickedUpAt)) {
      steps.push({ label: '配送中', time: t((delivery && delivery.pickedUpAt) || order.acceptedAt), done: true, extra: riderExtra })
    }
    if (order.completedAt) steps.push({ label: '已送达', time: t(order.completedAt), done: true })

    var rejectReason = rejectReasonText(order.cancelReason)
    var byCustomer = !rejectReason && !!order.cancelReason && order.cancelReason.indexOf('用户') === 0
    steps.push({
      label: rejectReason ? ('商家已拒单 · ' + rejectReason) : (byCustomer ? '申请退款' : '商家发起退款'),
      time: t(order.cancelledAt),
      done: true,
      extra: (rejectReason || byCustomer) ? '' : (order.cancelReason || ''),
    })
    var refundDone = order.status === 'REFUNDED' && order.refundedAmount > 0
    var refundFact = refundFactText(order)
    steps.push({
      label: refundFact.label,
      time: refundDone ? t(order.refundedAt) : '',
      done: refundDone,
      extra: refundFact.extra,
    })
    return steps
  }

  steps.push({ label: '支付成功', time: t(order.paidAt), done: !!order.paidAt })
  steps.push({ label: '商家接单 · 备餐中', time: t(order.acceptedAt), done: !!order.acceptedAt })
  steps.push({ label: '骑手已接单', time: '', done: !!riderAccepted, extra: riderAccepted ? riderExtra : '' })
  steps.push({ label: '骑手已到店', time: '', done: !!riderAtStore })
  steps.push({ label: '配送中', time: t(delivery && delivery.pickedUpAt), done: order.status === 'SHIPPED', extra: order.status === 'SHIPPED' ? riderExtra : '' })
  steps.push({ label: '已送达', time: t(order.completedAt), done: !!order.completedAt })
  return steps
}

// 自取单时间线：提交 → 支付 → 商家接单·备餐中 → 已备好·请来取餐 → 已取餐。
// 取消/退款事实那两行与同城完全同款。
function buildPickupTimeline(order) {
  var steps = [{ label: '提交订单', time: t(order.createdAt), done: true }]

  if (order.status === 'CANCELLED') {
    if (order.paidAt) steps.push({ label: '支付成功', time: t(order.paidAt), done: true })
    var rejectReasonCancelled = rejectReasonText(order.cancelReason)
    steps.push({
      label: rejectReasonCancelled ? ('商家已拒单 · ' + rejectReasonCancelled) : '订单已取消',
      time: t(order.cancelledAt),
      done: true,
      extra: rejectReasonCancelled ? '' : (order.cancelReason || ''),
    })
    return steps
  }

  if (order.status === 'REFUNDING' || order.status === 'REFUNDED') {
    steps.push({ label: '支付成功', time: t(order.paidAt), done: !!order.paidAt })
    if (order.acceptedAt) steps.push({ label: '商家接单 · 备餐中', time: t(order.acceptedAt), done: true })
    if (order.pickupReadyAt) steps.push({ label: '已备好 · 请来取餐', time: t(order.pickupReadyAt), done: true })
    if (order.completedAt) steps.push({ label: '已取餐', time: t(order.completedAt), done: true })
    var rejectReason = rejectReasonText(order.cancelReason)
    var byCustomer = !rejectReason && !!order.cancelReason && order.cancelReason.indexOf('用户') === 0
    steps.push({
      label: rejectReason ? ('商家已拒单 · ' + rejectReason) : (byCustomer ? '申请退款' : '商家发起退款'),
      time: t(order.cancelledAt),
      done: true,
      extra: (rejectReason || byCustomer) ? '' : (order.cancelReason || ''),
    })
    var refundDone = order.status === 'REFUNDED' && order.refundedAmount > 0
    var refundFact = refundFactText(order)
    steps.push({ label: refundFact.label, time: refundDone ? t(order.refundedAt) : '', done: refundDone, extra: refundFact.extra })
    return steps
  }

  steps.push({ label: '支付成功', time: t(order.paidAt), done: !!order.paidAt })
  steps.push({ label: '商家接单 · 备餐中', time: t(order.acceptedAt), done: !!order.acceptedAt })
  steps.push({ label: '已备好 · 请来取餐', time: t(order.pickupReadyAt), done: !!order.pickupReadyAt })
  steps.push({ label: '已取餐', time: t(order.completedAt), done: !!order.completedAt })
  return steps
}

// 自取单顶部那句话：顾客此刻最想知道「我现在该干嘛」
function pickupHintOf(order, canSelfCancel) {
  if (order.status === 'PAID') return canSelfCancel ? '商家接单前可直接取消' : '商家即将接单'
  if (order.status === 'PREPARING') return '备餐中，备好后会通知您'
  if (order.status === 'SHIPPED') return '已备好，凭手机尾号到店取餐'
  if (order.status === 'COMPLETED') return '已取餐，感谢惠顾'
  return ''
}


// 直线距离（km）。展示用：骑手→收货点，不参与计费。
function getStraightDistanceKm(fromLatE6, fromLngE6, toLatE6, toLngE6) {
  var rad = Math.PI / 180
  var earthRadiusKm = 6371
  var lat1 = fromLatE6 / 1e6 * rad
  var lat2 = toLatE6 / 1e6 * rad
  var deltaLat = lat2 - lat1
  var deltaLng = (toLngE6 - fromLngE6) / 1e6 * rad
  var a = Math.sin(deltaLat / 2) * Math.sin(deltaLat / 2)
  a += Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLng / 2) * Math.sin(deltaLng / 2)
  var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
  return earthRadiusKm * c
}

// 骑手距收货点直线距离文案；坐标缺失则返回 ''（整行隐藏）。纯展示，不影响配送费。
function courierDistanceText(courierLoc, order) {
  if (!courierLoc || !order) return ''
  if (courierLoc.latE6 == null || courierLoc.lngE6 == null) return ''
  if (order.receiverLatE6 == null || order.receiverLngE6 == null) return ''
  return getStraightDistanceKm(
    courierLoc.latE6, courierLoc.lngE6,
    order.receiverLatE6, order.receiverLngE6
  ).toFixed(1)
}

function decorateOrder(order) {
  var refunds = (order.refunds || []).map(function(r) {
    return Object.assign({}, r, {
      amountText: formatPrice(r.amount),
      statusLabel: REFUND_STATUS_LABEL[r.status] || r.status,
      timeText: t(r.successTime || r.createdAt),
    })
  })
  var afterSale = order.afterSale
    ? Object.assign({}, order.afterSale, {
        reasonLabel: AFTER_SALE_REASON_LABEL[order.afterSale.reason] || order.afterSale.reason,
        statusLabel: AFTER_SALE_STATUS_LABEL[order.afterSale.status] || order.afterSale.status,
        timeText: t(order.afterSale.createdAt),
      })
    : null
  var isLocal = order.deliveryType === 'LOCAL'
  var isExpress = order.deliveryType === 'EXPRESS'
  var isPickup = order.deliveryType === 'PICKUP'
  // 服务端从 2026-09-11 起下发 canSelfCancel（自取按「开始备餐时刻」判）；老服务端没有就按旧规则算
  var selfCancel = typeof order.canSelfCancel === 'boolean'
    ? order.canSelfCancel
    : (order.status === 'PENDING_PAYMENT' || (order.status === 'PAID' && !order.acceptedAt))
  var expressStageText = expressTrackUtil.expressStageText(order)
  var expressTrack = isExpress ? expressTrackUtil.buildExpressTrack(order.track) : []

  var delivery = order.delivery
  var deliveryStatus = delivery && delivery.status
  var isDeliveryNeutral = !!deliveryStatus && DELIVERY_NEUTRAL.indexOf(deliveryStatus) !== -1
  return Object.assign({}, order, {
    statusLabel: (isPickup ? PICKUP_STATUS_LABEL : STATUS_LABEL)[order.status] || order.status,
    isLocal: isLocal,
    isExpress: isExpress,
    isPickup: isPickup,
    phoneTail: (order.receiverPhone || '').slice(-4),
    pickupSlotLabel: order.pickup ? (order.pickup.slotLabel || '') : '',
    pickupStore: order.pickup ? order.pickup.store : null,
    pickupDiscountAmountText: formatPrice(order.pickupDiscountAmount || 0),
    expressStageText: expressStageText,
    showExpressStage: !!expressStageText,
    expressTrack: expressTrack,
    showExpressTrack: expressTrack.length > 0,
    deliveryStatusLabel: deliveryStatus ? (DELIVERY_CUSTOMER_LABEL[deliveryStatus] || deliveryStatus) : '',
    deliveryNeutralHint: isDeliveryNeutral ? '如超过预计时间请联系商家' : '',
    showCourierCard: !!delivery && COURIER_LIVE_STATUSES.indexOf(deliveryStatus) !== -1,
    distanceText: order.distanceM == null ? '' : (order.distanceM / 1000).toFixed(1),
    // 预计送达分三段说，越往后越确定（PO 2026-09-07）：
    //  ① 还没接单：不给钟点——备餐从接单才开始计时，此刻任何钟点都是替商家打包票；
    //  ② 已接单、骑手还没取货：给接单时算好的钟点，但标「预计」；
    //  ③ 骑手已取货：这才是真正的预计送达（剩下的只有路上那一段，最确定）。
    // estimatedDeliveryAt 现在是**接单时**才落库的，所以 ① 里它本来就是空的。
    estimatedDeliveryText: isLocal && order.estimatedDeliveryAt ? deadlineText(order.estimatedDeliveryAt) : '',
    estimatedDeliveryHint: !isLocal ? '' : (
      !order.acceptedAt ? '商家接单后显示'
        : (delivery && delivery.pickedUpAt ? '' : '骑手取货后更准')
    ),
    cancelDeadlineText: deadlineText(order.cancelRequestDeadline),
    // 申请被驳回过（人工或超时自动）。顾客上一次看到的是「已提交，商家会尽快处理」，
    // 不给个结论他会一直等——而驳回把 cancelRequestedAt 清空了，只能靠这条痕迹。
    showLocalCancelRejected: (isLocal || isExpress || isPickup) && !order.cancelRequestedAt && !!order.cancelRequestRejectedAt
      && (isPickup ? ['PAID', 'PREPARING', 'SHIPPED'] : ['PAID', 'PREPARING']).indexOf(order.status) !== -1,
    showLocalCancelUnavailable:
      ((isLocal || isExpress) && order.status === 'PREPARING' && !order.cancelRequestedAt && !order.cancelRequestRejectedAt && order.canRequestCancel !== true)
      || (isPickup && ['PAID', 'PREPARING'].indexOf(order.status) !== -1 && !order.cancelRequestedAt && !order.cancelRequestRejectedAt && order.canRequestCancel !== true && !selfCancel),
    // 服务端从 2026-09-11 起下发 canSelfCancel（自取按「开始备餐时刻」判）；老服务端没有就按旧规则算
    canSelfCancel: selfCancel,
    totalAmountText: formatPrice(order.totalAmount),
    shippingFeeText: formatPrice(order.shippingFee),
    actualAmountText: formatPrice(order.actualAmount),
    refundedAmountText: formatPrice(order.refundedAmount || 0),
    discountAmountText: formatPrice(order.discountAmount || 0),
    // 退款不退回券与积分：只在「真的退过款」且「本单真的用过券或积分」时才出现。
    // 措辞与 docs/member-terms-copy.md 的「订单退款后，本单使用的优惠券不予退回」同口径，
    // 提前讲清楚比事后解释便宜（spec §10 的顾客投诉对策）。
    benefitNotRefundedNote:
      (order.refundedAmount || 0) > 0 && ((order.discountAmount || 0) > 0 || (order.pointsUsed || 0) > 0)
        ? '退款不退回优惠券与积分'
        : '',
    // 得分只在订单完成后才是既成事实；pointsEarned 为 0 的小额单不解释，免得白占一行。
    pointsEarnedText:
      order.status === 'COMPLETED' && (order.pointsEarned || 0) > 0
        ? '本单获得 ' + order.pointsEarned + ' 积分'
        : '',
    payDeadlineText: order.status === 'PENDING_PAYMENT' ? deadlineText(order.payExpireAt) : '',
    createdAtText: t(order.createdAt),
    paidAtText: order.paidAt ? t(order.paidAt) : null,
    timeline: isPickup ? buildPickupTimeline(order) : isLocal ? buildLocalTimeline(order) : buildTimeline(order),
    refunds: refunds,
    afterSale: afterSale,
    // 提示文案与按钮必须看同一个判定，否则会出现「按钮能点、文案说不能」
    pickupHint: isPickup ? pickupHintOf(order, selfCancel) : '',
    items: order.items.map(function(item) {
      // 赠品行的 productPrice / subtotal 服务端恒为 0（积分不进商品行金额）。
      // 照直渲染成 ¥0.00 会被顾客当成 0 元 bug 来投诉，所以价格换成积分价、小计留「—」。
      var isGift = !!item.isGift
      return Object.assign({}, item, {
        isGift: isGift,
        priceLineText: isGift
          ? '积分 ' + (item.pointsCost || 0) + ' × ' + item.quantity
          : '¥' + formatPrice(item.productPrice) + ' × ' + item.quantity,
        subtotalLineText: isGift ? '—' : '¥' + formatPrice(item.subtotal),
      })
    }),
  })
}

Page({
  data: {
    order: null,
    loading: true,
    countdown: '',
    courierLoc: null,
    courierDistanceText: '',
    // 骑手取货后由实时位置算出的送达钟点（第三段）。空串 = 还没到那一步，页面显示大概值
    liveEtaText: '',
    storeLoc: null,
    graceMin: '',
  },

  onLoad(options) {
    var id = options.id
    if (!id) {
      wx.showToast({ title: '订单不存在', icon: 'none' })
      setTimeout(function() { wx.navigateBack() }, 1500)
      return
    }
    this._orderId = id
    // 从确认页跳来：自动拉起支付（订阅消息已在确认页点击时请求过）
    this._autopay = options.autopay === '1'
    this.loadOrder(id)
  },

  onShow() {
    this._pageShown = true
    // 从售后申请页返回时刷新
    if (this._orderId && !this.data.loading && this._needRefresh) {
      this._needRefresh = false
      this.loadOrder(this._orderId, true)
    }
    this.startTicker()
    this.startCourierPoll()
  },

  onHide() {
    this._pageShown = false
    this.stopTicker()
    this.stopCourierPoll()
  },

  onUnload() {
    this._pageShown = false
    this.stopTicker()
    this.stopCourierPoll()
  },

  onPullDownRefresh() {
    this.loadOrder(this._orderId, true)
  },

  loadOrder(id, silent) {
    var self = this
    if (!silent) wx.showLoading({ title: '加载中...' })
    getOrderDetail(id)
      .then(function(order) {
        if (!silent) wx.hideLoading()
        wx.stopPullDownRefresh()
        self.setData({
          order: decorateOrder(order),
          loading: false,
          countdown: order.status === 'PENDING_PAYMENT' ? countdownText(order.payExpireAt) : '',
          courierLoc: null,
          courierDistanceText: '',
          liveEtaText: '',
          graceMin: order.cancelGraceMin || 0,
        })
        if (order.deliveryType === 'LOCAL') self.loadStoreLoc()
        if (self._pageShown) self.startCourierPoll()
        if (self._autopay) {
          self._autopay = false
          if (order.status === 'PENDING_PAYMENT') self.startPay()
        }
      })
      .catch(function() {
        if (!silent) wx.hideLoading()
        wx.stopPullDownRefresh()
        if (!self.data.order) {
          self.setData({ loading: false })
          setTimeout(function() { wx.navigateBack() }, 1500)
        }
      })
  },

  // 待付款倒计时；到期后刷新（服务端已自动取消）
  startTicker() {
    var self = this
    this.stopTicker()
    this._ticker = setInterval(function() {
      var order = self.data.order
      if (!order || order.status !== 'PENDING_PAYMENT') return
      var text = countdownText(order.payExpireAt)
      if (text !== self.data.countdown) self.setData({ countdown: text })
      if (!text) {
        self.stopTicker()
        setTimeout(function() { self.loadOrder(self._orderId, true) }, 1500)
      }
    }, 1000)
  },

  stopTicker() {
    if (this._ticker) {
      clearInterval(this._ticker)
      this._ticker = null
    }
  },

  // 门店坐标只在同城订单详情首次需要时取一次；静态示意图不使用原生 map。
  loadStoreLoc() {
    var self = this
    if (this._storeLocLoaded || this._storeLocLoading) return
    this._storeLocLoading = true
    getLocalMeta()
      .then(function(meta) {
        self._storeLoc = meta && meta.store ? meta.store : null
        self.setData({ storeLoc: self._storeLoc })
      })
      .catch(function() {})
      .then(function() {
        self._storeLocLoading = false
        self._storeLocLoaded = true
      })
  },

  startCourierPoll() {
    var self = this
    this.stopCourierPoll()
    if (!this.data.order || this.data.order.deliveryType !== 'LOCAL') return
    var d = this.data.order.delivery
    if (!d || COURIER_LIVE_STATUSES.indexOf(d.status) === -1) return
    var tick = function() {
      getCourierLocation(self._orderId)
        .then(function(r) {
          // location 为 null 是正常情况：整块位置示意图随之隐藏。
          // courierDistanceText 为展示用直线距离，不参与计费。
          var loc = r.location || null
          // 第三段（PO 2026-09-07）：骑手取货之后，服务端用**骑手实时位置**算出的
          // 剩余分钟数才是「真正的预计送达」——取货前给的都是「备餐 + 距离÷均速」的大概。
          // 服务端只在 DELIVERING 时给 etaMinutes，所以这里不用再判状态。
          self.setData({
            courierLoc: loc,
            courierDistanceText: courierDistanceText(loc, self.data.order),
            liveEtaText: typeof r.etaMinutes === 'number' ? timeUtil.fmtAfterMinutes(r.etaMinutes) : '',
          })
        })
        .catch(function() {})
      getOrderDetail(self._orderId)
        .then(function(order) {
          var decorated = decorateOrder(order)
          self.setData({
            order: decorated,
            countdown: order.status === 'PENDING_PAYMENT' ? countdownText(order.payExpireAt) : '',
            courierDistanceText: courierDistanceText(self.data.courierLoc, decorated),
          })
          var delivery = order.delivery
          if (!delivery || COURIER_LIVE_STATUSES.indexOf(delivery.status) === -1) self.stopCourierPoll()
        })
        .catch(function() {})
    }
    tick()
    this._courierTimer = setInterval(tick, 30 * 1000)
  },

  stopCourierPoll() {
    if (this._courierTimer) {
      clearInterval(this._courierTimer)
      this._courierTimer = null
    }
  },

  // 点击「去支付」：先在点击手势内请求订阅消息（发货/退款通知），再发起支付
  onPay() {
    var self = this
    requestSubscribe(this.data.order.subscribeTemplateIds, function() {
      self.startPay()
    })
  },

  startPay() {
    var self = this
    if (this._paying) return
    this._paying = true
    wx.showLoading({ title: '支付中...' })
    payOrder(this.data.order.id)
      .then(function(data) {
        wx.hideLoading()
        if (data.mode === 'mock') {
          self._paying = false
          wx.showToast({ title: '支付成功，正在确认…', icon: 'none', duration: 1500 })
          self.pollPaidStatus()
          return
        }
        wx.requestPayment({
          timeStamp: data.timeStamp,
          nonceStr: data.nonceStr,
          package: data.package,
          signType: data.signType,
          paySign: data.paySign,
          success: function() {
            // PAID 状态由后端支付回调异步写入，轮询等待
            wx.showToast({ title: '支付成功，正在确认…', icon: 'none', duration: 1500 })
            self.pollPaidStatus()
          },
          fail: function(err) {
            if (err.errMsg && err.errMsg.indexOf('cancel') !== -1) {
              wx.showToast({ title: '已取消支付，可稍后在订单中继续支付', icon: 'none', duration: 2000 })
            } else {
              wx.showToast({ title: '支付失败，请重试', icon: 'none' })
            }
          },
          complete: function() {
            self._paying = false
          },
        })
      })
      .catch(function() {
        self._paying = false
        wx.hideLoading()
        // 订单已超时等业务错误 request 已 toast；刷新以显示最新状态
        self.loadOrder(self._orderId, true)
      })
  },

  // 支付后轮询订单状态：1.5s 间隔，最多 12 次，单次失败不中断
  pollPaidStatus() {
    var self = this
    var attempts = 0
    var maxAttempts = 12

    function check() {
      attempts++
      getOrderDetail(self._orderId)
        .then(function(order) {
          if (order.status !== 'PENDING_PAYMENT') {
            self.loadOrder(self._orderId, true)
          } else if (attempts < maxAttempts) {
            setTimeout(check, 1500)
          } else {
            wx.showToast({ title: '支付结果确认中，请稍后下拉刷新', icon: 'none', duration: 2500 })
            self.loadOrder(self._orderId, true)
          }
        })
        .catch(function() {
          if (attempts < maxAttempts) setTimeout(check, 1500)
          else self.loadOrder(self._orderId, true)
        })
    }

    setTimeout(check, 1500)
  },

  onCancelOrder() {
    var self = this
    var isPaid = this.data.order.status !== 'PENDING_PAYMENT'
    var isPickup = !!this.data.order.isPickup
    wx.showModal({
      title: isPaid ? (isPickup ? '取消订单' : '申请退款') : '取消订单',
      content: !isPaid
        ? '确认取消该订单？取消后需重新下单。'
        : this.data.order.isPickup
          ? '取消后货款会立即原路退回微信，一般几分钟内到账。确认取消？'
          : '商家尚未接单，取消后货款会立即原路退回微信，一般几分钟内到账。确认退款？',
      confirmText: '确认',
      success: function(res) {
        if (!res.confirm) return
        cancelOrder(self.data.order.id)
          .then(function(data) {
            var title = !isPaid ? '订单已取消' : (data && data.autoRefunded ? '已退款，请留意微信到账通知' : '已申请退款，商家将尽快处理')
            wx.showToast({ title: title, icon: 'none', duration: 2000 })
            self.loadOrder(self._orderId, true)
          })
          .catch(function() {
            self.loadOrder(self._orderId, true)
          })
      },
    })
  },

  onRequestCancel() {
    if (this._requestCanceling) return
    var self = this
    wx.showModal({
      title: '申请取消',
      content: this.data.order.isPickup ? '商家确认后将全额退款。确认提交取消申请？' : '商家确认后将全额退款，含配送费。确认提交取消申请？',
      confirmText: '提交申请',
      success: function(res) {
        if (!res.confirm) return
        if (self._requestCanceling) return
        self._requestCanceling = true
        requestCancelOrder(self.data.order.id)
          .then(function() {
            self._requestCanceling = false
            wx.showToast({ title: '取消申请已提交', icon: 'none', duration: 2000 })
            self.loadOrder(self._orderId, true)
          })
          .catch(function(err) {
            self._requestCanceling = false
            // requestCancelOrder 为 silent:true，页面需自行提示非 42229 失败
            if (err && err.code === 42229) {
              wx.showToast({ title: err.message, icon: 'none', duration: 2000 })
            } else {
              wx.showToast({ title: (err && err.message) || '申请失败，请重试', icon: 'none', duration: 2000 })
            }
            self.loadOrder(self._orderId, true)
          })
      },
    })
  },

  onContactCourier() {
    var delivery = this.data.order && this.data.order.delivery
    if (delivery && delivery.courierMobile) wx.makePhoneCall({ phoneNumber: delivery.courierMobile })
  },

  onContactShop() {
    callShop()
  },

  onOpenStore() {
    var s = this.data.order && this.data.order.pickupStore
    if (!s || s.latE6 == null || s.lngE6 == null) return
    wx.openLocation({ latitude: s.latE6 / 1e6, longitude: s.lngE6 / 1e6, name: s.name || '门店', address: s.address || '' })
  },

  onApplyAfterSale() {
    this._needRefresh = true
    wx.navigateTo({ url: '/pages/order/after-sale?id=' + this.data.order.id })
  },

  onPreviewImage(e) {
    var urls = (this.data.order.afterSale && this.data.order.afterSale.images) || []
    wx.previewImage({ current: e.currentTarget.dataset.url, urls: urls })
  },

  onConfirmReceipt() {
    var self = this
    wx.showModal({
      title: '确认收货',
      content: '确认已收到商品？确认后如有问题仍可申请售后。',
      confirmText: '确认',
      success: function(modalRes) {
        if (!modalRes.confirm) return
        wx.showLoading({ title: '处理中...' })
        confirmOrder(self.data.order.id)
          .then(function() {
            wx.hideLoading()
            wx.showToast({ title: '已确认收货', icon: 'success', duration: 1500 })
            self.loadOrder(self._orderId, true)
          })
          .catch(function() {
            wx.hideLoading()
          })
      },
    })
  },
})
