/**
 * 邮寄取件预约的兜底定时任务。与同城 delivery/tasks.ts 同一范式：
 * 「先 updateMany 打标、count=1 才推送」——标记列是唯一真相，并发双 tick 或告警发送失败都不会
 * 造成重复打扰（宁可漏一条提醒，不可轰炸店员）。
 */
import prisma from '../../utils/prisma'
import { getExpressSettings } from '../express-settings'
import { notifyExpressAlert } from '../order-notify'
import { notifySystemAlert } from '../notify'
import { reconcileUnknownBooking, pickupDateOf } from './express-booking'
import { COURIER_LABEL } from '../express-settings'

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
/** 预约时段已结束 N 分钟仍未取件（每单一次）。改约会清标记 */
export async function remindExpressUnpicked(min?: number): Promise<number> {
  const s = await getExpressSettings()
  const m = min ?? s.pickup.unpickedRemindMin
  const today = pickupDateOf('今天')
  const nowHm = new Date(Date.now() + 8 * 3600 * 1000 - m * 60 * 1000).toISOString().slice(11, 16)
  const rows = await prisma.expressBooking.findMany({
    where: { status: { in: ['BOOKED', 'ACCEPTED'] }, unpickedRemindedAt: null, OR: [{ pickupDate: { lt: today } }, { pickupDate: today, pickupEnd: { lte: nowHm } }] },
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
/** UNKNOWN 对账：满 minAge 分钟的每轮查一次；查到认领，查不到只计数，10 次后提醒一次 */
export async function reconcileExpressUnknown(minAge = 1): Promise<number> {
  const rows = await prisma.expressBooking.findMany({ where: { status: 'UNKNOWN', bookedAt: { lt: ago(minAge) } }, take: BATCH, select: { id: true, orderNo: true, bookingNo: true, reconcileTries: true, unknownRemindedAt: true } })
  let n = 0
  for (const b of rows) {
    const r = await reconcileUnknownBooking(b.id)
    if (r === 'CLAIMED') { n++; continue }
    if (b.reconcileTries + 1 >= 10 && !b.unknownRemindedAt) {
      const m = await prisma.expressBooking.updateMany({ where: { id: b.id, unknownRemindedAt: null }, data: { unknownRemindedAt: new Date() } })
      if (m.count > 0) notifySystemAlert('取件预约状态长时间未确认', [`订单 ${b.orderNo}（${b.bookingNo}）`, '下单超时后多次查单无结果', '请到快递100 后台核对：有单等回调认领，无单在工作台作废重约'], { key: `express-unknown:${b.id}` })
    }
  }
  return n
}
