/**
 * 退款业务公共逻辑：admin 发起退款 与 微信退款回调 共用的状态落库。
 * 全部走事务；order 用 updateMany 条件更新做乐观并发。
 */
import { Prisma } from '@prisma/client'
import prisma from '../utils/prisma'
import { notifyRefundResult } from './order-notify'
import { notifySystemAlert } from './notify'

export const ACTIVE_REFUND_STATUSES = ['PENDING', 'PROCESSING', 'SUCCESS', 'ABNORMAL'] as const

export function buildOutRefundNo(orderId: number): string {
  return `refund_${orderId}_${Date.now()}`
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
 * 退款成功落库：refund→SUCCESS、order REFUNDING→REFUNDED、payment→REFUNDED。
 * 幂等：refund 已 SUCCESS 直接返回；order 非 REFUNDING 不改（如已被人工标记）。
 * 成功后 fire-and-forget 通知。
 */
export async function finalizeRefundSuccess(input: FinalizeInput): Promise<void> {
  const result = await prisma.$transaction(async (tx) => {
    const refund = await tx.refund.findUnique({ where: { id: input.refundId } })
    if (!refund) return null
    if (refund.status === 'SUCCESS') return { refund, alreadyDone: true }

    const data: Prisma.RefundUpdateInput = {
      status: 'SUCCESS',
      successTime: input.successTime ?? new Date(),
      activeOrderId: refund.orderId,
    }
    if (input.wxRefundId) data.wxRefundId = input.wxRefundId
    if (input.channel) data.channel = input.channel
    if (input.rawData) data[input.rawField ?? 'wxNotifyData'] = input.rawData
    if (input.operator) data.operator = input.operator
    const updated = await tx.refund.update({ where: { id: refund.id }, data })

    await tx.order.updateMany({
      where: { id: refund.orderId, status: 'REFUNDING' },
      data: { status: 'REFUNDED', refundedAt: data.successTime as Date },
    })
    await tx.payment.updateMany({
      where: { orderId: refund.orderId },
      data: { status: 'REFUNDED' },
    })
    return { refund: updated, alreadyDone: false }
  })

  if (!result || result.alreadyDone) return
  prisma.order
    .findUnique({ where: { id: result.refund.orderId } })
    .then((order) => {
      if (order) notifyRefundResult(order, result.refund, 'SUCCESS')
    })
    .catch(() => undefined)
}

/** 微信返回 ABNORMAL：退款异常（如用户账户异常），需商户平台手动处理；保留活跃占位防重复发起。 */
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

/** 微信返回 CLOSED：退款关闭（未退成功），释放活跃占位供重试。 */
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

/** 发起阶段失败：释放活跃占位，记录错误。 */
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
