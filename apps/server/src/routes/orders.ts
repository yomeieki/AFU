import { Router, Request, Response, NextFunction } from 'express'
import { z } from 'zod'
import prisma from '../utils/prisma'
import { success, paginate } from '../utils/response'
import { AppError } from '../middlewares/error'
import { validatePayConfig, createJsapiOrder, generatePayParams } from '../services/wechat-pay'
import { config } from '../config'
import { payLimiter } from '../middlewares/rate-limit'

const router = Router()

function generateOrderNo(): string {
  const d = new Date()
  const date = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
  const rand = String(Math.floor(Math.random() * 1000000)).padStart(6, '0')
  return `ORD${date}${rand}`
}

// POST /api/orders
const createOrderSchema = z.object({
  cartItemIds: z.array(z.number().int().positive()).min(1, '请选择商品'),
  addressId: z.number().int().positive('请选择收货地址'),
  deliveryType: z.enum(['EXPRESS', 'LOCAL', 'PICKUP']).default('EXPRESS'),
  remark: z.string().max(255).optional(),
})

router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.userId!
    const { cartItemIds, addressId, deliveryType, remark } = createOrderSchema.parse(req.body)

    // 1. 获取购物车项（含商品与 SKU 信息）
    const cartItems = await prisma.cart.findMany({
      where: { id: { in: cartItemIds }, userId },
      include: { product: true, sku: true },
    })
    if (cartItems.length === 0) {
      throw new AppError(40001, '购物车商品不存在或不属于当前用户')
    }

    // 2. 逐个验证商品（有 SKU 的行按 SKU 库存校验）
    for (const item of cartItems) {
      const p = item.product
      if (!p || p.deletedAt) throw new AppError(40401, '商品不存在')
      if (p.status !== 'ON_SHELF') throw new AppError(42202, `${p.name} 已下架`)
      if (item.skuId && !item.sku) throw new AppError(40401, `${p.name} 所选规格已失效`)
      const stock = item.sku?.stock ?? p.stock
      const label = item.sku ? `${p.name}（${item.sku.specText}）` : p.name
      if (stock < item.quantity) throw new AppError(42201, `${label} 库存不足（剩余 ${stock}）`)
    }

    // 3. 获取收货地址（验证归属）
    const address = await prisma.address.findFirst({
      where: { id: addressId, userId, deletedAt: null },
    })
    if (!address) throw new AppError(40401, '收货地址不存在', 404)

    // 4. 计算金额（全部后端计算；单价取 SKU 价，无 SKU 走商品价）
    let totalAmount = 0
    const orderItemsData = cartItems.map((item) => {
      const unitPrice = item.sku?.price ?? item.product.price
      const subtotal = unitPrice * item.quantity
      totalAmount += subtotal
      return {
        productId: item.productId,
        skuId: item.skuId,
        specText: item.sku?.specText ?? null,
        productName: item.product.name,
        productImage: item.product.coverImage,
        productPrice: unitPrice,
        quantity: item.quantity,
        subtotal,
      }
    })
    const shippingFee = 0
    const actualAmount = totalAmount + shippingFee

    // 5. 事务：创建订单 + 减库存 + 增销量 + 清购物车
    const order = await prisma.$transaction(async (tx) => {
      // 生成唯一订单号（最多重试3次）
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
      // 有 SKU：先扣 SKU 库存，再同步扣商品冗余总库存（product.stock = sum(sku.stock) 约定）
      for (const item of cartItems) {
        if (item.skuId) {
          const skuUpdated = await tx.productSku.updateMany({
            where: { id: item.skuId, stock: { gte: item.quantity } },
            data: { stock: { decrement: item.quantity } },
          })
          if (skuUpdated.count === 0) {
            throw new AppError(42201, `${item.product.name}（${item.sku!.specText}）库存不足，请刷新重试`)
          }
          await tx.product.update({
            where: { id: item.productId },
            data: {
              stock: { decrement: item.quantity },
              salesCount: { increment: item.quantity },
            },
          })
        } else {
          const updated = await tx.product.updateMany({
            where: { id: item.productId, stock: { gte: item.quantity } },
            data: {
              stock: { decrement: item.quantity },
              salesCount: { increment: item.quantity },
            },
          })
          if (updated.count === 0) {
            throw new AppError(42201, `${item.product.name} 库存不足，请刷新重试`)
          }
        }
      }

      // 清空已下单的购物车项
      await tx.cart.deleteMany({ where: { id: { in: cartItemIds }, userId } })

      return newOrder
    })

    success(res, {
      orderId: order.id,
      orderNo: order.orderNo,
      totalAmount: order.totalAmount,
      shippingFee: order.shippingFee,
      actualAmount: order.actualAmount,
      status: order.status,
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

    const where = { userId, ...(status ? { status } : {}) }

    const [list, total] = await prisma.$transaction([
      prisma.order.findMany({
        where,
        include: {
          items: {
            select: {
              id: true,
              productName: true,
              productImage: true,
              productPrice: true,
              quantity: true,
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

// GET /api/orders/:id
router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id)
    const userId = req.userId!

    const order = await prisma.order.findFirst({
      where: { id, userId },
      include: { items: true, shipment: true },
    })
    if (!order) throw new AppError(40401, '订单不存在', 404)

    success(res, order)
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
    if (order.status !== 'SHIPPED') {
      throw new AppError(42204, '仅已发货订单可确认收货')
    }

    const updated = await prisma.order.update({
      where: { id },
      data: { status: 'COMPLETED' },
    })
    success(res, updated)
  } catch (e) {
    next(e)
  }
})

// POST /api/orders/:id/pay
router.post('/:id/pay', payLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const orderId = Number(req.params.id)
    const userId = req.userId!
    // Mock 支付默认关闭：仅 WECHAT_PAY_MOCK=true 时启用（config.ts 保证生产环境无法开启）
    const useMockPay = config.mock.pay

    const order = await prisma.order.findFirst({
      where: { id: orderId, userId },
    })
    if (!order) throw new AppError(40401, '订单不存在', 404)
    if (order.status === 'PAID') throw new AppError(42203, '订单已支付')
    if (order.status !== 'PENDING_PAYMENT') throw new AppError(42204, '订单状态不允许支付')

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
        await tx.order.update({
          where: { id: orderId },
          data: { status: 'PAID', paidAt },
        })
      })
      return success(res, { mode: 'mock', status: 'PAID', paidAt })
    }

    // Real WeChat Pay
    validatePayConfig()
    const openid = req.openid
    if (!openid) throw new AppError(40101, '未登录或 token 缺少 openid，无法发起微信支付', 401)

    // amount is stored as fen (integer cents) throughout the codebase
    const outTradeNo = `order_${orderId}_${Date.now()}`
    const prepayId = await createJsapiOrder({
      outTradeNo,
      description: `订单 ${order.orderNo}`,
      amount: order.actualAmount, // fen
      openid,
      notifyUrl: process.env.WECHAT_PAY_NOTIFY_URL!,
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

    const payParams = generatePayParams(prepayId)
    return success(res, { mode: 'wechat', ...payParams })
  } catch (e) {
    next(e)
  }
})

export default router
