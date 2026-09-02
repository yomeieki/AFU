import { Router, Request, Response, NextFunction } from 'express'
import { z } from 'zod'
import prisma from '../../utils/prisma'
import { success, paginate } from '../../utils/response'
import { AppError } from '../../middlewares/error'
import { rollbackOrderStock } from '../../utils/order-stock'
import { Prisma } from '@prisma/client'
import { config } from '../../config'
import { createRefund, getRefundNotifyUrl, validatePayConfig, WechatRefundError } from '../../services/wechat-pay'
import {
  ACTIVE_REFUND_STATUSES,
  buildOutRefundNo,
  finalizeRefundSuccess,
  markRefundAbnormal,
  markRefundClosed,
  markRefundFailed,
} from '../../services/refund'

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
          refunds: {
            orderBy: { createdAt: 'desc' },
            take: 1,
            select: {
              id: true,
              status: true,
              outRefundNo: true,
              amount: true,
              mode: true,
              errorMessage: true,
              createdAt: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.order.count({ where }),
    ])

    paginate(
      res,
      list.map(({ refunds, ...o }) => ({ ...o, latestRefund: refunds[0] ?? null })),
      total,
      page,
      pageSize
    )
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

// POST /api/admin/orders/:id/refund — 一键退款（全额，微信退款 API 原路退回）
// 允许：PAID/PREPARING/SHIPPED（登记 + 执行），或 REFUNDING（用户自助取消 / 上次发起失败后重试）
// 待接单/备餐中：回滚库存；已发货：不回滚（货已出）
// 服务端二次校验：amount 必须等于订单实付（前端已让操作员手输确认，这里再挡一道）
const refundSchema = z.object({
  amount: z.number().int().positive(),
  reason: z.string().trim().max(80).optional(),
})

router.post('/:id/refund', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id)
    const { amount, reason } = refundSchema.parse(req.body ?? {})
    const order = await prisma.order.findUnique({
      where: { id },
      include: { items: true, payment: true, refunds: true },
    })
    if (!order) throw new AppError(40401, '订单不存在', 404)
    if (amount !== order.actualAmount) {
      throw new AppError(42206, '退款金额与订单实付不一致')
    }

    const fromRefunding = order.status === 'REFUNDING'
    if (!fromRefunding && !['PAID', 'PREPARING', 'SHIPPED'].includes(order.status)) {
      throw new AppError(42204, `订单状态为 ${order.status}，不可退款`)
    }
    if (order.refunds.some((r) => (ACTIVE_REFUND_STATUSES as readonly string[]).includes(r.status))) {
      throw new AppError(42205, '该订单已有退款处理中')
    }
    if (!order.payment || order.payment.status !== 'SUCCESS') {
      throw new AppError(42207, '订单无成功支付记录，无法退款')
    }
    const mode = config.mock.pay ? 'MOCK' : 'WECHAT'
    if (mode === 'WECHAT' && (order.payment.paymentType === 'MOCK' || !order.payment.outTradeNo)) {
      throw new AppError(42207, '模拟支付订单无法发起微信退款')
    }

    // 事务 A：状态流转 + 库存回滚 + 创建退款记录（不含外呼）
    const refund = await prisma.$transaction(async (tx) => {
      if (!fromRefunding) {
        const moved = await tx.order.updateMany({
          where: { id, status: { in: ['PAID', 'PREPARING', 'SHIPPED'] } },
          data: {
            status: 'REFUNDING',
            cancelledAt: new Date(),
            cancelReason: reason || '商家退款',
          },
        })
        if (moved.count === 0) throw new AppError(42204, '订单状态已变化，请刷新后重试')
        if (order.status !== 'SHIPPED') {
          await rollbackOrderStock(tx, order.items)
        }
      }
      try {
        return await tx.refund.create({
          data: {
            orderId: id,
            orderNo: order.orderNo,
            outTradeNo: order.payment!.outTradeNo,
            outRefundNo: buildOutRefundNo(id),
            amount,
            totalAmount: order.actualAmount,
            status: 'PENDING',
            mode,
            reason: reason || null,
            operator: req.adminUsername ?? null,
            activeOrderId: id,
          },
        })
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
          throw new AppError(42205, '该订单已有退款处理中')
        }
        throw e
      }
    })

    // mock：直接成功
    if (mode === 'MOCK') {
      await finalizeRefundSuccess({ refundId: refund.id, operator: req.adminUsername ?? undefined })
      const [updatedOrder, updatedRefund] = await Promise.all([
        prisma.order.findUnique({ where: { id } }),
        prisma.refund.findUnique({ where: { id: refund.id } }),
      ])
      success(res, { order: updatedOrder, refund: updatedRefund, mode: 'mock' })
      return
    }

    // 真实：调微信退款 API
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
      await prisma.refund.update({
        where: { id: refund.id },
        data: {
          wxRefundId: result.refund_id,
          status: result.status,
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
      // 订单保持 REFUNDING（库存已回滚、商家已决定退），后台可重试
      throw new AppError(50201, `微信退款发起失败：${message}`, 502)
    }

    const [updatedOrder, updatedRefund] = await Promise.all([
      prisma.order.findUnique({ where: { id } }),
      prisma.refund.findUnique({ where: { id: refund.id } }),
    ])
    success(res, { order: updatedOrder, refund: updatedRefund, mode: 'wechat' })
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
    if (active && active.status !== 'SUCCESS') {
      await finalizeRefundSuccess({ refundId: active.id, operator: `manual:${req.adminUsername ?? ''}` })
    } else {
      const moved = await prisma.order.updateMany({
        where: { id, status: 'REFUNDING' },
        data: { status: 'REFUNDED', refundedAt: new Date() },
      })
      if (moved.count === 0) throw new AppError(42204, '订单状态已变化，请刷新后重试')
      await prisma.payment.updateMany({ where: { orderId: id }, data: { status: 'REFUNDED' } })
    }
    const updated = await prisma.order.findUnique({ where: { id } })
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
