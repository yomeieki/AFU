/**
 * 退款业务公共逻辑：发起退款（admin 一键退款 / 售后审核 / 迟到支付自动退款共用）
 * 与 退款结果落库（同步返回 / 微信回调共用）。
 *
 * 金额规则：
 *  - 可退余额 remaining = order.actualAmount - order.refundedAmount
 *  - 0 < amount <= remaining；amount === remaining 视为「全额」（订单取消/退款流程），否则为「部分」（订单状态不变）
 *  - 同一订单同一时刻只能有一笔在途退款（Refund.activeOrderId 唯一索引），成功后释放，可再发起部分退款
 */
import { Prisma, Order, Refund } from '@prisma/client'
import prisma from '../utils/prisma'
import { AppError } from '../middlewares/error'
import { config } from '../config'
import { rollbackOrderStock } from '../utils/order-stock'
import { createRefund, getRefundNotifyUrl, validatePayConfig, WechatRefundError } from './wechat-pay'
import { notifyRefundResult } from './order-notify'
import { notifySystemAlert } from './notify'
import { sendRefundSubscribeMessage } from './subscribe-message'
import { DELIVERY_STATUS_LABEL } from './delivery/state'

/** 在途态：占用 activeOrderId，阻止同一订单并发发起 */
export const ACTIVE_REFUND_STATUSES = ['PENDING', 'PROCESSING', 'ABNORMAL'] as const

export function buildOutRefundNo(orderId: number): string {
  return `refund_${orderId}_${Date.now()}`
}

export function remainingRefundable(order: { actualAmount: number; refundedAmount: number }): number {
  return Math.max(0, order.actualAmount - order.refundedAmount)
}

/** 未出库态：全额退款时要把库存加回去 */
const STOCK_HELD_STATUSES = ['PAID', 'PREPARING'] as const
/** 已出库态：全额退款不回滚库存（货已交快递/已签收） */
const STOCK_RELEASED_STATUSES = ['SHIPPED', 'COMPLETED'] as const
/** 全额退款可进入的订单状态（REFUNDING 仅允许全额重试） */
const REFUNDABLE_STATUSES = [...STOCK_HELD_STATUSES, ...STOCK_RELEASED_STATUSES] as const

export interface InitiateRefundInput {
  orderId: number
  /** 本次退款金额（分） */
  amount: number
  reason?: string
  /** 记录到 Refund.operator：后台账号名 / 'system' */
  operator?: string
  afterSaleId?: number
}

export interface InitiateRefundResult {
  order: Order
  refund: Refund
  mode: 'mock' | 'wechat'
  isFull: boolean
}

/**
 * 发起退款。抛 AppError（校验失败）或在微信发起失败时抛 AppError(50201)（退款单已标 FAILED，可重试）。
 */
export async function initiateRefund(input: InitiateRefundInput): Promise<InitiateRefundResult> {
  const { orderId, amount, reason, operator, afterSaleId } = input
  if (!Number.isInteger(amount) || amount <= 0) throw new AppError(42206, '退款金额必须为正整数（分）')

  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { items: true, payment: true, refunds: true },
  })
  if (!order) throw new AppError(40401, '订单不存在', 404)

  const remaining = remainingRefundable(order)
  if (remaining <= 0) throw new AppError(42206, '该订单已全额退款')
  if (amount > remaining) {
    throw new AppError(42206, `退款金额超过可退余额 ¥${(remaining / 100).toFixed(2)}`)
  }
  const isFull = amount === remaining

  const fromRefunding = order.status === 'REFUNDING'
  if (fromRefunding && !isFull) throw new AppError(42204, '退款中的订单只能全额退款')
  if (!fromRefunding && !(REFUNDABLE_STATUSES as readonly string[]).includes(order.status)) {
    throw new AppError(42204, `订单状态为 ${order.status}，不可退款`)
  }
  if (order.refunds.some((r) => (ACTIVE_REFUND_STATUSES as readonly string[]).includes(r.status))) {
    throw new AppError(42205, '该订单已有退款处理中')
  }
  // 42221：同城单有在途配送单先取消配送再退款（骑手在路上把钱退了 = 白送一单）。
  // 一处拦截覆盖全部 4 个 initiateRefund 调用点（admin 退款/顾客取消/售后同意/拒单）。
  if (order.deliveryType === 'LOCAL' && !['COMPLETED', 'REFUNDED'].includes(order.status)) {
    const activeDelivery = await prisma.delivery.findFirst({ where: { activeOrderId: orderId }, select: { status: true } })
    if (activeDelivery) {
      throw new AppError(42221, `该订单有在途配送单（${DELIVERY_STATUS_LABEL[activeDelivery.status] ?? activeDelivery.status}），请先取消配送再退款`)
    }
  }
  if (!order.payment || order.payment.status !== 'SUCCESS') {
    throw new AppError(42207, '订单无成功支付记录，无法退款')
  }
  const mode = config.mock.pay ? 'MOCK' : 'WECHAT'
  if (mode === 'WECHAT' && (order.payment.paymentType === 'MOCK' || !order.payment.outTradeNo)) {
    throw new AppError(42207, '模拟支付订单无法发起微信退款')
  }

  // 事务 A：（全额）状态流转 + 库存回滚 + 创建退款记录（不含外呼）
  const refund = await prisma.$transaction(async (tx) => {
    if (isFull && !fromRefunding) {
      // where 里加 deliveries:{none:{activeOrderId:{not:null}}}：这是 callRider 那侧原子复核的另一半。
      // :82-87 的 42221 检查只是这段事务之外的快照，几毫秒内可能被 callRider 的 delivery.create 抢先——
      // 那笔创建会立刻占住 activeOrderId，让这里的 updateMany 天然匹配不上，两侧不可能同时得手。
      const guard = { id: orderId, deliveries: { none: { activeOrderId: { not: null } } } }
      const toRefunding: Prisma.OrderUpdateManyMutationInput = {
        status: 'REFUNDING',
        cancelledAt: new Date(),
        cancelReason: reason || '商家退款',
      }
      // 「要不要回滚库存」的判据必须来自这次 updateMany 真正命中的状态，而不是 :59 事务外读到的
      // order.status——那只是快照，另一位店员在这几十毫秒里点了发货，SHIPPED 照样落在白名单里被改成
      // REFUNDING，拿旧快照判断就会把已经交给快递的货再加回库存，后面按虚增库存接单就是超卖。
      // 所以分两步条件写：先按未出库态试，命中才回滚；没命中再按已出库态试，命中就不回滚。
      let moved = await tx.order.updateMany({ where: { ...guard, status: { in: [...STOCK_HELD_STATUSES] } }, data: toRefunding })
      if (moved.count === 1) {
        await rollbackOrderStock(tx, order.items)
      } else {
        moved = await tx.order.updateMany({ where: { ...guard, status: { in: [...STOCK_RELEASED_STATUSES] } }, data: toRefunding })
      }
      if (moved.count === 0) {
        // count 为 0 有两种原因，对店员的下一步动作完全不同，必须分辨清楚：
        // 状态已经变了（正常并发），或者有在途配送单刚刚抢先落库（呼叫骑手/自己送）。
        // 后一种情况文案要照抄 :85 的 42221 语义——引导店员先去取消配送，而不是简单地「刷新重试」。
        const activeDelivery = await tx.delivery.findFirst({ where: { activeOrderId: orderId }, select: { status: true } })
        if (activeDelivery) {
          throw new AppError(42221, `该订单有在途配送单（${DELIVERY_STATUS_LABEL[activeDelivery.status] ?? activeDelivery.status}），请先取消配送再退款`)
        }
        throw new AppError(42204, '订单状态已变化，请刷新后重试')
      }
    }
    try {
      return await tx.refund.create({
        data: {
          orderId,
          orderNo: order.orderNo,
          outTradeNo: order.payment!.outTradeNo,
          outRefundNo: buildOutRefundNo(orderId),
          amount,
          totalAmount: order.actualAmount,
          status: 'PENDING',
          mode,
          reason: reason ? reason.slice(0, 80) : null,
          operator: operator ?? null,
          afterSaleId: afterSaleId ?? null,
          activeOrderId: orderId,
        },
      })
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new AppError(42205, '该订单已有退款处理中')
      }
      throw e
    }
  })

  if (mode === 'MOCK') {
    await finalizeRefundSuccess({ refundId: refund.id, operator })
    return { ...(await reload(orderId, refund.id)), mode: 'mock', isFull }
  }

  validatePayConfig()
  try {
    const result = await createRefund({
      outTradeNo: order.payment.outTradeNo!,
      outRefundNo: refund.outRefundNo,
      amount,
      total: order.actualAmount,
      reason: reason || undefined,
      notifyUrl: getRefundNotifyUrl(),
    })
    // 同步返回 SUCCESS 时这里只预写 PROCESSING，不能直接写 SUCCESS：
    // finalizeRefundSuccess 的幂等守卫正是「已 SUCCESS 就当做过了」，先写 SUCCESS 再调它，
    // 首次落库就会被自己短路——钱退了，refundedAmount/订单/售后一样都不更新，且回调也不会再补。
    // SUCCESS 只允许由 finalizeRefundSuccess 一处写入。
    await prisma.refund.update({
      where: { id: refund.id },
      data: {
        wxRefundId: result.refund_id,
        status: result.status === 'SUCCESS' ? 'PROCESSING' : result.status,
        channel: result.channel ?? null,
        wxResponseData: JSON.stringify(result),
      },
    })
    if (result.status === 'SUCCESS') {
      await finalizeRefundSuccess({
        refundId: refund.id,
        wxRefundId: result.refund_id,
        successTime: result.success_time ? new Date(result.success_time) : new Date(),
        channel: result.channel,
      })
    } else if (result.status === 'ABNORMAL') {
      await markRefundAbnormal(refund.id)
    } else if (result.status === 'CLOSED') {
      await markRefundClosed(refund.id)
    }
  } catch (e) {
    const code = e instanceof WechatRefundError ? e.code : 'REQUEST_ERROR'
    const message = (e as Error).message || '微信退款请求失败'
    await markRefundFailed(refund.id, code, message)
    // 全额：订单保持 REFUNDING（库存已回滚、商家已决定退），后台可重试；部分：订单未变，可重新发起
    throw new AppError(50201, `微信退款发起失败：${message}`, 502)
  }

  return { ...(await reload(orderId, refund.id)), mode: 'wechat', isFull }
}

async function reload(orderId: number, refundId: number): Promise<{ order: Order; refund: Refund }> {
  const [order, refund] = await Promise.all([
    prisma.order.findUniqueOrThrow({ where: { id: orderId } }),
    prisma.refund.findUniqueOrThrow({ where: { id: refundId } }),
  ])
  return { order, refund }
}

interface FinalizeInput {
  refundId: number
  wxRefundId?: string | null
  successTime?: Date | null
  channel?: string | null
  rawData?: string | null
  rawField?: 'wxResponseData' | 'wxNotifyData'
  operator?: string
}

/**
 * 退款成功落库：refund→SUCCESS（释放 activeOrderId）、order.refundedAmount 累加；
 * 累计退完全款时 order REFUNDING→REFUNDED、payment→REFUNDED；关联售后单→DONE。
 * 幂等：非 SUCCESS→SUCCESS 用条件写 + count 判定，只有翻转成功的那一次才做后续副作用。
 * 成功后 fire-and-forget 通知员工 + 顾客订阅消息。
 */
export async function finalizeRefundSuccess(input: FinalizeInput): Promise<void> {
  const result = await prisma.$transaction(async (tx) => {
    const refund = await tx.refund.findUnique({ where: { id: input.refundId } })
    if (!refund) return null

    const successTime = input.successTime ?? new Date()
    const data: Prisma.RefundUpdateManyMutationInput = {
      status: 'SUCCESS',
      successTime,
      activeOrderId: null,
    }
    if (input.wxRefundId) data.wxRefundId = input.wxRefundId
    if (input.channel) data.channel = input.channel
    if (input.rawData) data[input.rawField ?? 'wxNotifyData'] = input.rawData
    if (input.operator) data.operator = input.operator
    // 上面那次 findUnique 在 MySQL RR 下是快照读、不加锁，不能拿它做幂等依据：
    // 微信回调重推 / 回调与人工标记撞车时两边都会读到「未成功」，各自 increment 一次 refundedAmount。
    // 改成条件写：同一行只有一个调用能把 status 从非 SUCCESS 翻成 SUCCESS，输掉的那个 count=0 直接退出。
    const moved = await tx.refund.updateMany({ where: { id: refund.id, status: { not: 'SUCCESS' } }, data })
    if (moved.count === 0) return { refund, alreadyDone: true }
    const updated = await tx.refund.findUniqueOrThrow({ where: { id: refund.id } })

    const order = await tx.order.update({
      where: { id: refund.orderId },
      data: { refundedAmount: { increment: refund.amount } },
    })
    if (order.refundedAmount >= order.actualAmount) {
      await tx.order.updateMany({
        where: { id: refund.orderId, status: 'REFUNDING' },
        data: { status: 'REFUNDED', refundedAt: successTime },
      })
      await tx.payment.updateMany({
        where: { orderId: refund.orderId },
        data: { status: 'REFUNDED' },
      })
    }
    if (refund.afterSaleId) {
      await tx.afterSale.updateMany({
        where: { id: refund.afterSaleId, status: { in: ['PENDING', 'APPROVED'] } },
        data: { status: 'DONE', refundId: refund.id, handledAt: new Date() },
      })
    }
    return { refund: updated, alreadyDone: false }
  })

  if (!result || result.alreadyDone) return
  prisma.order
    .findUnique({
      where: { id: result.refund.orderId },
      include: { user: { select: { openid: true } }, items: { select: { productName: true }, take: 1 } },
    })
    .then((order) => {
      if (!order) return
      notifyRefundResult(order, result.refund, 'SUCCESS')
      sendRefundSubscribeMessage(order.user.openid, order, result.refund, order.items[0]?.productName)
    })
    .catch(() => undefined)
}

/** 微信返回 ABNORMAL：退款异常（如用户账户异常），需商户平台手动处理；保留在途占位防重复发起。 */
export async function markRefundAbnormal(refundId: number, rawData?: string): Promise<void> {
  const refund = await prisma.refund.update({
    where: { id: refundId },
    data: { status: 'ABNORMAL', ...(rawData ? { wxNotifyData: rawData } : {}) },
  })
  const order = await prisma.order.findUnique({ where: { id: refund.orderId } })
  if (order) notifyRefundResult(order, refund, 'ABNORMAL')
  notifySystemAlert('微信退款异常', [`订单 ${refund.orderNo}`, `退款单 ${refund.outRefundNo}`, '需到微信商户平台手动处理'], {
    key: `refund-abnormal:${refund.id}`,
  })
}

/** 微信返回 CLOSED：退款关闭（未退成功），释放在途占位供重试。 */
export async function markRefundClosed(refundId: number, rawData?: string): Promise<void> {
  const refund = await prisma.refund.update({
    where: { id: refundId },
    data: { status: 'CLOSED', activeOrderId: null, ...(rawData ? { wxNotifyData: rawData } : {}) },
  })
  const order = await prisma.order.findUnique({ where: { id: refund.orderId } })
  if (order) notifyRefundResult(order, refund, 'CLOSED')
  notifySystemAlert('微信退款已关闭', [`订单 ${refund.orderNo}`, `退款单 ${refund.outRefundNo}`, '可在后台重试退款'], {
    key: `refund-closed:${refund.id}`,
  })
}

/** 发起阶段失败：释放在途占位，记录错误。 */
export async function markRefundFailed(refundId: number, errorCode: string, errorMessage: string): Promise<void> {
  const refund = await prisma.refund.update({
    where: { id: refundId },
    data: {
      status: 'FAILED',
      activeOrderId: null,
      errorCode: errorCode.slice(0, 64),
      errorMessage: errorMessage.slice(0, 255),
    },
  })
  notifySystemAlert('微信退款发起失败', [`订单 ${refund.orderNo}`, `金额 ¥${(refund.amount / 100).toFixed(2)}`, `${errorCode}: ${errorMessage}`], {
    key: `refund-failed:${refund.orderId}`,
  })
}
