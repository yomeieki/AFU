/**
 * 同城配送兜底任务。全部「先 updateMany 打标、count=1 才推送」——标记列是唯一真相，
 * 并发双 tick 或告警发送失败都不会造成重复打扰（宁可漏一条提醒，不可轰炸店员）。
 */
import { Prisma } from '@prisma/client'
import prisma from '../../utils/prisma'
import { config } from '../../config'
import { getLocalSettings, isOpenNow } from '../local-settings'
import { isCircuitTripped } from './circuit'
import { callRider } from './orchestrator'
import { notifySystemAlert } from '../notify'
import { notifyLocalDeliveryAlert } from '../order-notify'
import { DELIVERY_STATUS_LABEL, TERMINAL } from './state'

const BATCH = 100
const ago = (min: number) => new Date(Date.now() - min * 60 * 1000)

/** Delivery CALLING 超时无人接单（每单只推一次） */
export async function remindCallTimeout(min?: number): Promise<number> {
  const s = await getLocalSettings()
  const threshold = min ?? s.callTimeoutMin
  const rows = await prisma.delivery.findMany({
    where: { status: 'CALLING', calledAt: { lt: ago(threshold) }, callTimeoutRemindedAt: null },
    take: BATCH, select: { id: true, orderNo: true, calledAt: true },
  })
  let n = 0
  for (const d of rows) {
    const marked = await prisma.delivery.updateMany({ where: { id: d.id, callTimeoutRemindedAt: null }, data: { callTimeoutRemindedAt: new Date() } })
    if (marked.count === 0) continue
    n++
    notifyLocalDeliveryAlert('待抢单超时', [`订单 ${d.orderNo}`, `已等待超过 ${threshold} 分钟无人接单`, '可加小费、继续等待或改自己送'])
  }
  return n
}

/** 骑手接单/赶来/已到店后长时间无进一步进展（每单只推一次） */
export async function remindAcceptedStuck(min?: number): Promise<number> {
  const s = await getLocalSettings()
  const threshold = min ?? s.acceptedStuckMin
  const rows = await prisma.delivery.findMany({
    where: { status: { in: ['ACCEPTED', 'ARRIVING', 'ARRIVED'] }, acceptedAt: { lt: ago(threshold) }, acceptedStuckRemindedAt: null },
    take: BATCH, select: { id: true, orderNo: true, status: true },
  })
  let n = 0
  for (const d of rows) {
    const marked = await prisma.delivery.updateMany({ where: { id: d.id, acceptedStuckRemindedAt: null }, data: { acceptedStuckRemindedAt: new Date() } })
    if (marked.count === 0) continue
    n++
    notifyLocalDeliveryAlert('骑手接单后卡住', [`订单 ${d.orderNo}`, `已超过 ${threshold} 分钟仍在「${DELIVERY_STATUS_LABEL[d.status] ?? d.status}」`, '请联系骑手核实进度'])
  }
  return n
}

/** 骑手已取货但长时间未送达（每单只推一次） */
export async function remindDeliveringTimeout(min?: number): Promise<number> {
  const s = await getLocalSettings()
  const threshold = min ?? s.deliveringTimeoutMin
  const rows = await prisma.delivery.findMany({
    where: { status: 'DELIVERING', pickedUpAt: { lt: ago(threshold) }, deliveringRemindedAt: null },
    take: BATCH, select: { id: true, orderNo: true },
  })
  let n = 0
  for (const d of rows) {
    const marked = await prisma.delivery.updateMany({ where: { id: d.id, deliveringRemindedAt: null }, data: { deliveringRemindedAt: new Date() } })
    if (marked.count === 0) continue
    n++
    notifyLocalDeliveryAlert('配送超时未送达', [`订单 ${d.orderNo}`, `已取货超过 ${threshold} 分钟仍未送达`, '请联系骑手核实进度'])
  }
  return n
}

/** 下单响应超时留下的 UNKNOWN 幽灵单，长时间无回调认领（每单只推一次，要老板去快递100后台核对） */
export async function remindUnknownGhost(min = 10): Promise<number> {
  const rows = await prisma.delivery.findMany({
    where: { status: 'UNKNOWN', calledAt: { lt: ago(min) }, unknownRemindedAt: null },
    take: BATCH, select: { id: true, orderNo: true, deliveryNo: true },
  })
  let n = 0
  for (const d of rows) {
    const marked = await prisma.delivery.updateMany({ where: { id: d.id, unknownRemindedAt: null }, data: { unknownRemindedAt: new Date() } })
    if (marked.count === 0) continue
    n++
    notifySystemAlert('配送单状态长时间未确认', [`订单 ${d.orderNo}（${d.deliveryNo}）`, `已超过 ${min} 分钟无回调认领`, '请到快递100 后台核对：有单等回调或人工作废，无单直接作废'], { key: `dlv-unknown:${d.id}` })
  }
  return n
}

/** 备餐超时仍未呼叫骑手，也没有在途配送单（每单只推一次） */
export async function remindLocalUncalled(min = 10): Promise<number> {
  const rows = await prisma.order.findMany({
    where: {
      deliveryType: 'LOCAL', status: 'PREPARING', cancelRequestedAt: null,
      acceptedAt: { lt: ago(min) }, localUncalledRemindedAt: null,
      deliveries: { none: { activeOrderId: { not: null } } },
    },
    take: BATCH, select: { id: true, orderNo: true },
  })
  let n = 0
  for (const o of rows) {
    const marked = await prisma.order.updateMany({ where: { id: o.id, localUncalledRemindedAt: null }, data: { localUncalledRemindedAt: new Date() } })
    if (marked.count === 0) continue
    n++
    notifyLocalDeliveryAlert('备餐超时未呼叫骑手', [`订单 ${o.orderNo}`, `已接单超过 ${min} 分钟仍未呼叫骑手`, '请尽快呼叫或自己送'])
  }
  return n
}

/** 顾客取消申请长时间无人处理（每单只推一次） */
export async function remindCancelRequestPending(min = 5): Promise<number> {
  const rows = await prisma.order.findMany({
    where: {
      deliveryType: 'LOCAL', cancelRequestedAt: { lt: ago(min) },
      status: { notIn: ['COMPLETED', 'CANCELLED', 'REFUNDED'] },
      cancelRequestRemindedAt: null,
    },
    take: BATCH, select: { id: true, orderNo: true },
  })
  let n = 0
  for (const o of rows) {
    const marked = await prisma.order.updateMany({ where: { id: o.id, cancelRequestRemindedAt: null }, data: { cancelRequestRemindedAt: new Date() } })
    if (marked.count === 0) continue
    n++
    notifyLocalDeliveryAlert('顾客取消申请待处理', [`订单 ${o.orderNo}`, `取消申请已挂起超过 ${min} 分钟`, '请尽快确认是否取消'])
  }
  return n
}

export async function autoCallRiders(delayMin?: number): Promise<number> {
  const s = await getLocalSettings()
  // 0 = 手动模式（店主默认，D6 拍板）——但这只是「未显式传阈值」时对 settings.autoCallDelayMin 的解读。
  // 生产环境定时器从不传 override（overrides.autoCallDelayMin 恒为 undefined），手动模式在那里就是真正不跑；
  // 管理端/e2e 显式传入的阈值（哪怕是 0）是调用方明确要求的立即执行，语义与其余任务的 `xxxMin:0`
  // 「捕获刚发生的」一致，不受手动模式开关影响。
  if (delayMin === undefined && s.autoCallDelayMin <= 0) return 0
  const delay = delayMin ?? s.autoCallDelayMin
  if (!s.enabled || !isOpenNow(s)) return 0
  if (isCircuitTripped()) return 0
  const orders = await prisma.order.findMany({
    where: {
      deliveryType: 'LOCAL', status: 'PREPARING', cancelRequestedAt: null,
      acceptedAt: { lt: ago(delay) },
      deliveries: { none: { activeOrderId: { not: null } } },
    },
    take: BATCH, select: { id: true },
  })
  let n = 0
  for (const o of orders) {
    try { await callRider({ orderId: o.id, operator: 'scheduler', source: 'SCHEDULER' }); n++ }
    catch { /* callRider 内部已按失败类型落库+告警；这里继续处理下一单 */ }
  }
  return n
}

/**
 * LOCAL 单的自动确认收货兜底：既有 autoCompleteShippedOrders 走 shipment.shippedAt，
 * 而 LOCAL 单永不写 Shipment 行，所以它永远命中不了同城单。若 520 回调丢失，
 * 同城单会永久停在 SHIPPED 无人收尾。这里补一条：SHIPPED 且其配送单已取货超过 N 天 →
 * 订单置 COMPLETED，仍占位的配送单一并置 DELIVERED + 释放。
 */
export async function autoCompleteLocalDelivered(days?: number): Promise<number> {
  const d = days ?? config.order.autoCompleteDays
  const deadline = ago(d * 24 * 60)
  const orders = await prisma.order.findMany({
    where: { deliveryType: 'LOCAL', status: 'SHIPPED' },
    select: {
      id: true,
      deliveries: { orderBy: { createdAt: 'desc' }, take: 1, select: { id: true, pickedUpAt: true, activeOrderId: true } },
    },
    take: BATCH,
  })
  let n = 0
  for (const o of orders) {
    const dlv = o.deliveries[0]
    if (!dlv || !dlv.pickedUpAt || dlv.pickedUpAt >= deadline) continue
    const moved = await prisma.order.updateMany({ where: { id: o.id, status: 'SHIPPED' }, data: { status: 'COMPLETED', completedAt: new Date() } })
    if (moved.count === 0) continue
    if (dlv.activeOrderId !== null) {
      await prisma.delivery.updateMany({ where: { id: dlv.id }, data: { status: 'DELIVERED', deliveredAt: new Date(), activeOrderId: null } })
    }
    n++
  }
  return n
}

export async function housekeepingDelivery(): Promise<number> {
  let n = 0
  const stuck = await prisma.delivery.findMany({ where: { status: { in: [...TERMINAL] }, activeOrderId: { not: null } }, take: BATCH, select: { id: true, deliveryNo: true, status: true } })
  for (const d of stuck) {
    await prisma.delivery.updateMany({ where: { id: d.id }, data: { activeOrderId: null } })
    notifySystemAlert('配送单数据不一致已自愈', [`${d.deliveryNo} 终态 ${DELIVERY_STATUS_LABEL[d.status] ?? d.status} 但仍占位，已释放`], { key: `dlv-housekeeping:${d.id}` })
    n++
  }
  // 陈旧 PENDING：占位行只应存在于一次外呼期间（最长 8 秒超时 + 落库）。超过 10 分钟还是 PENDING，
  // 说明进程在外呼后崩了、或 callRider 的恢复写本身失败（DB 曾不可达）。不扫的话该订单永久不可再呼。
  const stalePending = await prisma.delivery.findMany({ where: { status: 'PENDING', createdAt: { lt: ago(10) } }, take: BATCH, select: { id: true, deliveryNo: true, orderNo: true } })
  for (const d of stalePending) {
    const moved = await prisma.delivery.updateMany({ where: { id: d.id, status: 'PENDING' }, data: { status: 'FAILED', activeOrderId: null, errorCode: 'STALE', failReason: '呼叫未落库（进程中断或数据库异常），已自动释放' } })
    if (moved.count === 0) continue
    notifySystemAlert('配送单占位超时未落库已释放', [`订单 ${d.orderNo}（${d.deliveryNo}）`, '若运力方已产生真实单，请到快递100 后台核对'], { key: `dlv-stale:${d.id}` })
    n++
  }
  n += (await prisma.deliveryEvent.updateMany({
    where: { createdAt: { lt: new Date(Date.now() - 90 * 24 * 3600 * 1000) }, rawPayload: { not: Prisma.DbNull } },
    data: { rawPayload: Prisma.DbNull },
  })).count
  return n
}
