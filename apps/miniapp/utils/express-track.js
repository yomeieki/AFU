// 邮寄订单详情的「物流信息」阶段文案与轨迹条目整理。纯函数、无 wx 依赖，
// tests/miniapp/express-track.test.cjs 直接 require。ES5：scripts/check-miniapp-es5.mjs 闸门。
//
// 阶段文案（spec §4.2）：
//   PAID/PREPARING 无活跃预约 → 商家备货中；BOOKED/UNKNOWN → 已预约…；ACCEPTED → 快递员已接单…；
//   PICKED/DELIVERED（未发货前）→ 已取件…；SHIPPED → ''（让位给 Shipment 卡）；COMPLETED 且预约到过取件 → 已签收…
function expressStageText(order) {
  if (!order || order.deliveryType !== 'EXPRESS') return ''
  var st = order.status
  if (['PAID', 'PREPARING', 'SHIPPED', 'COMPLETED'].indexOf(st) === -1) return ''
  var eb = order.expressBooking
  var ebs = eb ? eb.status : ''
  var tail = eb ? (eb.courierLabel || '') + (eb.kuaidinum ? ' ' + eb.kuaidinum : '') : ''
  if (st === 'COMPLETED') {
    // 只有预约真的走到取件/签收才说「已签收」；老邮寄单（手填单号）没有预约，照旧不显示这张卡
    return ebs === 'DELIVERED' || ebs === 'PICKED' ? '已签收 · ' + tail : ''
  }
  if (st === 'SHIPPED') return ''
  if (ebs === 'BOOKED' || ebs === 'UNKNOWN') return '已预约快递员上门取件' + (eb.slotText ? ' · ' + eb.slotText : '')
  if (ebs === 'ACCEPTED') return '快递员已接单' + (eb.courierName ? ' · ' + eb.courierName : '') + (eb.slotText ? ' · ' + eb.slotText : '')
  if (ebs === 'PICKED' || ebs === 'DELIVERED') return '已取件 · ' + tail
  // 无预约 / 已取消 / 下单中（PENDING）/ 未识别状态：对顾客一律「商家备货中」
  return '商家备货中'
}

// 服务端 track.items 已是最新在上；这里只做容错（缺 context 的条目剔除、ftime 非字符串留空），不排序
function buildExpressTrack(track) {
  var out = []
  if (!track || !track.items || !track.items.length || typeof track.items.length !== 'number') return out
  for (var i = 0; i < track.items.length; i++) {
    var it = track.items[i]
    if (!it || typeof it.context !== 'string' || !it.context) continue
    out.push({ context: it.context, timeText: typeof it.ftime === 'string' ? it.ftime : '' })
  }
  return out
}

module.exports = { expressStageText: expressStageText, buildExpressTrack: buildExpressTrack }
