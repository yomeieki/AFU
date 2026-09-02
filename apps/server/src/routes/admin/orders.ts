import { Router, Request, Response, NextFunction } from 'express'
import { z } from 'zod'
import prisma from '../../utils/prisma'
import { success, paginate } from '../../utils/response'
import { AppError } from '../../middlewares/error'
import { rollbackOrderStock } from '../../utils/order-stock'
import { ACTIVE_REFUND_STATUSES, finalizeRefundSuccess, initiateRefund, remainingRefundable } from '../../services/refund'
import { sendShipSubscribeMessage } from '../../services/subscribe-message'
import { LOW_STOCK_THRESHOLD } from '../../utils/constants'

const router = Router()

const orderListSelect = {
  id: true,
  orderNo: true,
  status: true,
  totalAmount: true,
  shippingFee: true,
  actualAmount: true,
  refundedAmount: true,
  deliveryType: true,
  remark: true,
  receiverName: true,
  receiverPhone: true,
  receiverFullAddress: true,
  paidAt: true,
  acceptedAt: true,
  completedAt: true,
  cancelReason: true,
  createdAt: true,
  items: {
    select: { productName: true, productImage: true, specText: true, quantity: true, productPrice: true, subtotal: true },
  },
  shipment: {
    select: { id: true, orderId: true, expressCompany: true, expressNo: true, shippedAt: true, remark: true },
  },
  refunds: {
    orderBy: { createdAt: 'desc' as const },
    take: 1,
    select: { id: true, status: true, outRefundNo: true, amount: true, mode: true, errorMessage: true, createdAt: true },
  },
  afterSales: {
    orderBy: { createdAt: 'desc' as const },
    take: 1,
    select: { id: true, status: true, reason: true, createdAt: true },
  },
}

// GET /api/admin/orders?status=&keyword=（订单号/收货人/手机号模糊）
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1)
    const pageSize = Math.min(50, Math.max(1, Number(req.query.pageSize) || 20))
    const rawStatus = req.query.status as string | undefined
    const statuses = rawStatus ? rawStatus.split(',').filter(Boolean) : []
    const status = statuses.length === 1 ? statuses[0] : undefined
    // keyword 新参数；orderNo 旧参数兼容
    const keyword = ((req.query.keyword as string | undefined) ?? (req.query.orderNo as string | undefined))?.trim()

    const where = {
      ...(status ? { status } : statuses.length > 1 ? { status: { in: statuses } } : {}),
      ...(keyword
        ? {
            OR: [
              { orderNo: { contains: keyword } },
              { receiverName: { contains: keyword } },
              { receiverPhone: { contains: keyword } },
            ],
          }
        : {}),
    }

    const [list, total] = await prisma.$transaction([
      prisma.order.findMany({
        where,
        select: orderListSelect,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.order.count({ where }),
    ])

    paginate(
      res,
      list.map(({ refunds, afterSales, ...o }) => ({
        ...o,
        latestRefund: refunds[0] ?? null,
        afterSale: afterSales[0] ?? null,
        remainingRefundable: remainingRefundable(o),
      })),
      total,
      page,
      pageSize
    )
  } catch (e) {
    next(e)
  }
})

// GET /api/admin/orders/pending-count — 待处理计数（供后台提醒轮询）
// 注意：必须注册在 GET /:id 之前，否则会被 :id 匹配吞掉
router.get('/pending-count', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const [count, latest, refundingCount, lowStockCount, afterSaleCount] = await Promise.all([
      // 待处理 = 待接单(PAID) + 备餐中(PREPARING)
      prisma.order.count({ where: { status: { in: ['PAID', 'PREPARING'] } } }),
      prisma.order.findFirst({
        where: { status: 'PAID' },
        orderBy: { paidAt: 'desc' },
        select: { paidAt: true, createdAt: true },
      }),
      prisma.order.count({ where: { status: 'REFUNDING' } }),
      prisma.product.count({
        where: { deletedAt: null, status: 'ON_SHELF', stock: { lte: LOW_STOCK_THRESHOLD } },
      }),
      prisma.afterSale.count({ where: { status: 'PENDING' } }),
    ])
    success(res, {
      count,
      latestPaidAt: latest ? (latest.paidAt ?? latest.createdAt) : null,
      refundingCount,
      lowStockCount,
      lowStockThreshold: LOW_STOCK_THRESHOLD,
      afterSaleCount,
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
        refunds: { orderBy: { createdAt: 'desc' } },
        afterSales: { orderBy: { createdAt: 'desc' } },
        user: { select: { id: true, nickname: true, phone: true } },
      },
    })
    if (!order) throw new AppError(40401, '订单不存在', 404)
    success(res, { ...order, remainingRefundable: remainingRefundable(order) })
  } catch (e) {
    next(e)
  }
})

// POST /api/admin/orders/:id/accept — 接单（PAID → PREPARING 备餐中）
router.post('/:id/accept', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id)
    const moved = await prisma.order.updateMany({
      where: { id, status: 'PAID' },
      data: { status: 'PREPARING', acceptedAt: new Date() },
    })
    if (moved.count === 0) {
      const order = await prisma.order.findUnique({ where: { id } })
      if (!order) throw new AppError(40401, '订单不存在', 404)
      throw new AppError(42204, `订单状态为 ${order.status}，仅已付款订单可接单`)
    }
    success(res, await prisma.order.findUnique({ where: { id } }))
  } catch (e) {
    next(e)
  }
})

// POST /api/admin/orders/:id/ship — 发货（PAID/PREPARING 订单）
const shipSchema = z.object({
  expressCompany: z.string().trim().min(1, '请填写快递公司').max(64),
  expressNo: z.string().trim().min(1, '请填写快递单号').max(64),
  remark: z.string().max(255).optional(),
})

router.post('/:id/ship', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id)
    const { expressCompany, expressNo, remark } = shipSchema.parse(req.body)

    const order = await prisma.order.findUnique({
      where: { id },
      include: { user: { select: { openid: true } }, items: { select: { productName: true }, take: 1 } },
    })
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
      const updated = await tx.order.update({ where: { id }, data: { status: 'SHIPPED' } })
      return { shipment, order: updated }
    })

    // 顾客订阅消息（fire-and-forget）
    sendShipSubscribeMessage(order.user.openid, order, result.shipment, order.items[0]?.productName)
    success(res, result)
  } catch (e) {
    next(e)
  }
})

// POST /api/admin/orders/:id/complete — 商家标记完成（SHIPPED → COMPLETED；定时任务 N 天后也会自动完成）
router.post('/:id/complete', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id)
    const moved = await prisma.order.updateMany({
      where: { id, status: 'SHIPPED' },
      data: { status: 'COMPLETED', completedAt: new Date() },
    })
    if (moved.count === 0) {
      const order = await prisma.order.findUnique({ where: { id } })
      if (!order) throw new AppError(40401, '订单不存在', 404)
      throw new AppError(42204, `订单状态为 ${order.status}，仅已发货订单可标记完成`)
    }
    success(res, await prisma.order.findUnique({ where: { id } }))
  } catch (e) {
    next(e)
  }
})

// POST /api/admin/orders/:id/refund — 退款（全额或部分，微信退款 API 原路退回）
// amount 由操作员在弹窗里手输并二次确认；服务端校验 0 < amount <= 可退余额（见 services/refund.ts）
const refundSchema = z.object({
  amount: z.number().int().positive(),
  reason: z.string().trim().max(80).optional(),
})

router.post('/:id/refund', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id)
    const { amount, reason } = refundSchema.parse(req.body ?? {})
    const result = await initiateRefund({ orderId: id, amount, reason, operator: req.adminUsername ?? undefined })
    success(res, result)
  } catch (e) {
    next(e)
  }
})

// POST /api/admin/orders/:id/refund-complete — 人工兜底：确认已在商户平台退款成功但系统未收到回调时标记
router.post('/:id/refund-complete', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id)
    const order = await prisma.order.findUnique({ where: { id }, include: { refunds: true } })
    if (!order) throw new AppError(40401, '订单不存在', 404)
    if (order.status !== 'REFUNDING') {
      throw new AppError(42204, `订单状态为 ${order.status}，仅退款中订单可标记完成`)
    }
    const active = order.refunds.find((r) => (ACTIVE_REFUND_STATUSES as readonly string[]).includes(r.status))
    if (active) {
      await finalizeRefundSuccess({ refundId: active.id, operator: `manual:${req.adminUsername ?? ''}` })
    } else {
      // 无在途退款单（如用户自助取消后员工在商户平台手动打款）：直接把剩余款项记为已退
      const remaining = remainingRefundable(order)
      const moved = await prisma.order.updateMany({
        where: { id, status: 'REFUNDING' },
        data: { status: 'REFUNDED', refundedAt: new Date(), refundedAmount: { increment: remaining } },
      })
      if (moved.count === 0) throw new AppError(42204, '订单状态已变化，请刷新后重试')
      await prisma.payment.updateMany({ where: { orderId: id }, data: { status: 'REFUNDED' } })
    }
    success(res, await prisma.order.findUnique({ where: { id } }))
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

    const order = await prisma.order.findUnique({ where: { id }, include: { items: true } })
    if (!order) throw new AppError(40401, '订单不存在', 404)

    if (status === 'CANCELLED') {
      if (order.status !== 'PENDING_PAYMENT') {
        throw new AppError(42204, `订单状态为 ${order.status}，仅待付款订单可取消`)
      }
      const updated = await prisma.$transaction(async (tx) => {
        const moved = await tx.order.updateMany({
          where: { id, status: 'PENDING_PAYMENT' },
          data: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: '商家取消' },
        })
        if (moved.count === 0) throw new AppError(42204, '订单状态已变化，请刷新后重试')
        await rollbackOrderStock(tx, order.items)
        return tx.order.findUniqueOrThrow({ where: { id } })
      })
      return success(res, updated)
    }
  } catch (e) {
    next(e)
  }
})

export default router
