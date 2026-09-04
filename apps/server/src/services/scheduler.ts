/**
 * 进程内定时任务（PM2 单实例 fork；多实例时请设 SCHEDULER_DISABLED=true 只留一个跑）。
 * 每 60 秒一轮，各任务互相独立、单独兜错：
 *  1. 待付款超时自动取消（回滚库存 + 微信关单）
 *  2. 已发货 N 天自动确认收货
 *  3. 已付款超 15 分钟未接单 → 企微群催单（每单一次）
 *  4. 低库存推送（每 12 小时最多一次）
 */
import prisma from '../utils/prisma'
import { config } from '../config'
import { rollbackOrderStock } from '../utils/order-stock'
import { closeOrder } from './wechat-pay'
import { notifySystemAlert } from './notify'
import { notifyAcceptReminder, notifyLowStock } from './order-notify'
import { LOW_STOCK_THRESHOLD } from '../utils/constants'
import {
  remindCallTimeout, remindAcceptedStuck, remindDeliveringTimeout, remindUnknownGhost,
  remindLocalUncalled, remindCancelRequestPending, autoCallRiders, autoCompleteLocalDelivered,
  housekeepingDelivery, refreshStaleQuotes,
} from './delivery/tasks'

const TICK_MS = 60 * 1000
const LOW_STOCK_PUSH_INTERVAL_MS = 12 * 60 * 60 * 1000
const BATCH = 100

let running = false
let lastLowStockPushAt = 0

export function startScheduler(): void {
  if (!config.schedulerEnabled) {
    console.log('[scheduler] disabled by SCHEDULER_DISABLED')
    return
  }
  const timer = setInterval(() => {
    void runSchedulerTick()
  }, TICK_MS)
  timer.unref()
  console.log(`[scheduler] started: payTimeout=${config.order.payTimeoutMin}min autoComplete=${config.order.autoCompleteDays}d`)
}

export interface SchedulerOverrides {
  payTimeoutMin?: number
  autoCompleteDays?: number
  remindAfterMin?: number
  callTimeoutMin?: number
  acceptedStuckMin?: number
  deliveringTimeoutMin?: number
  unknownStuckMin?: number
  localUncalledMin?: number
  cancelRequestPendingMin?: number
  autoCallDelayMin?: number
  quoteRefreshMin?: number
}

/** 跑一轮；可由非生产环境的 /admin/system/run-scheduler 手动触发（e2e 用，可传阈值覆盖） */
export async function runSchedulerTick(overrides: SchedulerOverrides = {}): Promise<Record<string, number>> {
  if (running) return {}
  running = true
  const stats: Record<string, number> = {}
  const tasks: [string, () => Promise<number>][] = [
    ['cancelExpired', () => cancelExpiredOrders(overrides.payTimeoutMin)],
    ['autoComplete', () => autoCompleteShippedOrders(overrides.autoCompleteDays)],
    ['remindUnaccepted', () => remindUnacceptedOrders(overrides.remindAfterMin)],
    ['lowStock', pushLowStock],
    ['localCallTimeout', () => remindCallTimeout(overrides.callTimeoutMin)],
    ['localAcceptedStuck', () => remindAcceptedStuck(overrides.acceptedStuckMin)],
    ['localDelivering', () => remindDeliveringTimeout(overrides.deliveringTimeoutMin)],
    ['localUnknown', () => remindUnknownGhost(overrides.unknownStuckMin)],
    ['localUncalled', () => remindLocalUncalled(overrides.localUncalledMin)],
    ['localCancelReq', () => remindCancelRequestPending(overrides.cancelRequestPendingMin)],
    ['localQuoteRefresh', () => refreshStaleQuotes(overrides.quoteRefreshMin)],
    ['localAutoCall', () => autoCallRiders(overrides.autoCallDelayMin)],
    ['localAutoComplete', () => autoCompleteLocalDelivered(overrides.autoCompleteDays)],
    ['localHousekeeping', housekeepingDelivery],
  ]
  try {
    for (const [name, fn] of tasks) {
      try {
        stats[name] = await fn()
      } catch (e) {
        console.error(`[scheduler] ${name} failed:`, e)
        notifySystemAlert(`定时任务 ${name} 失败`, [(e as Error).message], { key: `scheduler:${name}` })
      }
    }
  } finally {
    running = false
  }
  return stats
}

/** 待付款超时 → CANCELLED + 回滚库存 + best-effort 微信关单 */
export async function cancelExpiredOrders(timeoutMin = config.order.payTimeoutMin): Promise<number> {
  const deadline = new Date(Date.now() - timeoutMin * 60 * 1000)
  const expired = await prisma.order.findMany({
    where: { status: 'PENDING_PAYMENT', createdAt: { lt: deadline } },
    include: { items: true, payment: { select: { outTradeNo: true, paymentType: true } } },
    take: BATCH,
    orderBy: { createdAt: 'asc' },
  })
  let count = 0
  for (const order of expired) {
    const cancelled = await prisma.$transaction(async (tx) => {
      const moved = await tx.order.updateMany({
        where: { id: order.id, status: 'PENDING_PAYMENT' },
        data: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: '超时未支付，系统自动取消' },
      })
      if (moved.count === 0) return false
      await rollbackOrderStock(tx, order.items)
      return true
    })
    if (!cancelled) continue
    count++
    if (!config.mock.pay && order.payment?.paymentType === 'WECHAT' && order.payment.outTradeNo) {
      void closeOrder(order.payment.outTradeNo)
    }
  }
  if (count > 0) console.log(`[scheduler] 超时取消 ${count} 单`)
  return count
}

/** 已发货超 N 天 → COMPLETED（顾客仍可申请售后） */
export async function autoCompleteShippedOrders(days = config.order.autoCompleteDays): Promise<number> {
  const deadline = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
  const due = await prisma.order.findMany({
    where: { status: 'SHIPPED', shipment: { shippedAt: { lt: deadline } } },
    select: { id: true },
    take: BATCH,
  })
  let count = 0
  for (const { id } of due) {
    const moved = await prisma.order.updateMany({
      where: { id, status: 'SHIPPED' },
      data: { status: 'COMPLETED', completedAt: new Date() },
    })
    count += moved.count
  }
  if (count > 0) console.log(`[scheduler] 自动确认收货 ${count} 单`)
  return count
}

/** 已付款超时未接单 → 企微群催单（每单只催一次，acceptRemindedAt 记录） */
export const ACCEPT_REMIND_AFTER_MIN = 15
export async function remindUnacceptedOrders(afterMin = ACCEPT_REMIND_AFTER_MIN): Promise<number> {
  const deadline = new Date(Date.now() - afterMin * 60 * 1000)
  const stale = await prisma.order.findMany({
    where: { status: 'PAID', acceptRemindedAt: null, paidAt: { lt: deadline } },
    select: { id: true, orderNo: true, actualAmount: true, receiverName: true, receiverPhone: true, paidAt: true },
    take: BATCH,
    orderBy: { paidAt: 'asc' },
  })
  if (stale.length === 0) return 0
  await prisma.order.updateMany({
    where: { id: { in: stale.map((o) => o.id) } },
    data: { acceptRemindedAt: new Date() },
  })
  notifyAcceptReminder(stale)
  return stale.length
}

/** 低库存推送：上架且 stock ≤ 阈值，每 12 小时最多一次；无低库存则不发 */
export async function pushLowStock(): Promise<number> {
  if (Date.now() - lastLowStockPushAt < LOW_STOCK_PUSH_INTERVAL_MS) return 0
  const low = await prisma.product.findMany({
    where: { deletedAt: null, status: 'ON_SHELF', stock: { lte: LOW_STOCK_THRESHOLD } },
    select: { name: true, stock: true },
    orderBy: { stock: 'asc' },
    take: 30,
  })
  lastLowStockPushAt = Date.now()
  if (low.length === 0) return 0
  notifyLowStock(low, LOW_STOCK_THRESHOLD)
  return low.length
}
