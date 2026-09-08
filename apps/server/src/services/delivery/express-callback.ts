/**
 * 快递100 上门取件回调处理。回调是预约状态的唯一事实来源（对账任务只在 UNKNOWN 时补位）。
 * 顺序：查单 → 验签 → 去重留痕 → UNKNOWN 认领 → 按映射推进（rank 只前进；终态后忽略）→ 订单联动 → 事务外通知。
 */
import { ExpressBooking, Prisma } from '@prisma/client'
import prisma from '../../utils/prisma'
import { getExpressProvider, ExpressCallbackPayload } from './kd100-express'
import { KD_EXPRESS_STATUS_MAP, BOOKING_RANK, BOOKING_TERMINAL, canTransition } from './express-booking-state'
import { recordBookingEvent, makeExpressDedupeKey, truncStr } from './express-events'
import { notifySystemAlert } from '../notify'
import { notifyExpressAlert } from '../order-notify'
import { sendShipSubscribeMessage } from '../subscribe-message'
import { COURIER_LABEL, getExpressSettings } from '../express-settings'

type Tx = Prisma.TransactionClient

export async function handleExpressCallback(bookingNo: string, body: Record<string, string>): Promise<{ http: 200 | 500 }> {
  const rawBody = JSON.stringify(body)
  const booking = await prisma.expressBooking.findUnique({ where: { bookingNo }, include: { order: { include: { user: { select: { openid: true } }, items: { select: { productName: true }, take: 1, orderBy: { id: 'asc' } } } } } })
  if (!booking) {
    notifySystemAlert('快递100 取件回调查不到预约', [`bookingNo=${bookingNo}`], { key: 'kd-express:unknown-booking' })
    return { http: 200 }
  }
  const parsed = getExpressProvider().verifyAndParseCallback(body, booking.callbackSalt)
  if (!parsed.ok) {
    try { await recordBookingEvent(prisma, { bookingId: booking.id, dedupeKey: makeExpressDedupeKey(bookingNo, 'BAD', rawBody), source: 'CALLBACK', statusDesc: parsed.reason === 'SIGN_MISMATCH' ? '回调验签失败' : '回调格式异常' }) } catch { /* 留痕失败不升级 */ }
    // key 用固定值不带 bookingNo：bookingNo 是可猜的（E+订单序号+序），按它分 key 等于让攻击者
    // 靠枚举 bookingNo 把这条告警的去重刷穿——同 :21「查不到预约」的固定 key 一个道理。
    notifySystemAlert('快递100 取件回调验签失败', [`bookingNo=${bookingNo}`], { key: 'kd-express:sign-fail' })
    return { http: 200 }
  }
  const p = parsed.payload
  const after: (() => void)[] = []
  // 交互式事务里每多一次 await 就多占一份连接时间；getExpressSettings 不依赖事务内任何状态，
  // 挪到事务外面读一次，事务体里传值用，别在 $transaction 内部再等一次网络/缓存往返。
  const { costAlertRatio } = await getExpressSettings()
  try {
    await prisma.$transaction(async (tx) => {
      const ev = await recordBookingEvent(tx, { bookingId: booking.id, dedupeKey: makeExpressDedupeKey(bookingNo, p.status, rawBody), source: 'CALLBACK', providerStatus: /^\d+$/.test(p.status) ? Number(p.status) : null, statusDesc: p.statusDesc, courierName: p.courierName, courierMobile: p.courierMobile, rawPayload: p.raw as Prisma.InputJsonValue })
      if (ev.duplicate) return
      await tx.expressBooking.update({ where: { id: booking.id }, data: { lastCallbackAt: new Date() } })
      await applyProviderStatus(tx, booking, p, after, costAlertRatio)
    })
  } catch (e) {
    console.error('[kd-express-callback] 处理失败:', e)
    return { http: 500 }
  }
  for (const f of after) { try { f() } catch (e) { console.error('[kd-express-callback] after 失败:', e) } }
  return { http: 200 }
}

/** 把一条快递100 状态套到预约上。对账任务复用（source 不同）。after 收集事务外通知。 */
export async function applyProviderStatus(tx: Tx, booking: ExpressBooking & { order: { orderNo: string; user: { openid: string }; items: { productName: string }[] } }, p: ExpressCallbackPayload, after: (() => void)[], costAlertRatio: number): Promise<void> {
  const mapped = KD_EXPRESS_STATUS_MAP[p.status]
  const label = COURIER_LABEL[booking.kuaidicom] ?? booking.kuaidicom
  const providerStatus = /^\d+$/.test(p.status) ? Number(p.status) : null
  const identity = {
    ...(p.taskId && !booking.taskId ? { taskId: p.taskId } : {}),
    ...(p.kdOrderId && !booking.kdOrderId ? { kdOrderId: p.kdOrderId } : {}),
    ...(p.kuaidinum ? { kuaidinum: p.kuaidinum } : {}),
    ...(p.courierName ? { courierName: p.courierName } : {}),
    ...(p.courierMobile ? { courierMobile: p.courierMobile } : {}),
    ...(p.statusDesc ? { statusDesc: truncStr(p.statusDesc, 255) } : {}),
    ...(providerStatus !== null ? { providerStatus } : {}),
  }
  // UNKNOWN 认领：任何一条能验签的回调都证明单在快递100 那头存在。
  // booking 是参数，reassign 会被 lint 挡（no-param-reassign），改用局部变量 current 承接后续状态。
  let current = booking
  if (current.status === 'UNKNOWN') {
    await tx.expressBooking.updateMany({ where: { id: current.id, status: 'UNKNOWN' }, data: { status: 'BOOKED', statusRank: BOOKING_RANK.BOOKED, bookedAt: new Date(), errorCode: null, failReason: null, ...identity } })
    current = { ...current, status: 'BOOKED', statusRank: BOOKING_RANK.BOOKED }
  }
  // FEE/终态/ALERT/IGNORE 这几条分支都只落 identity（不推进状态）；有内容才写一次，避免空 update
  const persistIdentity = async () => { if (Object.keys(identity).length) await tx.expressBooking.update({ where: { id: current.id }, data: identity }) }
  if ((BOOKING_TERMINAL as readonly string[]).includes(current.status)) {
    // 终态后的尾随回调：只留痕（事件已写）；FEE 例外——结算可能晚于签收。
    // 终态之后不再报「未知状态码」——那条提醒是给「这个状态我们不认识，可能要补映射」用的，
    // 终态预约已经没人会再看它的状态推进，报了也没人处理，白占一次去重告警配额。
    if (mapped && mapped.type === 'side' && mapped.kind === 'FEE') await applyFee(tx, current, p, after, costAlertRatio)
    // VOID 是店员手动核实「快递100 无单」后才打的标记；如果作废之后还收到验签通过的进度/取消/失败回调，
    // 说明快递100 那头这单其实真实存在——大概率是判错了，店员可能已经重新下了一单，变成双单。
    // 只报警不改状态：状态改动只能靠人工核实，不能靠这一条回调反悔。
    if (current.status === 'VOID' && mapped && (mapped.type === 'rank' || mapped.kind === 'CANCELLED' || mapped.kind === 'FAILED')) {
      after.push(() => notifyExpressAlert('作废的预约仍在推状态：快递100 那边可能真有单，勿重复预约/核对是否已有两张单', [`订单 ${current.orderNo} · bookingNo ${current.bookingNo}`, `回调状态 ${p.status}${p.statusDesc ? `（${p.statusDesc}）` : ''}`], { key: `express-void-alive:${current.id}` }))
    }
    await persistIdentity()
    return
  }
  if (!mapped) {
    await tx.expressBooking.update({ where: { id: current.id }, data: identity })
    after.push(() => notifySystemAlert('快递100 取件回调未知状态', [`bookingNo=${current.bookingNo} status=${p.status}`, p.statusDesc ?? ''], { key: `kd-express-unknown:${p.status}` }))
    return
  }
  // 单号一到就同步到 Shipment（不写 shippedAt）；只对「当前活跃预约」写，防止已被取消/超越的预约的尾随回调
  // 覆盖同一 orderId 下最新预约的 Shipment（Shipment 以 orderId 为键，不是以 bookingId）
  if (p.kuaidinum && p.kuaidinum !== current.kuaidinum && current.activeOrderId === current.orderId) {
    await tx.shipment.upsert({ where: { orderId: current.orderId }, update: { expressCompany: label, expressNo: p.kuaidinum }, create: { orderId: current.orderId, orderNo: current.orderNo, deliveryType: 'EXPRESS', expressCompany: label, expressNo: p.kuaidinum } })
  }
  // 状态 0（建单成功）的预扣要落库，即便这条回调因为重复推送/并发而没能推进 rank
  // （canTransition('BOOKED','BOOKED') 恒 false，rank 分支自身不会走到下面的 applyFee）
  if (mapped.type === 'rank' && mapped.status === 'BOOKED') await applyFee(tx, current, p, after, costAlertRatio)
  if (mapped.type === 'rank') {
    if (!canTransition(current.status, mapped.status)) { await tx.expressBooking.update({ where: { id: current.id }, data: identity }); return }
    const stamp = mapped.stamp ? { [mapped.stamp]: new Date() } : {}
    const r = await tx.expressBooking.updateMany({ where: { id: current.id, statusRank: { lt: mapped.rank } }, data: { status: mapped.status, statusRank: mapped.rank, ...stamp, ...identity, ...(mapped.status === 'DELIVERED' ? { activeOrderId: null } : {}) } })
    if (r.count === 0) return
    if (mapped.status === 'PICKED') {
      const kuaidinum = p.kuaidinum ?? current.kuaidinum
      await tx.order.updateMany({ where: { id: current.orderId, status: { in: ['PAID', 'PREPARING'] } }, data: { status: 'SHIPPED' } })
      const shipment = await tx.shipment.upsert({ where: { orderId: current.orderId }, update: { expressCompany: label, ...(kuaidinum ? { expressNo: kuaidinum } : {}), shippedAt: new Date() }, create: { orderId: current.orderId, orderNo: current.orderNo, deliveryType: 'EXPRESS', expressCompany: label, expressNo: kuaidinum, shippedAt: new Date() } })
      const o = current.order
      after.push(() => sendShipSubscribeMessage(o.user.openid, { id: current.orderId, orderNo: current.orderNo }, shipment, o.items[0]?.productName))
    } else if (mapped.status === 'DELIVERED') {
      await tx.order.updateMany({ where: { id: current.orderId, status: 'SHIPPED' }, data: { status: 'COMPLETED', completedAt: new Date() } })
    }
    return
  }
  switch (mapped.kind) {
    case 'FAILED': {
      const r = await tx.expressBooking.updateMany({ where: { id: current.id, status: { in: ['PENDING', 'UNKNOWN', 'BOOKED', 'ACCEPTED'] } }, data: { status: 'FAILED', activeOrderId: null, failReason: truncStr(p.statusDesc ?? mapped.label, 255), ...identity } })
      if (r.count > 0) after.push(() => notifExpressFailed(current.orderNo, label, `${mapped.label}${p.statusDesc ? `：${p.statusDesc}` : ''}`, current.id))
      return
    }
    case 'CANCELLED': {
      const r = await tx.expressBooking.updateMany({ where: { id: current.id, status: { in: ['PENDING', 'UNKNOWN', 'BOOKED', 'ACCEPTED'] } }, data: { status: 'CANCELLED', activeOrderId: null, cancelledAt: new Date(), cancelledBy: 'KD100', cancelReason: truncStr(p.statusDesc ?? mapped.label, 255), ...identity } })
      if (r.count > 0) after.push(() => notifyExpressAlert('快递100 取消了取件预约', [`订单 ${current.orderNo} · ${label}`, p.statusDesc ?? mapped.label, '订单已回到备货中，请重新预约或改填单号发货'], { key: `express-cancel:${current.id}` }))
      return
    }
    case 'FEE': await applyFee(tx, current, p, after, costAlertRatio); await persistIdentity(); return
    case 'ALERT':
      await persistIdentity()
      after.push(() => notifyExpressAlert(`快递100 推送「${mapped.label}」`, [`订单 ${current.orderNo} · ${label}`, p.statusDesc ?? '', '请到快递100 后台或联系快递员核实'], { key: `express-alert:${current.id}:${p.status}` }))
      return
    case 'IGNORE':
      await persistIdentity()
      return
  }
}
function notifExpressFailed(orderNo: string, label: string, why: string, id: number) {
  notifyExpressAlert('取件预约失败', [`订单 ${orderNo} · ${label}`, why, '订单已回到备货中：换一家重约，或改填单号发货'], { key: `express-fail:${id}` })
}
async function applyFee(tx: Tx, booking: ExpressBooking, p: ExpressCallbackPayload, after: (() => void)[], costAlertRatio: number) {
  const isPrepaid = p.status === '0'
  if (isPrepaid) {
    // 状态 0 只记预扣（freight 优先，其次 defPrice），且只写第一次；实扣列与成本告警留给 15/155
    const prepaid = p.freightFen ?? p.defPriceFen
    if (booking.prepaidFeeFen === null && prepaid !== null) {
      await tx.expressBooking.updateMany({ where: { id: booking.id, prepaidFeeFen: null }, data: { prepaidFeeFen: prepaid } })
    }
    return
  }
  // freight/weight 都没有就没有费用列可写，但 15 的 synPay 推送不受这条影响——见下面单独的 if
  if (!(p.freightFen === null && p.weightKg === null)) {
    const data: Prisma.ExpressBookingUpdateInput = {}
    if (p.freightFen !== null) data.settledFeeFen = p.freightFen
    if (p.weightKg !== null) data.billedWeightG = Math.round(p.weightKg * 1000)
    if (p.feeDetails != null) data.feeDetails = p.feeDetails as Prisma.InputJsonValue
    await tx.expressBooking.update({ where: { id: booking.id }, data })
  }
  if (p.status === '15') {
    // booking 是事务开始前查到的快照；这条回调自己带的 kdOrderId（identity 里那份）要到本次
    // applyProviderStatus 结束时才落库，booking.kdOrderId 这时候还是旧值——所以两边都要看一眼。
    const kdOrderId = booking.kdOrderId ?? p.kdOrderId
    if (kdOrderId) {
      after.push(() => { void getExpressProvider().synPay({ kdOrderId }).catch((e) => console.warn('[kd-express] synPay 失败:', (e as Error).message)) })
    } else {
      after.push(() => notifyExpressAlert('快递100 已结算但查不到 kdOrderId，synPay 未推送', [`订单 ${booking.orderNo} · bookingNo ${booking.bookingNo}`, '请到快递100 后台核实该单是否需要手动结算'], { key: `express-synpay-missing:${booking.id}` }))
    }
  }
  const base = booking.quotedFeeFen ?? booking.prepaidFeeFen
  if (p.freightFen !== null && base && !booking.costAlertedAt) {
    if (p.freightFen / base > costAlertRatio) {
      await tx.expressBooking.updateMany({ where: { id: booking.id, costAlertedAt: null }, data: { costAlertedAt: new Date() } })
      after.push(() => notifyExpressAlert('邮寄实扣运费明显高于预扣', [`订单 ${booking.orderNo}`, `预扣 ¥${(base / 100).toFixed(2)} → 实扣 ¥${(p.freightFen! / 100).toFixed(2)}`, '可能是包装附加重量设低了，请核对「邮寄设置 → 重量」'], { key: `express-cost:${booking.id}` }))
    }
  }
}
