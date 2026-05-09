import { Router, Request, Response, NextFunction } from 'express'
import { z } from 'zod'
import prisma from '../utils/prisma'
import { success, paginate } from '../utils/response'
import { AppError } from '../middlewares/error'

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

    // 1. 获取购物车项（含商品信息）
    const cartItems = await prisma.cart.findMany({
      where: { id: { in: cartItemIds }, userId },
      include: { product: true },
    })
    if (cartItems.length === 0) {
      throw new AppError(40001, '购物车商品不存在或不属于当前用户')
    }

    // 2. 逐个验证商品
    for (const item of cartItems) {
      const p = item.product
      if (!p || p.deletedAt) throw new AppError(40401, '商品不存在')
      if (p.status !== 'ON_SHELF') throw new AppError(42202, `${p.name} 已下架`)
      if (p.stock < item.quantity) throw new AppError(42201, `${p.name} 库存不足（剩余 ${p.stock}）`)
    }

    // 3. 获取收货地址（验证归属）
    const address = await prisma.address.findFirst({
      where: { id: addressId, userId, deletedAt: null },
    })
    if (!address) throw new AppError(40401, '收货地址不存在', 404)

    // 4. 计算金额（全部后端计算）
    let totalAmount = 0
    const orderItemsData = cartItems.map((item) => {
      const subtotal = item.product.price * item.quantity
      totalAmount += subtotal
      return {
        productId: item.productId,
        productName: item.product.name,
        productImage: item.product.coverImage,
        productPrice: item.product.price,
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
      for (const item of cartItems) {
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

export default router
