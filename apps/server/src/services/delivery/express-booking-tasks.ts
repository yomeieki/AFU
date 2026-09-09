/**
 * 邮寄取件预约的兜底定时任务。与同城 delivery/tasks.ts 同一范式：
 * 「先 updateMany 打标、count=1 才推送」——标记列是唯一真相，并发双 tick 或告警发送失败都不会
 * 造成重复打扰（宁可漏一条提醒，不可轰炸店员）。
 */
import prisma from '../../utils/prisma'
import { Prisma } from '@prisma/client'
import { getExpressSettings, COURIER_LABEL } from '../express-settings'
import { notifyExpressAlert } from '../order-notify'
import { notifySystemAlert } from '../notify'
import { reconcileUnknownBooking } from './express-booking'
import { getExpressProvider, ExpressDetailResult } from './kd100-express'
import { KD_EXPRESS_STATUS_MAP, BOOKING_RANK } from './express-booking-state'
import { applyProviderStatus } from './express-callback'
import { recordBookingEvent, adminBookingEventKey } from './express-events'
import crypto from 'crypto'

const BATCH = 100
const ago = (min: number) => new Date(Date.now() - min * 60 * 1000)

/** 预约后超过 N 小时没有快递员接单（每单一次） */
export async function remindExpressUnaccepted(hours?: number): Promise<number> {
  const s = await getExpressSettings()
  const h = hours ?? s.pickup.unacceptedRemindHours
  const rows = await prisma.expressBooking.findMany({ where: { status: 'BOOKED', bookedAt: { lt: ago(h * 60) }, unacceptedRemindedAt: null }, take: BATCH, select: { id: true, orderNo: true, kuaidicom: true } })
  let n = 0
  for (const b of rows) {
    const m = await prisma.expressBooking.updateMany({ where: { id: b.id, unacceptedRemindedAt: null }, data: { unacceptedRemindedAt: new Date() } })
    if (m.count === 0) continue
    n++
    notifyExpressAlert('取件预约超时无人接单', [`订单 ${b.orderNo} · ${COURIER_LABEL[b.kuaidicom] ?? b.kuaidicom}`, `预约已超过 ${h} 小时无快递员接单`, '可改约、换家重约或联系快递100 客服'])
  }
  return n
}

/**
 * 未取件提醒的截止时刻计算：两个值必须出自同一个 shifted 瞬间，否则午夜前后会撕裂——
 * 例如现在 00:30 上海时间、m=60（提醒阈值 60 分钟）：正确的截止瞬间是「23:30 昨天」。
 * 如果 cutDate 用「当前日期」算、nowHm 却用「当前减 m 分钟」算（或反过来两处各自现算一次
 * new Date()），会拼出 cutDate=今天 + nowHm=23:30 这种自相矛盾的组合——OR 条件里
 * `pickupDate: cutDate, pickupEnd: { lte: nowHm }` 这一支永远查不到「今天」的预约，因为
 * pickupDate 用的是「今天」但没有一个正常时段会晚于 23:30 结束；`pickupDate: { lt: cutDate }`
 * 那支也吃不到，因为 cutDate 被错算成了今天。改成先算好 shifted 时刻，两段都从它切，
 * 保证 cutDate 与 nowHm 永远描述同一个「再往前推 m 分钟」的瞬间。
 */
export function unpickedCutoff(now: Date, min: number): { cutDate: string; nowHm: string } {
  const shifted = new Date(now.getTime() + 8 * 3600 * 1000 - min * 60 * 1000)
  return { cutDate: shifted.toISOString().slice(0, 10), nowHm: shifted.toISOString().slice(11, 16) }
}

/** 预约时段已结束 N 分钟仍未取件（每单一次）。改约会清标记 */
export async function remindExpressUnpicked(min?: number): Promise<number> {
  const s = await getExpressSettings()
  const m = min ?? s.pickup.unpickedRemindMin
  const { cutDate, nowHm } = unpickedCutoff(new Date(), m)
  const rows = await prisma.expressBooking.findMany({
    where: { status: { in: ['BOOKED', 'ACCEPTED'] }, unpickedRemindedAt: null, OR: [{ pickupDate: { lt: cutDate } }, { pickupDate: cutDate, pickupEnd: { lte: nowHm } }] },
    take: BATCH, select: { id: true, orderNo: true, kuaidicom: true, pickupDate: true, pickupEnd: true },
  })
  let n = 0
  for (const b of rows) {
    const r = await prisma.expressBooking.updateMany({ where: { id: b.id, unpickedRemindedAt: null }, data: { unpickedRemindedAt: new Date() } })
    if (r.count === 0) continue
    n++
    notifyExpressAlert('预约时段已过仍未取件', [`订单 ${b.orderNo} · ${COURIER_LABEL[b.kuaidicom] ?? b.kuaidicom}`, `预约 ${b.pickupDate ?? ''} ${b.pickupEnd ?? ''} 前上门，至今无取件回调`, '请联系快递员或改约；快递100 有时不推揽收失败'])
  }
  return n
}

/**
 * UNKNOWN 对账：满 minAge 分钟的每轮查一次；查到认领，查不到只计数，10 次后提醒一次。
 * 轮询有两道封顶，避免一个永远查不到结果的 UNKNOWN 单每轮都打一次 provider（生产是真实
 * 接口调用，mock 场景下则是共享指令队列，两边都经不起无限轮询）：
 * - `reconcileTries: { lt: 30 }`——查满 30 次还没结果就不再自动查，转人工核对（下方一次性告警）。
 * - `bookedAt: { gt: ago(24h) }`——预约超过 24 小时的 UNKNOWN 单不再自动查（早该有人管了）。
 */
export async function reconcileExpressUnknown(minAge = 1): Promise<number> {
  const rows = await prisma.expressBooking.findMany({
    where: { status: 'UNKNOWN', bookedAt: { lt: ago(minAge), gt: ago(24 * 60) }, reconcileTries: { lt: 30 } },
    take: BATCH, select: { id: true, orderNo: true, bookingNo: true, reconcileTries: true, unknownRemindedAt: true },
  })
  let n = 0
  for (const b of rows) {
    const r = await reconcileUnknownBooking(b.id)
    if (r === 'CLAIMED') { n++; continue }
    if (b.reconcileTries + 1 >= 10 && !b.unknownRemindedAt) {
      const m = await prisma.expressBooking.updateMany({ where: { id: b.id, unknownRemindedAt: null }, data: { unknownRemindedAt: new Date() } })
      if (m.count > 0) notifySystemAlert('取件预约状态长时间未确认', [`订单 ${b.orderNo}（${b.bookingNo}）`, '下单超时后多次查单无结果', '请到快递100 后台核对：有单等回调认领，无单在工作台作废重约'], { key: `express-unknown:${b.id}` })
    }
    // 这次查完 tries 会从 29 变 30，撞上面的 lt:30 封顶，下一轮起不会再被查到——用
    // 「本轮之前恰好是 29」当一次性条件，不需要额外加一列标记：tries 只增不减，
    // 这个等式对每个 booking 一辈子最多为真一次。
    if (b.reconcileTries === 29) {
      notifySystemAlert('取件预约已停止自动查单', [`订单 ${b.orderNo}（${b.bookingNo}）`, '已连续 30 次查单无结果，系统停止继续自动查询', '请到快递100 后台核对：有单等回调认领，无单在工作台作废重约'], { key: `express-unknown-stop:${b.id}` })
    }
  }
  return n
}

const STALE_MAX_TRIES = 48   // 每 30 分钟一次 = 24 小时；之后不再自动查，靠人工
const orderInclude = { order: { include: { user: { select: { openid: true } }, items: { select: { productName: true }, take: 1, orderBy: { id: 'asc' as const } } } } }

/**
 * 「该有回调了却没有」的两类单主动查单（spec §7 对账任务）：
 *  A. BOOKED/ACCEPTED 且预约时段结束 + unpickedRemindMin 已过——快递100 有时不推揽收/揽货失败；
 *  B. PICKED 且取件已超 pickedDays 天——13 签收没推到（autoComplete 7 天已把订单转 COMPLETED，这里只是把预约收尾）。
 * 每单每 intervalMin 分钟最多查一次、累计最多 STALE_MAX_TRIES 次；查到就按回调同一套 applyProviderStatus 推进；
 * 查不到/无进展只提醒一次（staleRemindedAt 打标 count=1 才推送）。
 */
export async function reconcileExpressStale(intervalMin = 30, pickedDays = 10): Promise<number> {
  const s = await getExpressSettings()
  const { cutDate, nowHm } = unpickedCutoff(new Date(), s.pickup.unpickedRemindMin)
  const due: Prisma.ExpressBookingWhereInput = { staleTries: { lt: STALE_MAX_TRIES }, OR: [{ staleCheckedAt: null }, { staleCheckedAt: { lt: ago(intervalMin) } }] }
  const rows = await prisma.expressBooking.findMany({
    where: { OR: [
      { status: { in: ['BOOKED', 'ACCEPTED'] }, AND: [{ OR: [{ pickupDate: { lt: cutDate } }, { pickupDate: cutDate, pickupEnd: { lte: nowHm } }] }, due] },
      { status: 'PICKED', pickedAt: { lt: ago(pickedDays * 24 * 60) }, AND: [due] },
      // C. 预约已签收但订单还停在备货：历史上「漏推 10 直推 13」留下的孤儿单（T1 之后不再产生）。只告警不改单。
      // 终态只增不减，不能每分钟全表扫：加 30 天签收时间窗，配合 due 的 staleTries/staleCheckedAt 节流。
      { status: 'DELIVERED', staleRemindedAt: null, deliveredAt: { gt: ago(30 * 24 * 60) }, order: { status: { in: ['PAID', 'PREPARING'] } }, AND: [due] },
    ] },
    take: BATCH, select: { id: true, staleCheckedAt: true },
  })
  let n = 0
  for (const b of rows) {
    // 先占坑再查：并发双 tick 只有一个能把 staleCheckedAt 从旧值改掉
    const claimed = await prisma.expressBooking.updateMany({ where: { id: b.id, staleCheckedAt: b.staleCheckedAt }, data: { staleCheckedAt: new Date(), staleTries: { increment: 1 } } })
    if (claimed.count === 0) continue
    if ((await reconcileStaleBooking(b.id, pickedDays)) === 'ADVANCED') n++
  }
  return n
}

/**
 * detail 是单条快照，不是回调流——BOOKED/ACCEPTED 单（时段过期未取件那类）如果快递100 已经跳到
 * 在途/派送中（101/400），说明「10 揽收」那条回调八成没推到：这两个是 IGNORE 状态，套给
 * applyProviderStatus 后状态原地不动，还会被判成「无进展」发一条文案错误的提醒（明明已经在途了
 * 却说「无取件回调」），订单也迟迟不 SHIPPED。所以先补一步「10」把取件相关的订单联动、发货通知
 * 都走一遍，再套真正的状态；两步共用同一次 detail 快照，cur 在两步之间原样再派生。
 * （13/签收的补记已内置在 applyProviderStatus 里——回调 / 轨迹 / 对账三条签收路径共用一处，这里
 * 直接把 13 套给它就够，不用再自己判断要不要补 10。）
 */
export async function reconcileStaleBooking(bookingId: number, pickedDays = 10): Promise<'ADVANCED' | 'UNCHANGED' | 'NOT_FOUND' | 'ERROR'> {
  const b = await prisma.expressBooking.findUnique({ where: { id: bookingId }, include: orderInclude })
  if (b && b.status === 'DELIVERED') {
    if (!['PAID', 'PREPARING'].includes(b.order.status)) return 'UNCHANGED'
    const m = await prisma.expressBooking.updateMany({ where: { id: b.id, staleRemindedAt: null }, data: { staleRemindedAt: new Date() } })
    if (m.count > 0) notifyExpressAlert('预约已签收但订单仍在备货中', [`订单 ${b.orderNo} · ${COURIER_LABEL[b.kuaidicom] ?? b.kuaidicom}${b.kuaidinum ? ` ${b.kuaidinum}` : ''}`, '快递100 已签收，但系统没有收到取件回调，订单没有自动发货', '请在工作台「填单号发货」后再「确认收货」，或联系开发核对'], { key: `express-orphan:${b.id}` })
    return 'UNCHANGED'
  }
  if (!b || !['BOOKED', 'ACCEPTED', 'PICKED'].includes(b.status)) return 'UNCHANGED'
  const label = COURIER_LABEL[b.kuaidicom] ?? b.kuaidicom
  let d: ExpressDetailResult
  try {
    d = await getExpressProvider().detail({ taskId: b.taskId, thirdOrderId: b.bookingNo })
  } catch (e) {
    // detail 失败（provider 抖动）不算「无结论」，交给外层 catch 由调度器记账继续；这里只是分类返回值
    console.warn('[express-stale] detail 失败:', (e as Error).message)
    return 'ERROR'
  }
  let result: 'ADVANCED' | 'UNCHANGED' | 'NOT_FOUND'
  if (!d.found) result = 'NOT_FOUND'
  else if (d.status === null) result = 'UNCHANGED' // 有单但查不到状态：跟「查不到该单」不是一回事，文案要分开
  else {
    const status = String(d.status)
    const rawStr = JSON.stringify(d.raw ?? {})
    const { costAlertRatio } = await getExpressSettings()
    const after: (() => void)[] = []
    const orderStatusBefore = b.order.status
    // 13（签收）的补记已内置在 applyProviderStatus；这里只管 101/400 这两种「在途但还没取件回调」的 IGNORE 状态
    const needsPickBackfill = b.statusRank < BOOKING_RANK.PICKED && ['101', '400'].includes(status)
    const steps = needsPickBackfill ? ['10', status] : [status]
    // $transaction 只包裹「已经查到快照」之后的落库；DB 错误让它抛出去，由 reconcileExpressStale
    // 的调用方（调度器每任务 try/catch）记账继续，不要在这里吞掉再误判成「detail 失败」
    await prisma.$transaction(async (tx) => {
      const ev = await recordBookingEvent(tx, { bookingId: b.id, dedupeKey: `RC:${b.bookingNo}:${status}:${crypto.createHash('md5').update(rawStr, 'utf8').digest('hex')}`.slice(0, 64), source: 'SYSTEM', providerStatus: /^\d+$/.test(status) ? Number(status) : null, statusDesc: `对账查单：快递100 状态 ${status}${KD_EXPRESS_STATUS_MAP[status] && 'label' in KD_EXPRESS_STATUS_MAP[status] ? `（${(KD_EXPRESS_STATUS_MAP[status] as { label: string }).label}）` : ''}`, rawPayload: d.raw as Prisma.InputJsonValue })
      if (ev.duplicate) return
      let cur = b
      for (const s of steps) {
        const synthetic = s === '10' && needsPickBackfill
        await applyProviderStatus(tx, cur, { status: s, taskId: d.taskId, kdOrderId: d.kdOrderId, kuaidinum: d.kuaidinum, courierName: d.courierName, courierMobile: d.courierMobile, weightKg: null, freightFen: d.freightFen, defPriceFen: null, feeDetails: null, statusDesc: synthetic ? '对账查单：快递100 已在途/派送中，补记取件' : '对账补状态', raw: (d.raw ?? {}) as Record<string, unknown> }, after, costAlertRatio)
        if (synthetic) cur = { ...cur, status: 'PICKED', statusRank: BOOKING_RANK.PICKED, kuaidinum: d.kuaidinum ?? cur.kuaidinum }
      }
    })
    for (const f of after) { try { f() } catch (e) { console.error('[express-stale] after 失败:', e) } }
    const [nowBooking, nowOrder] = await Promise.all([
      prisma.expressBooking.findUnique({ where: { id: b.id }, select: { status: true } }),
      prisma.order.findUnique({ where: { id: b.orderId }, select: { status: true } }),
    ])
    const bookingMoved = !!nowBooking && nowBooking.status !== b.status
    const orderMoved = !!nowOrder && nowOrder.status !== orderStatusBefore
    result = bookingMoved || orderMoved ? 'ADVANCED' : 'UNCHANGED'
  }
  if (result === 'ADVANCED') return result
  // 无结论只提醒一次
  const m = await prisma.expressBooking.updateMany({ where: { id: b.id, staleRemindedAt: null }, data: { staleRemindedAt: new Date() } })
  if (m.count > 0) {
    // 已发过「时段已过仍未取件」的（BOOKED/ACCEPTED 起点）：有单无进展不再重复轰炸；
    // 但「查不到该单」是另一回事——快递100 那头压根没这张单，店员必须去后台核对，照发。
    const suppressed = b.status !== 'PICKED' && !!b.unpickedRemindedAt && result !== 'NOT_FOUND'
    if (!suppressed) {
      const why = b.status === 'PICKED'
        ? [`已取件超过 ${pickedDays} 天仍无签收回调，主动查单${result === 'NOT_FOUND' ? '查不到该单' : '也无新进展'}`, '订单已按 7 天规则自动完成；如顾客反馈未收到，请到快递100 后台或联系快递公司查件']
        : [`预约时段已过，至今无取件回调，主动查单${result === 'NOT_FOUND' ? '查不到该单' : '也无新进展'}`, '请联系快递员确认是否已取件；未取请改约或取消后换家重约']
      notifyExpressAlert(b.status === 'PICKED' ? '邮寄单取件后长时间未签收' : '预约时段过后仍无进展', [`订单 ${b.orderNo} · ${label}${b.kuaidinum ? ` ${b.kuaidinum}` : ''}`, ...why], { key: `express-stale:${b.id}` })
      if (result === 'NOT_FOUND') {
        try { await recordBookingEvent(prisma, { bookingId: b.id, dedupeKey: adminBookingEventKey(), source: 'SYSTEM', statusDesc: '对账查单：快递100 查不到该单，已提醒店员核对' }) } catch { /* 留痕失败不升级：标记与通知已落，别让这一条炸掉本轮剩余预约 */ }
      }
    }
  }
  return result
}
