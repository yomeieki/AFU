/**
 * 进程内定时任务（PM2 单实例 fork；多实例时请设 SCHEDULER_DISABLED=true 只留一个跑）。
 * 每 60 秒一轮，各任务互相独立、单独兜错：
 *  1. 待付款超时自动取消（回滚库存 + 微信关单）
 *  2. 已发货 N 天自动确认收货
 *  3. 已付款超 15 分钟未接单 → 企微群催单（每单一次）
 *  4. 低库存推送（每 12 小时最多一次）
 *  ……（同城配送相关任务见各自注释）
 *  + 出票三任务（规格 §8b，M2b 接入）：printQueueSweep 兜扫队列 / repeatAnnounce 未接单重复播报 /
 *    printerHealth 打印机离线-恢复告警与补打，实现在 services/ticket/index.ts。
 */
import prisma from '../utils/prisma'
import { config } from '../config'
import { rollbackOrderStock } from '../utils/order-stock'
import { releaseOrderBenefits } from './member/checkout'
import { closeOrder } from './wechat-pay'
import { notifySystemAlert } from './notify'
import { notifyAcceptReminder, notifyLowStock } from './order-notify'
import { LOW_STOCK_THRESHOLD } from '../utils/constants'
import {
  remindCallTimeout, remindAcceptedStuck, remindDeliveringTimeout, remindUnknownGhost,
  remindLocalUncalled, remindCancelRequestPending, autoRejectStaleCancelRequests, autoCallRiders, autoCompleteLocalDelivered,
  housekeepingDelivery, refreshStaleQuotes, escalateSoloCalls,
} from './delivery/tasks'
import { remindExpressUnaccepted, remindExpressUnpicked, reconcileExpressUnknown } from './delivery/express-booking-tasks'
import {
  processQueue as printQueueSweep, repeatAnnounce as printRepeatAnnounce, printerHealthTask,
} from './ticket'
import { settlePoints, expirePointsBatch } from './member/points'
import { expireCouponsBatch } from './member/coupons'
import { getMemberSettings } from './member/settings'
import { getCronState, patchCronState, isSameLocalDay } from './member/cron-state'

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
  // 取消申请自动驳回的阈值（分钟，从**接单**起算）。不传则用设置里的 acceptGraceMin——
  // 「甲」口径下这两条线必须是同一个值，这里只为 e2e 能立刻命中而留的覆盖口。
  cancelAutoRejectMin?: number
  autoCallDelayMin?: number
  quoteRefreshMin?: number
  // 只呼最低价 → 并呼的升级门槛（分钟）。0 = 不自动升级。e2e 传 0 是「关掉」而不是「立刻升级」，
  // 所以要立刻命中得传 0.01（600 毫秒），与 autoCallDelayMin 同一套约定。
  escalateAfterMin?: number
  // 会员积分/优惠券（M1）：settleMissedPoints 下界（默认 2 分钟前，防止扫到还没跑完 confirm
  // 钩子那一瞬间的单）；e2e 要验证「漏挂钩子 2 分钟后被兜底任务补发」等不到 2 分钟，传 0 绕过。
  settleMissedPointsAfterMin?: number
  // expirePoints / expireCoupons 两个「每日一次」任务的日切判定，e2e 传 true 绕过，
  // 否则一天之内重复调用 run-scheduler 只有第一次真的会执行。
  forceDailyMemberTasks?: boolean
  // H9：expirePointsBatch/expireCouponsBatch 每轮最多处理的行数，默认 200。滚动续期让一个用户
  // 的全部在世行共用同一个到期日，到期那一刻可能一次产生远超 200 行的候选——runMemberDailyTask
  // 现在会循环调用直到某轮返回 < limit 才收工，e2e 传小值（如 2）来让「一次到期一大批」在几行
  // 数据上就能复现，不用真的插 200+ 行。
  dailyTaskBatchLimit?: number
  // 邮寄取件预约三条兜底任务的阈值覆盖，语义同各自函数的默认参数（不传则读 express settings）。
  expressUnacceptedHours?: number
  expressUnpickedMin?: number
  expressUnknownMin?: number
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
    // 只呼最低价的单等太久 → 取消重呼并呼。排在 localAutoCall 之前：升级会先撤单再建新单，
    // 中间那一瞬订单是「PREPARING 且无在途单」，正好是 autoCallRiders 的候选条件——
    // 让升级在同一轮里先把 D-2 建起来，autoCallRiders 扫到时该单已有在途单，不会重复呼。
    ['localEscalate', () => escalateSoloCalls(overrides.escalateAfterMin)],
    ['localAcceptedStuck', () => remindAcceptedStuck(overrides.acceptedStuckMin)],
    ['localDelivering', () => remindDeliveringTimeout(overrides.deliveringTimeoutMin)],
    ['localUnknown', () => remindUnknownGhost(overrides.unknownStuckMin)],
    ['localUncalled', () => remindLocalUncalled(overrides.localUncalledMin)],
    ['localCancelReq', () => remindCancelRequestPending(overrides.cancelRequestPendingMin)],
    // 取消申请超时自动驳回。**必须排在 localAutoCall 之前**：驳回会解除对「呼叫骑手」的拦截，
    // 同一轮里让自动呼叫立刻能接上，而不是白等一分钟。
    ['localCancelAutoReject', () => autoRejectStaleCancelRequests(overrides.cancelAutoRejectMin)],
    ['localQuoteRefresh', () => refreshStaleQuotes(overrides.quoteRefreshMin)],
    ['localAutoCall', () => autoCallRiders(overrides.autoCallDelayMin)],
    ['localAutoComplete', () => autoCompleteLocalDelivered(overrides.autoCompleteDays)],
    ['localHousekeeping', housekeepingDelivery],
    ['expressUnknownReconcile', () => reconcileExpressUnknown(overrides.expressUnknownMin)],
    ['expressUnaccepted', () => remindExpressUnaccepted(overrides.expressUnacceptedHours)],
    ['expressUnpicked', () => remindExpressUnpicked(overrides.expressUnpickedMin)],
    // 出票三任务（规格 §8b）：兜扫 PENDING/SENT 队列、未接单重复播报、打印机健康（离线/异常告警+恢复补打）。
    // 三者各自读 Setting(key=printer) 的开关/阈值（enabled/repeat.*/offlineAlertMin），不经 overrides——
    // 与其余任务不同，出票没有「联调时需要临时调阈值」的诉求：e2e 改阈值走 PUT /admin/settings/printer
    // 就够了，不需要在 run-scheduler 的 SchedulerOverrides 里再开一条平行的配置通道。
    ['printQueueSweep', () => printQueueSweep().then((r) => r.retried + r.confirmed)],
    ['repeatAnnounce', () => printRepeatAnnounce().then((r) => r.announced + r.exhausted)],
    ['printerHealth', () => printerHealthTask().then((r) => r.alerted + r.recovered + r.backfilled)],
    // 会员积分/优惠券（M1，见 docs/superpowers/plans/2026-09-04-member-m1-ledger.md Task 6）
    ['settleMissedPoints', () => settleMissedPoints(overrides.settleMissedPointsAfterMin)],
    ['expirePoints', () => runMemberDailyTask('lastExpirePointsAt', expirePointsBatch, overrides.forceDailyMemberTasks, overrides.dailyTaskBatchLimit)],
    ['expireCoupons', () => runMemberDailyTask('lastExpireCouponsAt', expireCouponsBatch, overrides.forceDailyMemberTasks, overrides.dailyTaskBatchLimit)],
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
      // 未支付取消：把券与赠品积分还回去（spec §5.5）。四条 PENDING_PAYMENT → CANCELLED
      // 路径共用同一个模式：状态翻转判 count 成功 → 回滚库存 → 释放优惠。
      await releaseOrderBenefits(tx, order)
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

// ─────────────────────────────────────────────────────────
// 会员积分/优惠券（M1）
// ─────────────────────────────────────────────────────────

/**
 * 兜底：扫漏挂积分发放钩子的订单（COMPLETED 有多条路径，钩子只是加速，正确性靠这个任务保证）。
 * 严格按 spec §5.4：下界 7 天避免开关从关到开时突然给历史全量订单补发（也避免关闭期间积压的
 * 订单被无限扫描）；上界默认 2 分钟避免扫到 confirm 钩子还没来得及自己 settlePoints 完的单
 * （几率很小，但两处都在写同一行，让钩子有个窗口领先更干净）。
 */
const SETTLE_MISSED_POINTS_AFTER_MIN = 2
const SETTLE_MISSED_POINTS_WINDOW_DAYS = 7
export async function settleMissedPoints(afterMin = SETTLE_MISSED_POINTS_AFTER_MIN): Promise<number> {
  const settings = await getMemberSettings()
  if (!settings.points.enabled) return 0
  const now = Date.now()
  const upper = new Date(now - afterMin * 60 * 1000)
  const lower = new Date(now - SETTLE_MISSED_POINTS_WINDOW_DAYS * 24 * 60 * 60 * 1000)
  const due = await prisma.order.findMany({
    where: { status: 'COMPLETED', pointsSettledAt: null, isTest: false, completedAt: { gte: lower, lte: upper } },
    select: { id: true },
    take: BATCH,
    orderBy: { completedAt: 'asc' },
  })
  for (const { id } of due) await settlePoints(id)
  return due.length
}

// H9：滚动续期让一个用户的全部在世行共用同一个到期日——到期那一刻可能一次产生远超单批上限的
// 候选行，一轮只跑一批就记账收工的话，其余候选要等到明天才轮到，而明天的新到期用户又会占满
// 当天配额，形成「先到的吃满、后到的排队」。DAILY_TASK_MAX_ROUNDS 只是防止「每轮都选中同一批
// 处理失败/被并发抢跑的坏行」时空转到死（expirePointsBatch/expireCouponsBatch 对单行异常是
// catch 后不计入返回值，真坏行会让某轮返回 0 提前退出；这里的上限只兜住「返回值恰好等于
// limit 但每轮都是同一批」这种更极端的情况，50 轮 × 200/批 = 1 万行，一天封顶足够）。
const DEFAULT_DAILY_TASK_BATCH_LIMIT = 200
const DAILY_TASK_MAX_ROUNDS = 50

/**
 * expirePoints / expireCoupons 共用的「每日一次」执行判定：上次记录的执行日与今天不同才跑，
 * 全部批次跑完才记录本次时间（不是跑一批就记）。force=true（e2e）时无视日切直接跑。
 *
 * R6：退出条件必须按 scanned（候选条数）跟 limit 比，不能按 processed（真正处理成功条数）——
 * expirePointsBatch/expireCouponsBatch 对单行的 CAS 失手（M13 的 expiresAt 复核命中「被
 * extendLivePoints 续期救回来」）、remaining<=0、单行抛错被 catch，都会让 processed < scanned
 * 而候选其实已经扫满一批。旧写法按 result(=processed) < limit 判断，600 行候选里哪怕只有 1 个
 * 用户在任务运行期间下单触发续期，这一轮就会算出 199 < 200 提前 break，把剩下 400 行留到明天，
 * H9 想解决的「一天只清一批」问题原样保留。
 */
async function runMemberDailyTask(
  field: 'lastExpirePointsAt' | 'lastExpireCouponsAt',
  fn: (limit: number) => Promise<{ scanned: number; processed: number }>,
  force = false,
  batchLimit?: number
): Promise<number> {
  const now = new Date()
  if (!force) {
    const state = await getCronState()
    const last = state[field]
    if (last && isSameLocalDay(new Date(last), now)) return 0
  }
  const limit = batchLimit && batchLimit > 0 ? batchLimit : DEFAULT_DAILY_TASK_BATCH_LIMIT
  let total = 0
  for (let round = 0; round < DAILY_TASK_MAX_ROUNDS; round++) {
    const { scanned, processed } = await fn(limit)
    total += processed
    if (scanned < limit) break // 候选没扫满一批，说明候选已经处理完（不是「处理成功条数」<limit）
  }
  await patchCronState({ [field]: now.toISOString() })
  return total
}
