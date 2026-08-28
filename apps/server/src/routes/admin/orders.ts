import { Router, Request, Response, NextFunction } from 'express'
import { z } from 'zod'
import prisma from '../../utils/prisma'
import { success, paginate } from '../../utils/response'
import { AppError } from '../../middlewares/error'
import { rollbackOrderStock } from '../../utils/order-stock'

const router = Router()

// GET /api/admin/orders
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1)
    const pageSize = Math.min(50, Math.max(1, Number(req.query.pageSize) || 20))
    const rawStatus = req.query.status as string | undefined
    const statuses = rawStatus ? rawStatus.split(',').filter(Boolean) : []
    const status = statuses.length === 1 ? statuses[0] : undefined
    const orderNo = req.query.orderNo as string | undefined

    const where = {
      ...(status ? { status } : statuses.length > 1 ? { status: { in: statuses } } : {}),
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
              specText: true,
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

// GET /api/admin/orders/pending-count — 待发货订单数（供后台提醒轮询）
// 注意：必须注册在 GET /:id 之前，否则会被 :id 匹配吞掉
router.get('/pending-count', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const LOW_STOCK_THRESHOLD = 5
    const [count, latest, refundingCount, lowStockCount] = await Promise.all([
      // 待处理 = 待接单(PAID) + 备餐中(PREPARING)
      prisma.order.count({ where: { status: { in: ['PAID', 'PREPARING'] } } }),
      prisma.order.findFirst({
        where: { status: 'PAID' },
        orderBy: { paidAt: 'desc' },
        select: { paidAt: true, createdAt: true },
      }),
      prisma.order.count({ where: { status: 'REFUNDING' } }),
      // 低库存预警：上架且库存 ≤ 阈值（含 SKU 商品的冗余总库存）
      prisma.product.count({
        where: { deletedAt: null, status: 'ON_SHELF', stock: { lte: LOW_STOCK_THRESHOLD } },
      }),
    ])
    success(res, {
      count,
      latestPaidAt: latest ? (latest.paidAt ?? latest.createdAt) : null,
      refundingCount,
      lowStockCount,
      lowStockThreshold: LOW_STOCK_THRESHOLD,
    })
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

// POST /api/admin/orders/:id/accept — 接单（PAID → PREPARING 备餐中）
router.post('/:id/accept', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id)
    const order = await prisma.order.findUnique({ where: { id } })
    if (!order) throw new AppError(40401, '订单不存在', 404)
    if (order.status !== 'PAID') {
      throw new AppError(42204, `订单状态为 ${order.status}，仅已付款订单可接单`)
    }
    const updated = await prisma.order.update({
      where: { id },
      data: { status: 'PREPARING', acceptedAt: new Date() },
    })
    success(res, updated)
  } catch (e) {
    next(e)
  }
})

// POST /api/admin/orders/:id/ship — 发货（PAID/PREPARING 订单）
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
    if (!['PAID', 'PREPARING'].includes(order.status)) {
      throw new AppError(42204, `订单状态为 ${order.status}，仅待接单/备餐中订单可发货`)
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

// POST /api/admin/orders/:id/refund — 登记退款（协商一致后员工操作）
// 待接单/备餐中：取消订单+回滚库存；已发货：仅登记（货已出，库存不回滚）
const refundSchema = z.object({ reason: z.string().max(255).optional() })

router.post('/:id/refund', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id)
    const { reason } = refundSchema.parse(req.body ?? {})
    const order = await prisma.order.findUnique({ where: { id }, include: { items: true } })
    if (!order) throw new AppError(40401, '订单不存在', 404)
    if (!['PAID', 'PREPARING', 'SHIPPED'].includes(order.status)) {
      throw new AppError(42204, `订单状态为 ${order.status}，不可登记退款`)
    }
    const updated = await prisma.$transaction(async (tx) => {
      if (order.status !== 'SHIPPED') {
        await rollbackOrderStock(tx, order.items)
      }
      return tx.order.update({
        where: { id },
        data: {
          status: 'REFUNDING',
          cancelledAt: new Date(),
          cancelReason: reason ?? '商家登记退款',
        },
      })
    })
    success(res, updated)
  } catch (e) {
    next(e)
  }
})

// POST /api/admin/orders/:id/refund-complete — 商户平台打款完成后标记
router.post('/:id/refund-complete', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id)
    const order = await prisma.order.findUnique({ where: { id } })
    if (!order) throw new AppError(40401, '订单不存在', 404)
    if (order.status !== 'REFUNDING') {
      throw new AppError(42204, `订单状态为 ${order.status}，仅退款中订单可标记完成`)
    }
    const updated = await prisma.order.update({
      where: { id },
      data: { status: 'REFUNDED', refundedAt: new Date() },
    })
    success(res, updated)
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
        await rollbackOrderStock(tx, order.items)
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
