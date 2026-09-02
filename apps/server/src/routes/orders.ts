import { Router, Request, Response, NextFunction } from 'express'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import prisma from '../utils/prisma'
import { success, paginate } from '../utils/response'
import { AppError } from '../middlewares/error'
import { validatePayConfig, createJsapiOrder, generatePayParams, closeOrder } from '../services/wechat-pay'
import { config } from '../config'
import { notifyOrderPaid, notifyRefundRequest, notifyAfterSaleRequest } from '../services/order-notify'
import { rollbackOrderStock } from '../utils/order-stock'
import { payLimiter } from '../middlewares/rate-limit'
import { AFTER_SALE_REASONS, AFTER_SALE_REASON_LABEL, AfterSaleReason, payExpireAtOf } from '../utils/constants'
import { remainingRefundable } from '../services/refund'
import { getSubscribeTemplateIds } from '../services/subscribe-message'

const router = Router()

function generateOrderNo(): string {
  const d = new Date()
  const date = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
  const rand = String(Math.floor(Math.random() * 1000000)).padStart(6, '0')
  return `ORD${date}${rand}`
}

/** 顾客端订单附加字段：待付款截止时间（倒计时用） */
function withPayExpire<T extends { status: string; createdAt: Date }>(order: T): T & { payExpireAt: Date | null } {
  return {
    ...order,
    payExpireAt: order.status === 'PENDING_PAYMENT' ? payExpireAtOf(order.createdAt, config.order.payTimeoutMin) : null,
  }
}

function isPayExpired(order: { createdAt: Date }): boolean {
  return Date.now() >= payExpireAtOf(order.createdAt, config.order.payTimeoutMin).getTime()
}

// ─────────────────────────────────────────────────────────
// POST /api/orders — 下单（购物车结算 或 立即购买二选一）
// ─────────────────────────────────────────────────────────
const directItemSchema = z.object({
  productId: z.number().int().positive(),
  skuId: z.number().int().positive().optional(),
  quantity: z.number().int().min(1).max(99),
})
const createOrderSchema = z
  .object({
    cartItemIds: z.array(z.number().int().positive()).min(1, '请选择商品').optional(),
    directItem: directItemSchema.optional(),
    addressId: z.number().int().positive('请选择收货地址'),
    deliveryType: z.enum(['EXPRESS', 'LOCAL', 'PICKUP']).default('EXPRESS'),
    remark: z.string().max(255).optional(),
  })
  .refine((v) => !!v.cartItemIds !== !!v.directItem, { message: '请选择商品' })

interface OrderLine {
  productId: number
  skuId: number | null
  quantity: number
  product: Prisma.ProductGetPayload<Record<string, never>>
  sku: Prisma.ProductSkuGetPayload<Record<string, never>> | null
}

router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.userId!
    const { cartItemIds, directItem, addressId, deliveryType, remark } = createOrderSchema.parse(req.body)

    // 1. 组装下单行：购物车项 或 立即购买单品（不经购物车，避免与已加购数量合并）
    let lines: OrderLine[]
    if (cartItemIds) {
      const cartItems = await prisma.cart.findMany({
        where: { id: { in: cartItemIds }, userId },
        include: { product: true, sku: true },
      })
      if (cartItems.length === 0) throw new AppError(40001, '购物车商品不存在或不属于当前用户')
      lines = cartItems.map((c) => ({ productId: c.productId, skuId: c.skuId, quantity: c.quantity, product: c.product, sku: c.sku }))
    } else {
      const item = directItem!
      const product = await prisma.product.findFirst({
        where: { id: item.productId, deletedAt: null },
        include: { skus: true },
      })
      if (!product) throw new AppError(40401, '商品不存在')
      let sku: OrderLine['sku'] = null
      if (product.skus.length > 0) {
        if (!item.skuId) throw new AppError(40001, '请选择商品规格')
        sku = product.skus.find((s) => s.id === item.skuId) ?? null
        if (!sku) throw new AppError(40401, '商品规格不存在', 404)
      } else if (item.skuId) {
        throw new AppError(40001, '该商品无规格')
      }
      const { skus: _skus, ...plain } = product
      lines = [{ productId: product.id, skuId: sku?.id ?? null, quantity: item.quantity, product: plain, sku }]
    }

    // 2. 逐个验证商品（有 SKU 的行按 SKU 库存校验）
    for (const line of lines) {
      const p = line.product
      if (!p || p.deletedAt) throw new AppError(40401, '商品不存在')
      if (p.status !== 'ON_SHELF') throw new AppError(42202, `${p.name} 已下架`)
      if (line.skuId && !line.sku) throw new AppError(40401, `${p.name} 所选规格已失效`)
      const stock = line.sku?.stock ?? p.stock
      const label = line.sku ? `${p.name}（${line.sku.specText}）` : p.name
      if (stock < line.quantity) throw new AppError(42201, `${label} 库存不足（剩余 ${stock}）`)
    }

    // 3. 获取收货地址（验证归属）
    const address = await prisma.address.findFirst({
      where: { id: addressId, userId, deletedAt: null },
    })
    if (!address) throw new AppError(40401, '收货地址不存在', 404)

    // 4. 计算金额（全部后端计算；单价取 SKU 价，无 SKU 走商品价）
    let totalAmount = 0
    const orderItemsData = lines.map((line) => {
      const unitPrice = line.sku?.price ?? line.product.price
      const subtotal = unitPrice * line.quantity
      totalAmount += subtotal
      return {
        productId: line.productId,
        skuId: line.skuId,
        specText: line.sku?.specText ?? null,
        productName: line.product.name,
        productImage: line.product.coverImage,
        productPrice: unitPrice,
        quantity: line.quantity,
        subtotal,
      }
    })
    const shippingFee = 0
    const actualAmount = totalAmount + shippingFee

    // 5. 事务：创建订单 + 减库存 + 增销量 + 清购物车
    const order = await prisma.$transaction(async (tx) => {
      let orderNo = generateOrderNo()
      for (let i = 0; i < 3; i++) {
        const dup = await tx.order.findUnique({ where: { orderNo } })
        if (!dup) break
        orderNo = generateOrderNo()
      }

      const newOrder = await tx.order.create({
        data: {
          orderNo,
          userId,
          status: 'PENDING_PAYMENT',
          totalAmount,
          shippingFee,
          actualAmount,
          deliveryType,
          remark,
          receiverName: address.receiverName,
          receiverPhone: address.receiverPhone,
          receiverProvince: address.province,
          receiverCity: address.city,
          receiverDistrict: address.district,
          receiverDetail: address.detail,
          receiverFullAddress: address.fullAddress,
          items: { create: orderItemsData },
        },
      })

      // 原子减库存（updateMany 带 stock >= quantity 条件，防超卖）
      for (const line of lines) {
        if (line.skuId) {
          const skuUpdated = await tx.productSku.updateMany({
            where: { id: line.skuId, stock: { gte: line.quantity } },
            data: { stock: { decrement: line.quantity } },
          })
          if (skuUpdated.count === 0) {
            throw new AppError(42201, `${line.product.name}（${line.sku!.specText}）库存不足，请刷新重试`)
          }
          await tx.product.update({
            where: { id: line.productId },
            data: { stock: { decrement: line.quantity }, salesCount: { increment: line.quantity } },
          })
        } else {
          const updated = await tx.product.updateMany({
            where: { id: line.productId, stock: { gte: line.quantity } },
            data: { stock: { decrement: line.quantity }, salesCount: { increment: line.quantity } },
          })
          if (updated.count === 0) {
            throw new AppError(42201, `${line.product.name} 库存不足，请刷新重试`)
          }
        }
      }

      if (cartItemIds) {
        await tx.cart.deleteMany({ where: { id: { in: cartItemIds }, userId } })
      }
      return newOrder
    })

    success(res, {
      orderId: order.id,
      orderNo: order.orderNo,
      totalAmount: order.totalAmount,
      shippingFee: order.shippingFee,
      actualAmount: order.actualAmount,
      status: order.status,
      payExpireAt: payExpireAtOf(order.createdAt, config.order.payTimeoutMin),
      subscribeTemplateIds: getSubscribeTemplateIds(),
    })
  } catch (e) {
    next(e)
  }
})

// GET /api/orders
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.userId!
    const page = Math.max(1, Number(req.query.page) || 1)
    const pageSize = Math.min(50, Math.max(1, Number(req.query.pageSize) || 20))
    const status = req.query.status as string | undefined
    // 支持逗号分隔多状态（如「待发货」tab = PAID,PREPARING）
    const statuses = status ? status.split(',').filter(Boolean) : []

    const where = {
      userId,
      ...(statuses.length === 1 ? { status: statuses[0] } : statuses.length > 1 ? { status: { in: statuses } } : {}),
    }

    const [list, total] = await prisma.$transaction([
      prisma.order.findMany({
        where,
        include: {
          items: {
            select: { id: true, productName: true, productImage: true, productPrice: true, quantity: true, subtotal: true, specText: true },
          },
          refunds: { orderBy: { createdAt: 'desc' }, take: 1, select: { status: true, amount: true } },
          afterSales: { orderBy: { createdAt: 'desc' }, take: 1, select: { id: true, status: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.order.count({ where }),
    ])

    paginate(
      res,
      list.map(({ refunds, afterSales, ...o }) =>
        withPayExpire({ ...o, latestRefund: refunds[0] ?? null, afterSale: afterSales[0] ?? null })
      ),
      total,
      page,
      pageSize
    )
  } catch (e) {
    next(e)
  }
})

// GET /api/orders/:id
router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id)
    const userId = req.userId!

    const order = await prisma.order.findFirst({
      where: { id, userId },
      include: {
        items: true,
        shipment: true,
        refunds: {
          orderBy: { createdAt: 'desc' },
          select: { id: true, status: true, amount: true, reason: true, createdAt: true, successTime: true },
        },
        afterSales: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { id: true, reason: true, description: true, images: true, status: true, reply: true, createdAt: true, handledAt: true },
        },
      },
    })
    if (!order) throw new AppError(40401, '订单不存在', 404)

    const { afterSales, ...rest } = order
    const remaining = remainingRefundable(order)
    const activeAfterSale = afterSales[0] && ['PENDING', 'APPROVED'].includes(afterSales[0].status) ? afterSales[0] : null
    success(res, {
      ...withPayExpire(rest),
      afterSale: afterSales[0] ?? null,
      // 可申请售后：已发货/已完成、还有可退余额、当前无处理中的售后单
      canApplyAfterSale: ['SHIPPED', 'COMPLETED'].includes(order.status) && remaining > 0 && !activeAfterSale,
      subscribeTemplateIds: getSubscribeTemplateIds(),
    })
  } catch (e) {
    next(e)
  }
})

// PUT /api/orders/:id/confirm — 确认收货（SHIPPED → COMPLETED）
router.put('/:id/confirm', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id)
    const userId = req.userId!

    const order = await prisma.order.findFirst({ where: { id, userId } })
    if (!order) throw new AppError(40401, '订单不存在', 404)
    if (order.status !== 'SHIPPED') throw new AppError(42204, '仅已发货订单可确认收货')

    const updated = await prisma.order.update({
      where: { id },
      data: { status: 'COMPLETED', completedAt: new Date() },
    })
    success(res, updated)
  } catch (e) {
    next(e)
  }
})

// PUT /api/orders/:id/cancel — 客户自助取消
// 待付款：直接取消（并关闭微信订单）；已付款且商家未接单：进入退款流程（REFUNDING）并通知员工
// 已接单/已发货：不允许自助，请联系商家协商（员工在后台登记退款）
router.put('/:id/cancel', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id)
    const userId = req.userId!
    const order = await prisma.order.findFirst({
      where: { id, userId },
      include: { items: true, payment: { select: { outTradeNo: true, paymentType: true } } },
    })
    if (!order) throw new AppError(40401, '订单不存在', 404)

    if (order.status === 'PENDING_PAYMENT') {
      const updated = await prisma.$transaction(async (tx) => {
        const moved = await tx.order.updateMany({
          where: { id, status: 'PENDING_PAYMENT' },
          data: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: '用户取消' },
        })
        if (moved.count === 0) throw new AppError(42204, '订单状态已变化，请刷新')
        await rollbackOrderStock(tx, order.items)
        return tx.order.findUniqueOrThrow({ where: { id } })
      })
      if (!config.mock.pay && order.payment?.paymentType === 'WECHAT' && order.payment.outTradeNo) {
        void closeOrder(order.payment.outTradeNo)
      }
      return success(res, updated)
    }

    if (order.status === 'PAID' && !order.acceptedAt) {
      const updated = await prisma.$transaction(async (tx) => {
        await rollbackOrderStock(tx, order.items)
        return tx.order.update({
          where: { id },
          data: { status: 'REFUNDING', cancelledAt: new Date(), cancelReason: '用户申请退款' },
        })
      })
      notifyRefundRequest(updated)
      return success(res, updated)
    }

    throw new AppError(
      42204,
      order.status === 'PAID' || order.status === 'PREPARING'
        ? '商家已接单备餐，请电话联系商家协商退款'
        : `订单状态为 ${order.status}，不可取消`
    )
  } catch (e) {
    next(e)
  }
})

// ─────────────────────────────────────────────────────────
// 售后申请（收货后：少发/错发/变质破损/其他 → 店员审核后部分/全额退款）
// ─────────────────────────────────────────────────────────
const afterSaleSchema = z.object({
  reason: z.enum(AFTER_SALE_REASONS),
  description: z.string().trim().max(200).optional(),
  images: z.array(z.string().url().max(500)).max(3).default([]),
})

router.post('/:id/after-sale', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id)
    const userId = req.userId!
    const { reason, description, images } = afterSaleSchema.parse(req.body ?? {})
    if (reason === 'OTHER' && !description) throw new AppError(40001, '选择「其他」时请填写说明')

    const order = await prisma.order.findFirst({
      where: { id, userId },
      include: { afterSales: { where: { status: { in: ['PENDING', 'APPROVED'] } }, take: 1 } },
    })
    if (!order) throw new AppError(40401, '订单不存在', 404)
    if (!['SHIPPED', 'COMPLETED'].includes(order.status)) throw new AppError(42204, '仅已发货/已完成订单可申请售后')
    if (remainingRefundable(order) <= 0) throw new AppError(42206, '该订单已全额退款')
    if (order.afterSales.length > 0) throw new AppError(42208, '已有售后申请处理中，请等待商家处理')

    const afterSale = await prisma.afterSale.create({
      data: { orderId: id, orderNo: order.orderNo, userId, reason, description: description || null, images },
    })
    notifyAfterSaleRequest(order, {
      reasonLabel: AFTER_SALE_REASON_LABEL[reason as AfterSaleReason],
      description,
      imageCount: images.length,
    })
    success(res, afterSale)
  } catch (e) {
    next(e)
  }
})

router.get('/:id/after-sale', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id)
    const userId = req.userId!
    const list = await prisma.afterSale.findMany({
      where: { orderId: id, userId },
      orderBy: { createdAt: 'desc' },
    })
    success(res, list)
  } catch (e) {
    next(e)
  }
})

// ─────────────────────────────────────────────────────────
// POST /api/orders/:id/pay
// ─────────────────────────────────────────────────────────
router.post('/:id/pay', payLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const orderId = Number(req.params.id)
    const userId = req.userId!
    // Mock 支付默认关闭：仅 WECHAT_PAY_MOCK=true 时启用（config.ts 保证生产环境无法开启）
    const useMockPay = config.mock.pay

    const order = await prisma.order.findFirst({
      where: { id: orderId, userId },
      include: { payment: true },
    })
    if (!order) throw new AppError(40401, '订单不存在', 404)
    if (order.status === 'PAID') throw new AppError(42203, '订单已支付')
    if (order.status !== 'PENDING_PAYMENT') throw new AppError(42204, '订单状态不允许支付')
    if (isPayExpired(order)) throw new AppError(42209, '订单已超时，请重新下单')

    if (useMockPay) {
      const paidAt = new Date()
      await prisma.$transaction(async (tx) => {
        await tx.payment.upsert({
          where: { orderId },
          update: { status: 'SUCCESS', paidAt, paymentType: 'MOCK' },
          create: {
            orderId,
            orderNo: order.orderNo,
            paymentType: 'MOCK',
            amount: order.actualAmount,
            status: 'SUCCESS',
            paidAt,
          },
        })
        await tx.order.update({ where: { id: orderId }, data: { status: 'PAID', paidAt } })
      })
      prisma.orderItem
        .findMany({ where: { orderId }, select: { productName: true, specText: true, quantity: true } })
        .then((items) => notifyOrderPaid({ ...order, paidAt }, items))
        .catch(() => undefined)
      return success(res, { mode: 'mock', status: 'PAID', paidAt })
    }

    // Real WeChat Pay
    validatePayConfig()
    const openid = req.openid
    if (!openid) throw new AppError(40101, '未登录或 token 缺少 openid，无法发起微信支付', 401)

    // 已有未过期的预下单：直接复用 prepay_id，避免重复点「去支付」时 out_trade_no 被覆盖
    const existing = order.payment
    if (existing && existing.status === 'PENDING' && existing.paymentType === 'WECHAT' && existing.wxPrepayId && existing.outTradeNo) {
      return success(res, { mode: 'wechat', ...generatePayParams(existing.wxPrepayId) })
    }

    const outTradeNo = `order_${orderId}_${Date.now()}`
    const prepayId = await createJsapiOrder({
      outTradeNo,
      description: `订单 ${order.orderNo}`,
      amount: order.actualAmount, // fen
      openid,
      notifyUrl: process.env.WECHAT_PAY_NOTIFY_URL!,
      timeExpire: payExpireAtOf(order.createdAt, config.order.payTimeoutMin),
    })

    await prisma.payment.upsert({
      where: { orderId },
      update: { outTradeNo, wxPrepayId: prepayId, status: 'PENDING', paymentType: 'WECHAT' },
      create: {
        orderId,
        orderNo: order.orderNo,
        outTradeNo,
        paymentType: 'WECHAT',
        amount: order.actualAmount,
        status: 'PENDING',
        wxPrepayId: prepayId,
      },
    })

    return success(res, { mode: 'wechat', ...generatePayParams(prepayId) })
  } catch (e) {
    next(e)
  }
})

export default router
