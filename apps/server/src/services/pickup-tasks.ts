/**
 * 到店自取的三条定时任务（spec 2026-09-11 §4.6）。全部以 pickupAt 为基准，不看 paidAt：
 *   1. 未接单催单：max(付款 + 15 分钟, 开始备餐时刻 − 15 分钟) 到了还 PAID → 催一次
 *   2. 过时未取提醒：SHIPPED 且 pickupAt + unpickedRemindAfterMin 已过 → 提醒一次
 *   3. 自动完成：SHIPPED 且 pickupAt + autoCompleteAfterMin 已过 → COMPLETED + 推送
 * 「已发货 7 天自动完成」按 Shipment.shippedAt 过滤，自取没有 Shipment 行，天然不碰；
 * `autoRejectStaleCancelRequests` 只扫 LOCAL/EXPRESS，自取不自动驳回（spec §4.5）。
 */
import prisma from '../utils/prisma'
import { getLocalSettings } from './local-settings'
import { prepStartAt, pickupSlotLabel } from './pickup'
import { notifyAcceptReminder, notifyPickupUnpicked, notifyPickupAutoCompleted } from './order-notify'
import { settlePoints } from './member/points'
import { ACCEPT_REMIND_AFTER_MIN } from '../utils/constants'

const BATCH = 100
const MIN = 60 * 1000

export async function remindPickupUnaccepted(afterMin = ACCEPT_REMIND_AFTER_MIN): Promise<number> {
  const s = await getLocalSettings()
  const now = Date.now()
  const rows = await prisma.order.findMany({
    where: { deliveryType: 'PICKUP', status: 'PAID', acceptRemindedAt: null, paidAt: { not: null }, pickupAt: { not: null } },
    select: { id: true, orderNo: true, actualAmount: true, receiverName: true, receiverPhone: true, paidAt: true, pickupAt: true },
    take: BATCH, orderBy: { paidAt: 'asc' },
  })
  // 触发时刻 = max(付款 + afterMin, 开始备餐 − 15 分钟)：明天的单不在今晚催，尽快的单照旧 15 分钟
  const due = rows.filter((o) => now >= Math.max(o.paidAt!.getTime() + afterMin * MIN, prepStartAt(s, o.pickupAt!).getTime() - 15 * MIN))
  if (due.length === 0) return 0
  await prisma.order.updateMany({ where: { id: { in: due.map((o) => o.id) } }, data: { acceptRemindedAt: new Date() } })
  notifyAcceptReminder(due)
  return due.length
}

export async function remindPickupUnpicked(afterMin?: number): Promise<number> {
  const s = await getLocalSettings()
  const after = afterMin ?? s.pickup.unpickedRemindAfterMin
  const rows = await prisma.order.findMany({
    where: { deliveryType: 'PICKUP', status: 'SHIPPED', pickupRemindedAt: null, pickupAt: { lt: new Date(Date.now() - after * MIN) } },
    select: { id: true, orderNo: true, receiverPhone: true, pickupAt: true },
    take: BATCH, orderBy: { pickupAt: 'asc' },
  })
  let n = 0
  const reminded: { orderNo: string; receiverPhone: string; slotLabel: string }[] = []
  for (const o of rows) {
    const marked = await prisma.order.updateMany({ where: { id: o.id, pickupRemindedAt: null }, data: { pickupRemindedAt: new Date() } })
    if (marked.count === 0) continue
    n++
    reminded.push({ orderNo: o.orderNo, receiverPhone: o.receiverPhone, slotLabel: pickupSlotLabel(o.pickupAt!, s.pickup.slotMinutes) })
  }
  if (reminded.length) notifyPickupUnpicked(reminded)
  return n
}

export async function autoCompletePickup(afterMin?: number): Promise<number> {
  const s = await getLocalSettings()
  const after = afterMin ?? s.pickup.autoCompleteAfterMin
  const rows = await prisma.order.findMany({
    where: { deliveryType: 'PICKUP', status: 'SHIPPED', pickupAt: { lt: new Date(Date.now() - after * MIN) } },
    select: { id: true, orderNo: true, receiverPhone: true, pickupAt: true },
    take: BATCH, orderBy: { pickupAt: 'asc' },
  })
  const done: { orderNo: string; receiverPhone: string; slotLabel: string }[] = []
  for (const o of rows) {
    const moved = await prisma.order.updateMany({
      where: { id: o.id, status: 'SHIPPED', deliveryType: 'PICKUP' },
      data: { status: 'COMPLETED', completedAt: new Date() },
    })
    if (moved.count === 0) continue
    void settlePoints(o.id)
    done.push({ orderNo: o.orderNo, receiverPhone: o.receiverPhone, slotLabel: pickupSlotLabel(o.pickupAt!, s.pickup.slotMinutes) })
  }
  if (done.length) notifyPickupAutoCompleted(done)
  if (done.length > 0) console.log(`[scheduler] 自取超时自动完成 ${done.length} 单`)
  return done.length
}
