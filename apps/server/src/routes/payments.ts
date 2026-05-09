import { Router, Request, Response, NextFunction } from 'express'
import { z } from 'zod'
import prisma from '../utils/prisma'
import { success } from '../utils/response'
import { AppError } from '../middlewares/error'
import { devUserMiddleware } from '../middlewares/dev-user'

const router = Router()

const mockSuccessSchema = z.object({
  orderNo: z.string().min(1, '请填写订单号'),
})

// POST /api/payments/mock/success
router.post('/mock/success', devUserMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (process.env.MOCK_PAYMENT_ENABLED !== 'true') {
      throw new AppError(40301, 'Mock 支付未开启', 403)
    }

    const { orderNo } = mockSuccessSchema.parse(req.body)
    const userId = req.userId!

    const order = await prisma.order.findFirst({ where: { orderNo, userId } })
    if (!order) throw new AppError(40401, '订单不存在', 404)

    // 幂等：已支付直接返回
    if (order.status === 'PAID') {
      return success(res, { orderNo: order.orderNo, status: 'PAID', paidAt: order.paidAt })
    }

    // 禁止非待付款状态
    if (order.status !== 'PENDING_PAYMENT') {
      throw new AppError(42203, `订单状态错误：当前状态为 ${order.status}，无法支付`)
    }

    const now = new Date()

    await prisma.$transaction([
      prisma.payment.create({
        data: {
          orderId: order.id,
          orderNo: order.orderNo,
          paymentType: 'MOCK',
          amount: order.actualAmount,
          status: 'SUCCESS',
          paidAt: now,
        },
      }),
      prisma.order.update({
        where: { id: order.id },
        data: { status: 'PAID', paidAt: now },
      }),
    ])

    success(res, { orderNo: order.orderNo, status: 'PAID', paidAt: now })
  } catch (e) {
    next(e)
  }
})

export default router
