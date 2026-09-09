/**
 * 邮寄取件预约的编排层（与同城 orchestrator.ts 平行）：建单 / 取消 / 改约 / 作废 / 对账 / 给弹窗报价。
 * 只在这里碰 express_bookings 的状态列；回调推进见 express-callback.ts。
 * 规则来源 spec §5.2–§5.4、§6。
 */
import crypto from 'crypto'
import { ExpressBooking } from '@prisma/client'
import prisma from '../../utils/prisma'
import { AppError } from '../../middlewares/error'
import { config } from '../../config'
import { getExpressSettings, findRegionGroup, COURIER_LABEL, EXPRESS_COURIERS } from '../express-settings'
import { CourierQuote, calcPackageWeightKg } from '../express-quote'
import { fetchCourierQuotes, MAX_ADDRESS_BYTES } from '../express-quote-service'
import { getLocalSettings, shanghaiMinutes } from '../local-settings'
import { getExpressProvider, ExpressBookResult } from './kd100-express'
import { ProviderError } from './types'
import { BOOKING_ACTIVE, BOOKING_RANK, BOOKING_STATUS_LABEL } from './express-booking-state'
import { recordBookingEvent, adminBookingEventKey, truncStr } from './express-events'
import { notifyExpressAlert } from '../order-notify'
import { notifySystemAlert } from '../notify'
import { parseStoredTrack } from './express-track-json'

export const BOOKING_QUOTE_STALE_MS = 90 * 60 * 1000
const DAY_TYPES = ['今天', '明天', '后天'] as const
export interface SlotInput { dayType: (typeof DAY_TYPES)[number]; pickupStart: string | null; pickupEnd: string | null }
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/
const toMin = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5))
const fromMin = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`

/** 时段规则（spec §5.2 / 调研 §3.1）：≥1h；今天要 now < end−2h；顺丰必填；其它家可留空 */
export function validateSlot(slot: SlotInput, kuaidicom: string, now: Date = new Date()): string | null {
  if (!(DAY_TYPES as readonly string[]).includes(slot.dayType)) return '预约日期只能是今天、明天或后天'
  const s = slot.pickupStart, e = slot.pickupEnd
  if (!s && !e) return kuaidicom === 'shunfeng' ? '顺丰必须填写取件时段' : null
  if (!s || !e || !HHMM.test(s) || !HHMM.test(e)) return '取件时段请填 HH:mm（如 14:00）'
  if (toMin(e) - toMin(s) < 60) return '取件时段至少 1 小时'
  if (slot.dayType === '今天' && shanghaiMinutes(now) >= toMin(e) - 120) return '今天的时段须在结束前 2 小时预约，请改晚一点或约明天'
  return null
}
/** 预填：现在 + 2h 向上取整点为开始，结束 = 开始 + 2h；超过 20:00 就明天 09:00–11:00；
 *  凌晨时段算出的开始点会早于 09:00（营业窗口下限），钳到 09:00 起 */
export function suggestSlot(now: Date = new Date()): SlotInput {
  let start = Math.ceil((shanghaiMinutes(now) + 120) / 60) * 60
  if (start < 9 * 60) start = 9 * 60
  if (start + 120 > 20 * 60) return { dayType: '明天', pickupStart: '09:00', pickupEnd: '11:00' }
  return { dayType: '今天', pickupStart: fromMin(start), pickupEnd: fromMin(start + 120) }
}
export function pickupDateOf(dayType: SlotInput['dayType'], now: Date = new Date()): string {
  const offset = DAY_TYPES.indexOf(dayType)
  const sh = new Date(now.getTime() + 8 * 3600 * 1000 + offset * 86400 * 1000)
  return sh.toISOString().slice(0, 10)
}

export async function getActiveBooking(orderId: number) {
  return prisma.expressBooking.findFirst({ where: { activeOrderId: orderId } })
}

export interface BookingView {
  id: number; bookingNo: string; status: string; statusLabel: string; kuaidicom: string; courierLabel: string; serviceType: string | null
  kuaidinum: string | null; dayType: string | null; pickupDate: string | null; pickupStart: string | null; pickupEnd: string | null; slotText: string
  weightKg: number; customerFeeFen: number; quotedFeeFen: number | null; prepaidFeeFen: number | null; settledFeeFen: number | null; billedWeightG: number | null
  courierName: string | null; courierMobile: string | null; failReason: string | null; cancelledBy: string | null
  bookedAt: string | null; acceptedAt: string | null; pickedAt: string | null; deliveredAt: string | null; cancelledAt: string | null
  trackStatus: string | null; trackUpdatedAt: string | null; trackCount: number; latestTrack: { context: string; ftime: string } | null
}
const iso = (d: Date | null) => (d ? d.toISOString() : null)
export function bookingView(b: ExpressBooking): BookingView {
  const date = b.pickupDate ? `${Number(b.pickupDate.slice(5, 7))}月${Number(b.pickupDate.slice(8, 10))}日` : ''
  const slotText = b.pickupStart && b.pickupEnd ? `${date} ${b.pickupStart}–${b.pickupEnd}` : date ? `${date} 时段不限` : ''
  const st = parseStoredTrack(b.trackJson)
  return {
    id: b.id, bookingNo: b.bookingNo, status: b.status, statusLabel: BOOKING_STATUS_LABEL[b.status] ?? b.status,
    kuaidicom: b.kuaidicom, courierLabel: COURIER_LABEL[b.kuaidicom] ?? b.kuaidicom, serviceType: b.serviceType,
    kuaidinum: b.kuaidinum, dayType: b.dayType, pickupDate: b.pickupDate, pickupStart: b.pickupStart, pickupEnd: b.pickupEnd, slotText,
    weightKg: b.weightG / 1000, customerFeeFen: b.customerFeeFen, quotedFeeFen: b.quotedFeeFen, prepaidFeeFen: b.prepaidFeeFen, settledFeeFen: b.settledFeeFen, billedWeightG: b.billedWeightG,
    courierName: b.courierName, courierMobile: b.courierMobile, failReason: b.failReason, cancelledBy: b.cancelledBy,
    bookedAt: iso(b.bookedAt), acceptedAt: iso(b.acceptedAt), pickedAt: iso(b.pickedAt), deliveredAt: iso(b.deliveredAt), cancelledAt: iso(b.cancelledAt),
    trackStatus: b.trackStatus, trackUpdatedAt: iso(b.trackUpdatedAt),
    trackCount: st?.items.length ?? 0,
    latestTrack: st?.items[0] ?? null,
  }
}

async function loadExpressOrder(orderId: number) {
  const o = await prisma.order.findUnique({ where: { id: orderId }, include: { items: { select: { productId: true, quantity: true, product: { select: { netWeightG: true } } } } } })
  if (!o) throw new AppError(40401, '订单不存在', 404)
  if (o.deliveryType !== 'EXPRESS') throw new AppError(42204, '仅邮寄订单可预约取件')
  return o
}
async function orderWeightKg(o: Awaited<ReturnType<typeof loadExpressOrder>>): Promise<number> {
  if (o.expressWeightG) return o.expressWeightG / 1000
  const s = await getExpressSettings()
  return calcPackageWeightKg(o.items.map((it) => ({ netWeightG: it.product?.netWeightG ?? null, quantity: it.quantity })), s.weight)
}

/** 弹窗用：各家报价（快照 90 分钟内、重量未变、有价家数达标就复用，否则现查）+ 顾客付的运费
 *  preloaded：调用方（如 createBooking）已经查过订单/配置时传进来，省一次重复查询。 */
export async function getBookingQuotes(
  orderId: number,
  weightKg?: number,
  preloaded?: { order: Awaited<ReturnType<typeof loadExpressOrder>>; settings: Awaited<ReturnType<typeof getExpressSettings>> },
) {
  const o = preloaded?.order ?? (await loadExpressOrder(orderId))
  const s = preloaded?.settings ?? (await getExpressSettings())
  const w = weightKg ?? (await orderWeightKg(o))
  const snap = (o.expressQuoteSnapshot ?? null) as { quotes?: CourierQuote[]; weightKg?: number } | null
  const fresh = Date.now() - o.createdAt.getTime() < BOOKING_QUOTE_STALE_MS
  // defaultRemark 带给预约弹窗当备注预填（spec §5.2）：跟着这次已经查好的 settings 一起返回，
  // 不用再让前端/路由单独多打一次 GET /api/admin/settings/express。
  // 复用快照前还要求「有价家数」达标：报价家数够、但报出来的都是 0（挂了/超区）的快照不该被当成新鲜结果复用。
  const pricedCount = snap?.quotes?.filter((q) => (q.priceFen ?? 0) > 0).length ?? 0
  if (snap?.quotes?.length && snap.weightKg === w && fresh && pricedCount >= s.fee.minQuoteCount) {
    return { quotes: snap.quotes, weightKg: w, customerFeeFen: o.shippingFee, fromSnapshot: true, quotedAt: o.createdAt.toISOString(), defaultRemark: s.pickup.defaultRemark }
  }
  const live = (await fetchCourierQuotes(s, 0, o.receiverFullAddress, w, { ignoreMode: true })) ?? []
  return { quotes: live, weightKg: w, customerFeeFen: o.shippingFee, fromSnapshot: false, quotedAt: new Date().toISOString(), defaultRemark: s.pickup.defaultRemark }
}

export async function createBooking(i: { orderId: number; kuaidicom: string; serviceType?: string | null; weightKg?: number; slot: SlotInput; remark?: string | null; operator: string }) {
  const o = await loadExpressOrder(i.orderId)
  if (o.status !== 'PREPARING') throw new AppError(42204, `订单状态为 ${o.status}，仅备货中订单可预约取件`)
  if (o.cancelRequestedAt) throw new AppError(42266, '顾客有待处理的取消申请，请先处理再预约')
  if (!(EXPRESS_COURIERS as readonly string[]).includes(i.kuaidicom)) throw new AppError(40001, '不支持的快递公司')
  const s = await getExpressSettings()
  const group = findRegionGroup(s, o.receiverProvince)
  if (group.blocked) throw new AppError(42260, '该地区暂不支持邮寄')
  if (Buffer.byteLength(o.receiverFullAddress, 'utf8') > MAX_ADDRESS_BYTES) throw new AppError(42262, '收货地址过长，请精简后再试')
  const slotErr = validateSlot(i.slot, i.kuaidicom)
  if (slotErr) throw new AppError(42269, slotErr)
  if (await getActiveBooking(i.orderId)) throw new AppError(42265, '该订单已有取件预约，请先取消再重约')
  const weightKg = Math.max(0.1, Math.round((i.weightKg ?? (await orderWeightKg(o))) * 10) / 10)
  const q = await getBookingQuotes(i.orderId, weightKg, { order: o, settings: s })
  const quoted = q.quotes.find((x) => x.kuaidicom === i.kuaidicom)?.priceFen ?? null

  const seq = (await prisma.expressBooking.count({ where: { orderId: i.orderId } })) + 1
  const bookingNo = `E${i.orderId}-${seq}`
  const callbackUrl = `${config.publicBaseUrl}/api/kd-express/${bookingNo}`
  if (Buffer.byteLength(callbackUrl) > 200) throw new AppError(42225, `回调地址超长（${Buffer.byteLength(callbackUrl)}>200），请联系管理员`)
  const pollCallbackUrl = `${callbackUrl}/track`
  if (Buffer.byteLength(pollCallbackUrl) > 200) throw new AppError(42225, `轨迹回调地址超长（${Buffer.byteLength(pollCallbackUrl)}>200），请联系管理员`)
  const callbackSalt = crypto.randomBytes(16).toString('hex')
  // store 放在 create 之前查：create 之后到外呼之间只剩「拼 book() 的入参」，不能再插会抛错的 await
  // ——否则外呼真成功后万一那段代码抛错，这行 PENDING 会一直卡着，既不是「预约失败」也不是「已下单待核对」。
  const store = (await getLocalSettings()).store
  let row: ExpressBooking
  try {
    row = await prisma.expressBooking.create({ data: {
      orderId: i.orderId, orderNo: o.orderNo, bookingNo, activeOrderId: i.orderId, kuaidicom: i.kuaidicom, serviceType: i.serviceType ?? null,
      status: 'PENDING', statusRank: BOOKING_RANK.PENDING, dayType: i.slot.dayType, pickupDate: pickupDateOf(i.slot.dayType),
      pickupStart: i.slot.pickupStart, pickupEnd: i.slot.pickupEnd, weightG: Math.round(weightKg * 1000),
      customerFeeFen: o.shippingFee, quotedFeeFen: quoted, callbackSalt, remark: truncStr(i.remark ?? s.pickup.defaultRemark, 64), operator: truncStr(i.operator, 64),
    } })
  } catch (e) {
    if ((e as { code?: string }).code === 'P2002') throw new AppError(42265, '该订单已有取件预约，请先取消再重约')
    throw e
  }

  let r: ExpressBookResult
  try {
    r = await getExpressProvider().book({
      bookingNo, kuaidicom: i.kuaidicom, serviceType: i.serviceType ?? null,
      sender: { name: store.name, mobile: store.phone, addr: `${store.province}${store.city}${store.district}${store.address}` },
      receiver: { name: o.receiverName, mobile: o.receiverPhone, addr: o.receiverFullAddress },
      cargo: s.pickup.cargoName, weightKg, remark: row.remark, dayType: i.slot.dayType, pickupStart: i.slot.pickupStart, pickupEnd: i.slot.pickupEnd,
      callbackUrl, pollCallbackUrl, salt: callbackSalt,
    })
  } catch (e) {
    if (e instanceof ProviderError && e.kind === 'TIMEOUT') {
      // 下单可能已成功：占位改 UNKNOWN、不释放，等回调认领或对账任务 detail 认领/人工作废
      await prisma.expressBooking.updateMany({ where: { id: row.id, status: 'PENDING' }, data: { status: 'UNKNOWN', statusRank: BOOKING_RANK.UNKNOWN, bookedAt: new Date(), errorCode: truncStr(e.code, 16), failReason: truncStr(e.message, 255) } })
      return { bookingId: row.id, bookingNo, status: 'UNKNOWN' as const, kuaidinum: null }
    }
    const msg = e instanceof ProviderError ? e.message : (e as Error).message
    await prisma.expressBooking.updateMany({ where: { id: row.id, status: 'PENDING' }, data: { status: 'FAILED', activeOrderId: null, errorCode: truncStr(e instanceof ProviderError ? e.code : 'ERR', 16), failReason: truncStr(msg, 255) } })
    if (e instanceof ProviderError && e.kind === 'BALANCE') notifyExpressAlert('快递100 余额不足，邮寄预约失败', [`订单 ${o.orderNo}`, msg, '请到快递100 企业后台充值'], { key: 'express:balance' })
    throw new AppError(42270, `快递100 下单失败：${msg}`)
  }

  // 外呼已成功拿到 r——courier 那边订单真实存在了。这之后的落库失败（DB 抖动 / taskId 唯一索引撞车）
  // 不能再走上面「预约失败」的分支去释放 activeOrderId，否则店员会重约、撞出双单。
  try {
    await prisma.$transaction(async (tx) => {
      // 用 updateMany + status:'PENDING' 守：回调可能在外呼期间已经把这行推进到 ACCEPTED/PICKED 等更靠后的状态，
      // 这里绝不能把它们回退成 BOOKED——count===0 时只补 identity 字段（taskId 唯一索引要求先占位），不碰 status。
      const moved = await tx.expressBooking.updateMany({ where: { id: row.id, status: 'PENDING' }, data: { status: 'BOOKED', statusRank: BOOKING_RANK.BOOKED, bookedAt: new Date(), taskId: r.taskId, kdOrderId: r.kdOrderId, kuaidinum: r.kuaidinum, pollToken: r.pollToken } })
      if (moved.count === 0) {
        // 回调抢先推进了状态：只按列补齐回调没带的 id，每列各自守 null，谁先写谁算
        if (r.taskId) await tx.expressBooking.updateMany({ where: { id: row.id, taskId: null }, data: { taskId: r.taskId } })
        if (r.kdOrderId) await tx.expressBooking.updateMany({ where: { id: row.id, kdOrderId: null }, data: { kdOrderId: r.kdOrderId } })
        if (r.pollToken) await tx.expressBooking.updateMany({ where: { id: row.id, pollToken: null }, data: { pollToken: r.pollToken } })
        if (r.kuaidinum) await tx.expressBooking.updateMany({ where: { id: row.id, kuaidinum: null }, data: { kuaidinum: r.kuaidinum } })
        await tx.expressBooking.updateMany({ where: { id: row.id, bookedAt: null }, data: { bookedAt: new Date() } })
      }
      await recordBookingEvent(tx, { bookingId: row.id, dedupeKey: adminBookingEventKey(), source: 'ADMIN', statusDesc: `预约成功 ${COURIER_LABEL[i.kuaidicom] ?? i.kuaidicom}${r.kuaidinum ? ` 单号 ${r.kuaidinum}` : '（单号待回调）'}`, operator: i.operator })
      // 单号一到就写 Shipment（不写 shippedAt、不改订单状态——那是「已取件」回调的事）
      if (r.kuaidinum) {
        await tx.shipment.upsert({ where: { orderId: i.orderId }, update: { expressCompany: COURIER_LABEL[i.kuaidicom] ?? i.kuaidicom, expressNo: r.kuaidinum }, create: { orderId: i.orderId, orderNo: o.orderNo, deliveryType: 'EXPRESS', expressCompany: COURIER_LABEL[i.kuaidicom] ?? i.kuaidicom, expressNo: r.kuaidinum } })
      }
    })
    return { bookingId: row.id, bookingNo, status: 'BOOKED' as const, kuaidinum: r.kuaidinum }
  } catch (e) {
    // P2002 打在 taskId 唯一索引上说明这个 taskId 本身就是脏的（不该再写回去）；其它失败（DB 抖动等）taskId 仍然有效。
    const isTaskIdConflict = (e as { code?: string }).code === 'P2002' && String((e as { meta?: { target?: unknown } }).meta?.target ?? '').includes('task_id')
    const msg = (e as Error).message
    await prisma.expressBooking.updateMany({
      where: { id: row.id, status: 'PENDING' },
      data: {
        status: 'UNKNOWN', statusRank: BOOKING_RANK.UNKNOWN, bookedAt: new Date(),
        ...(isTaskIdConflict ? {} : { taskId: r.taskId }),
        kdOrderId: r.kdOrderId, kuaidinum: r.kuaidinum, pollToken: r.pollToken,
        errorCode: 'DB', failReason: truncStr(`下单成功但落库失败：${msg}`, 255),
      },
    })
    notifySystemAlert('取件预约下单成功但落库失败', [`订单 ${o.orderNo}`, `预约 ${bookingNo}`, msg], { key: `express-landing:${row.id}` })
    return { bookingId: row.id, bookingNo, status: 'UNKNOWN' as const, kuaidinum: r.kuaidinum }
  }
}

export async function cancelBooking(i: { orderId: number; operator: string; reason?: string; by: 'STAFF' | 'CUSTOMER' }): Promise<void> {
  const b = await getActiveBooking(i.orderId)
  if (!b) throw new AppError(42267, '没有可取消的取件预约')
  if (b.status === 'UNKNOWN') throw new AppError(42267, '预约状态未确认：请等系统核对，或确认快递100 后台无单后作废')
  const reason = (i.reason ?? (i.by === 'CUSTOMER' ? '顾客申请取消' : '店员取消')).slice(0, 30)
  try {
    await getExpressProvider().cancel({ taskId: b.taskId, kdOrderId: b.kdOrderId, reason })
  } catch (e) {
    if (e instanceof ProviderError && e.kind === 'TIMEOUT') throw new AppError(42268, '取消请求超时，请稍后重试（状态未变化）')
    throw new AppError(42267, `快递100 拒绝取消：${(e as Error).message}`)
  }
  await prisma.$transaction(async (tx) => {
    const moved = await tx.expressBooking.updateMany({ where: { id: b.id, status: { in: ['BOOKED', 'ACCEPTED'] } }, data: { status: 'CANCELLED', activeOrderId: null, cancelledAt: new Date(), cancelledBy: i.by, cancelReason: truncStr(reason, 255) } })
    if (moved.count === 0) throw new AppError(42267, '预约状态已变化（可能已取件），请刷新')
    await recordBookingEvent(tx, { bookingId: b.id, dedupeKey: adminBookingEventKey(), source: 'ADMIN', statusDesc: `取消预约（${reason}）`, operator: i.operator })
  })
}

export async function modifyBookingSlot(i: { orderId: number; slot: SlotInput; operator: string }): Promise<void> {
  const b = await getActiveBooking(i.orderId)
  if (!b || !['BOOKED', 'ACCEPTED'].includes(b.status)) throw new AppError(42267, '当前没有可改约的预约')
  const err = validateSlot(i.slot, b.kuaidicom)
  if (err) throw new AppError(42269, err)
  try {
    await getExpressProvider().modify({ taskId: b.taskId, kdOrderId: b.kdOrderId, dayType: i.slot.dayType, pickupStart: i.slot.pickupStart, pickupEnd: i.slot.pickupEnd })
  } catch (e) {
    if (e instanceof ProviderError && e.kind === 'TIMEOUT') throw new AppError(42268, '改约请求超时，请稍后重试（状态未变化）')
    throw new AppError(42267, `快递100 拒绝改约：${(e as Error).message}`)
  }
  await prisma.$transaction(async (tx) => {
    const moved = await tx.expressBooking.updateMany({ where: { id: b.id, status: { in: ['BOOKED', 'ACCEPTED'] } }, data: { dayType: i.slot.dayType, pickupDate: pickupDateOf(i.slot.dayType), pickupStart: i.slot.pickupStart, pickupEnd: i.slot.pickupEnd, unpickedRemindedAt: null, staleCheckedAt: null, staleRemindedAt: null, staleTries: 0 } })
    if (moved.count === 0) throw new AppError(42267, '预约状态已变化，请刷新')
    await recordBookingEvent(tx, { bookingId: b.id, dedupeKey: adminBookingEventKey(), source: 'ADMIN', statusDesc: `改约 ${i.slot.dayType} ${i.slot.pickupStart ?? ''}–${i.slot.pickupEnd ?? ''}`, operator: i.operator })
  })
}

export async function voidUnknownBooking(i: { orderId: number; operator: string }): Promise<void> {
  const b = await getActiveBooking(i.orderId)
  if (!b) throw new AppError(42267, '仅「待核对」的预约可作废')
  // PENDING 是外呼完成前的占位（createBooking 先落库再打 provider），正常情况几秒内就会推进到
  // BOOKED/UNKNOWN/FAILED 之一。只有进程在这几秒的窗口里崩溃/重启，才会留下一条永远卡住的 PENDING
  // ——它既不是「预约失败」（没释放 activeOrderId，挡着不能重约），也不是「待核对」（voidUnknownBooking
  // 原本只认 UNKNOWN）。超过 2 分钟还是 PENDING 基本可以断定外呼那条协程已经没了，给个逃生舱；
  // 2 分钟内的 PENDING 大概率只是正常下单中，不能当成卡死处理，否则会跟真实下单撞车作废掉一个正在成功的预约。
  const stalePending = b.status === 'PENDING' && b.createdAt.getTime() < Date.now() - 2 * 60 * 1000
  if (b.status !== 'UNKNOWN' && !stalePending) {
    if (b.status === 'PENDING') throw new AppError(42267, '预约正在下单中，请稍候再试')
    throw new AppError(42267, '仅「待核对」的预约可作废')
  }
  await prisma.$transaction(async (tx) => {
    const moved = await tx.expressBooking.updateMany({ where: { id: b.id, status: b.status }, data: { status: 'VOID', activeOrderId: null, cancelledAt: new Date(), cancelledBy: 'STAFF' } })
    if (moved.count === 0) throw new AppError(42267, '预约状态已变化，请刷新')
    await recordBookingEvent(tx, { bookingId: b.id, dedupeKey: adminBookingEventKey(), source: 'ADMIN', statusDesc: stalePending ? '人工作废（下单占位卡住超过 2 分钟）' : '人工作废（快递100 后台核对无单）', operator: i.operator })
  })
}

/**
 * UNKNOWN 对账：用 thirdOrderId 查 detail。查到 → 认领为 BOOKED（补 taskId/单号）；查不到只计数，
 * **不自动作废**——detail 按 thirdOrderId 查是否可用尚未在测试环境验证（spec §14），自动作废判错就是双单。
 */
export async function reconcileUnknownBooking(bookingId: number): Promise<'CLAIMED' | 'STILL_UNKNOWN'> {
  const b = await prisma.expressBooking.findUnique({ where: { id: bookingId } })
  if (!b || b.status !== 'UNKNOWN') return 'STILL_UNKNOWN'
  let d
  try { d = await getExpressProvider().detail({ taskId: b.taskId, thirdOrderId: b.bookingNo }) }
  catch { await prisma.expressBooking.update({ where: { id: b.id }, data: { reconcileTries: { increment: 1 } } }); return 'STILL_UNKNOWN' }
  if (!d.found) { await prisma.expressBooking.update({ where: { id: b.id }, data: { reconcileTries: { increment: 1 } } }); return 'STILL_UNKNOWN' }
  await prisma.$transaction(async (tx) => {
    const moved = await tx.expressBooking.updateMany({ where: { id: b.id, status: 'UNKNOWN' }, data: { status: 'BOOKED', statusRank: BOOKING_RANK.BOOKED, taskId: d.taskId ?? b.taskId, kdOrderId: d.kdOrderId ?? b.kdOrderId, kuaidinum: d.kuaidinum ?? b.kuaidinum, courierName: d.courierName ?? undefined, courierMobile: d.courierMobile ?? undefined, errorCode: null, failReason: null } })
    if (moved.count === 0) return
    await recordBookingEvent(tx, { bookingId: b.id, dedupeKey: adminBookingEventKey(), source: 'SYSTEM', statusDesc: `对账认领：快递100 有单（status=${d.status ?? '?'}）` })
    if (d.kuaidinum) await tx.shipment.upsert({ where: { orderId: b.orderId }, update: { expressCompany: COURIER_LABEL[b.kuaidicom] ?? b.kuaidicom, expressNo: d.kuaidinum }, create: { orderId: b.orderId, orderNo: b.orderNo, deliveryType: 'EXPRESS', expressCompany: COURIER_LABEL[b.kuaidicom] ?? b.kuaidicom, expressNo: d.kuaidinum } })
  })
  return 'CLAIMED'
}
export const isActiveBookingStatus = (s: string) => (BOOKING_ACTIVE as readonly string[]).includes(s)
