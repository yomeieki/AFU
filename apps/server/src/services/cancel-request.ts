import prisma from '../utils/prisma'
import { AppError } from '../middlewares/error'
import { cancelBooking, getActiveBooking } from './delivery/express-booking'
import { initiateRefund, remainingRefundable } from './refund'

/** 驳回顾客取消申请：清四列标记 + 留驳回痕迹。同城与邮寄共用（从 routes/admin/delivery.ts 搬来，去掉渠道限制） */
export async function rejectCancelRequest(orderId: number, by: 'MANUAL' | 'AUTO') {
  const target = await prisma.order.findUnique({ where: { id: orderId }, select: { status: true, cancelRequestedAt: true } })
  if (!target) throw new AppError(40401, '订单不存在', 404)
  // 终态/退款中的单上这个标记只是历史痕迹（徽标口径同 workbench.ts），不该再被「驳回」改写
  const moved = await prisma.order.updateMany({
    where: { id: orderId, cancelRequestedAt: { not: null }, status: { notIn: ['COMPLETED', 'CANCELLED', 'REFUNDED', 'REFUNDING'] } },
    data: { cancelRequestedAt: null, cancelRequestNote: null, cancelRequestDeliveryStatus: null, cancelRequestRemindedAt: null, cancelRequestRejectedAt: new Date(), cancelRequestRejectedBy: by },
  })
  if (moved.count === 0) throw new AppError(42204, target.cancelRequestedAt ? `订单状态为 ${target.status}，取消申请已无需处理` : '该订单没有待处理的取消申请')
  return prisma.order.findUniqueOrThrow({ where: { id: orderId } })
}

/** 同意邮寄单的取消申请：先取消预约（有的话），成功再全额退款。第一步失败不进第二步。 */
export async function approveExpressCancelRequest(i: { orderId: number; operator: string }) {
  const order = await prisma.order.findUnique({ where: { id: i.orderId } })
  if (!order) throw new AppError(40401, '订单不存在', 404)
  if (order.deliveryType !== 'EXPRESS') throw new AppError(42204, '仅邮寄订单')
  if (!order.cancelRequestedAt) throw new AppError(42204, '该订单没有待处理的取消申请')
  if (await getActiveBooking(i.orderId)) await cancelBooking({ orderId: i.orderId, operator: i.operator, by: 'CUSTOMER' })
  return initiateRefund({ orderId: i.orderId, amount: remainingRefundable(order), reason: '顾客申请取消', operator: i.operator })
}
