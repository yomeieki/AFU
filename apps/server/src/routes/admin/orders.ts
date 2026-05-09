import { Router, Request, Response, NextFunction } from 'express'
import prisma from '../../utils/prisma'
import { success, paginate } from '../../utils/response'
import { AppError } from '../../middlewares/error'

const router = Router()

// GET /api/admin/orders
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1)
    const pageSize = Math.min(50, Math.max(1, Number(req.query.pageSize) || 20))
    const status = req.query.status as string | undefined
    const orderNo = req.query.orderNo as string | undefined

    const where = {
      ...(status ? { status } : {}),
      ...(orderNo ? { orderNo: { contains: orderNo } } : {}),
    }

    const [list, total] = await prisma.$transaction([
      prisma.order.findMany({
        where,
        select: {
          id: true,
          orderNo: true,
          status: true,
          totalAmount: true,
          shippingFee: true,
          actualAmount: true,
          deliveryType: true,
          receiverName: true,
          receiverPhone: true,
          receiverFullAddress: true,
          paidAt: true,
          createdAt: true,
          items: {
            select: {
              productName: true,
              productImage: true,
              quantity: true,
              productPrice: true,
              subtotal: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.order.count({ where }),
    ])

    paginate(res, list, total, page, pageSize)
  } catch (e) {
    next(e)
  }
})

// GET /api/admin/orders/:id
router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id)
    const order = await prisma.order.findUnique({
      where: { id },
      include: {
        items: true,
        payment: true,
        shipment: true,
        user: { select: { id: true, nickname: true, phone: true } },
      },
    })
    if (!order) throw new AppError(40401, '订单不存在', 404)
    success(res, order)
  } catch (e) {
    next(e)
  }
})

export default router
