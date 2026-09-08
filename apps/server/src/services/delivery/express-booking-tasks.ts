/**
 * 邮寄取件预约的兜底定时任务。与同城 delivery/tasks.ts 同一范式：
 * 「先 updateMany 打标、count=1 才推送」——标记列是唯一真相，并发双 tick 或告警发送失败都不会
 * 造成重复打扰（宁可漏一条提醒，不可轰炸店员）。
 */
import prisma from '../../utils/prisma'
import { getExpressSettings, COURIER_LABEL } from '../express-settings'
import { notifyExpressAlert } from '../order-notify'
import { notifySystemAlert } from '../notify'
import { reconcileUnknownBooking } from './express-booking'

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
