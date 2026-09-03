import { Router, Request, Response, NextFunction } from 'express'
import { z } from 'zod'
import prisma from '../utils/prisma'
import { success } from '../utils/response'
import { AppError } from '../middlewares/error'
import { parseChannelQuery } from '../utils/channel'

const router = Router()

// GET /api/cart
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.userId!
    const channel = parseChannelQuery(req.query.channel)
    const items = await prisma.cart.findMany({
      where: { userId, product: { channel } },
      include: {
        product: {
          select: {
            id: true,
            name: true,
            coverImage: true,
            price: true,
            stock: true,
            status: true,
            unit: true,
            channel: true,
          },
        },
        sku: {
          select: { id: true, specText: true, price: true, stock: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    })

    // 有 SKU 的行价格/库存取自 SKU，无 SKU 走商品级（向后兼容）
    const cartItems = items.map((item) => {
      const price = item.sku?.price ?? item.product.price
      const stock = item.sku?.stock ?? item.product.stock
      return {
        id: item.id,
        productId: item.productId,
        skuId: item.skuId,
        specText: item.sku?.specText ?? null,
        productName: item.product.name,
        productImage: item.product.coverImage,
        price,
        stock,
        status: item.product.status,
        quantity: item.quantity,
        isSelected: item.isSelected,
        subtotal: price * item.quantity,
      }
    })

    const selectedItems = cartItems.filter((i) => i.isSelected === 1)
    const totalAmount = selectedItems.reduce((sum, i) => sum + i.subtotal, 0)

    success(res, { channel, items: cartItems, totalAmount, selectedCount: selectedItems.length })
  } catch (e) {
    next(e)
  }
})

// POST /api/cart
const addCartSchema = z.object({
  productId: z.number().int().positive(),
  quantity: z.number().int().min(1).max(99),
  skuId: z.number().int().positive().optional(),
})

router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.userId!
    const { productId, quantity, skuId } = addCartSchema.parse(req.body)

    const product = await prisma.product.findFirst({
      where: { id: productId, deletedAt: null },
      include: { skus: { select: { id: true, stock: true } } },
    })
    if (!product) throw new AppError(40401, '商品不存在', 404)
    if (product.status !== 'ON_SHELF') throw new AppError(42202, '商品已下架')

    // 有规格的商品必须携带属于该商品的 skuId，并按 SKU 库存限购
    let availableStock = product.stock
    if (product.skus.length > 0) {
      if (!skuId) throw new AppError(40001, '请选择商品规格', 400)
      const sku = product.skus.find((s) => s.id === skuId)
      if (!sku) throw new AppError(40401, '商品规格不存在', 404)
      availableStock = sku.stock
    } else if (skuId) {
      throw new AppError(40001, '该商品无规格', 400)
    }
    if (availableStock < quantity) throw new AppError(42201, '库存不足')

    // 唯一性由代码保证（skuId 为 NULL 时 MySQL 组合唯一索引不拦重复）
    const existing = await prisma.cart.findFirst({
      where: { userId, productId, skuId: skuId ?? null },
    })

    let cart
    if (existing) {
      const newQty = Math.min(existing.quantity + quantity, availableStock)
      cart = await prisma.cart.update({ where: { id: existing.id }, data: { quantity: newQty } })
    } else {
      cart = await prisma.cart.create({
        data: { userId, productId, skuId: skuId ?? null, quantity, isSelected: 1 },
      })
    }

    success(res, { id: cart.id, channel: product.channel })
  } catch (e) {
    next(e)
  }
})

// PUT /api/cart/:id
const updateCartSchema = z.object({
  quantity: z.number().int().min(1).max(99).optional(),
  isSelected: z.number().int().min(0).max(1).optional(),
})

router.put('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id)
    const userId = req.userId!
    const data = updateCartSchema.parse(req.body)

    const item = await prisma.cart.findFirst({
      where: { id, userId },
      include: { product: { select: { stock: true } }, sku: { select: { stock: true } } },
    })
    if (!item) throw new AppError(40401, '购物车项不存在', 404)

    if (data.quantity !== undefined) {
      const availableStock = item.sku?.stock ?? item.product.stock
      if (data.quantity > availableStock) throw new AppError(42201, '库存不足')
    }

    const updated = await prisma.cart.update({ where: { id }, data })
    success(res, updated)
  } catch (e) {
    next(e)
  }
})

// DELETE /api/cart/:id
router.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id)
    const userId = req.userId!

    const item = await prisma.cart.findFirst({ where: { id, userId } })
    if (!item) throw new AppError(40401, '购物车项不存在', 404)

    await prisma.cart.delete({ where: { id } })
    success(res, null, '删除成功')
  } catch (e) {
    next(e)
  }
})

export default router
