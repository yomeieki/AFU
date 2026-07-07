import { Router, Request, Response, NextFunction } from 'express'
import { z } from 'zod'
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
          shipment: {
            select: {
              id: true,
              orderId: true,
              expressCompany: true,
              expressNo: true,
              shippedAt: true,
              remark: true,
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

// POST /api/admin/orders/:id/ship — 发货（仅 PAID 订单）
const shipSchema = z.object({
  expressCompany: z.string().min(1, '请填写快递公司').max(64),
  expressNo: z.string().min(1, '请填写快递单号').max(64),
  remark: z.string().max(255).optional(),
})

router.post('/:id/ship', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id)
    const { expressCompany, expressNo, remark } = shipSchema.parse(req.body)

    const order = await prisma.order.findUnique({ where: { id } })
    if (!order) throw new AppError(40401, '订单不存在', 404)
    if (order.status !== 'PAID') {
      throw new AppError(42204, `订单状态为 ${order.status}，仅已付款订单可发货`)
    }

    const shippedAt = new Date()
    const result = await prisma.$transaction(async (tx) => {
      const shipment = await tx.shipment.upsert({
        where: { orderId: id },
        update: { expressCompany, expressNo, remark, shippedAt },
        create: {
          orderId: id,
          orderNo: order.orderNo,
          deliveryType: order.deliveryType,
          expressCompany,
          expressNo,
          remark,
          shippedAt,
        },
      })
      // 发货时间记录在 Shipment.shippedAt，Order 仅流转状态
      const updated = await tx.order.update({
        where: { id },
        data: { status: 'SHIPPED' },
      })
      return { shipment, order: updated }
    })

    success(res, result)
  } catch (e) {
    next(e)
  }
})

// PUT /api/admin/orders/:id/status — 受限状态流转（当前仅支持取消未付款订单）
const statusSchema = z.object({
  status: z.enum(['CANCELLED']),
})

router.put('/:id/status', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id)
    const { status } = statusSchema.parse(req.body)

    const order = await prisma.order.findUnique({
      where: { id },
      include: { items: true },
    })
    if (!order) throw new AppError(40401, '订单不存在', 404)

    // 仅允许 PENDING_PAYMENT → CANCELLED，取消时回滚库存与销量
    if (status === 'CANCELLED') {
      if (order.status !== 'PENDING_PAYMENT') {
        throw new AppError(42204, `订单状态为 ${order.status}，仅待付款订单可取消`)
      }
      const updated = await prisma.$transaction(async (tx) => {
        for (const item of order.items) {
          if (item.productId == null) continue // 商品已被删除，跳过库存回滚
          await tx.product.update({
            where: { id: item.productId },
            data: {
              stock: { increment: item.quantity },
              salesCount: { decrement: item.quantity },
            },
          })
        }
        return tx.order.update({
          where: { id },
          data: { status: 'CANCELLED', cancelledAt: new Date() },
        })
      })
      return success(res, updated)
    }
  } catch (e) {
    next(e)
  }
})

export default router
