import { Router, Request, Response, NextFunction } from 'express'
import { z } from 'zod'
import prisma from '../utils/prisma'
import { success } from '../utils/response'
import { AppError } from '../middlewares/error'

const router = Router()

// GET /api/cart
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.userId!
    const items = await prisma.cart.findMany({
      where: { userId },
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
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    })

    const cartItems = items.map((item) => ({
      id: item.id,
      productId: item.productId,
      productName: item.product.name,
      productImage: item.product.coverImage,
      price: item.product.price,
      stock: item.product.stock,
      status: item.product.status,
      quantity: item.quantity,
      isSelected: item.isSelected,
      subtotal: item.product.price * item.quantity,
    }))

    const selectedItems = cartItems.filter((i) => i.isSelected === 1)
    const totalAmount = selectedItems.reduce((sum, i) => sum + i.subtotal, 0)

    success(res, { items: cartItems, totalAmount, selectedCount: selectedItems.length })
  } catch (e) {
    next(e)
  }
})

// POST /api/cart
const addCartSchema = z.object({
  productId: z.number().int().positive(),
  quantity: z.number().int().min(1).max(99),
})

router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.userId!
    const { productId, quantity } = addCartSchema.parse(req.body)

    const product = await prisma.product.findFirst({ where: { id: productId, deletedAt: null } })
    if (!product) throw new AppError(40401, '商品不存在', 404)
    if (product.status !== 'ON_SHELF') throw new AppError(42202, '商品已下架')
    if (product.stock < quantity) throw new AppError(42201, '库存不足')

    const existing = await prisma.cart.findUnique({
      where: { userId_productId: { userId, productId } },
    })

    let cart
    if (existing) {
      const newQty = Math.min(existing.quantity + quantity, product.stock)
      cart = await prisma.cart.update({ where: { id: existing.id }, data: { quantity: newQty } })
    } else {
      cart = await prisma.cart.create({ data: { userId, productId, quantity, isSelected: 1 } })
    }

    success(res, { id: cart.id })
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

    const item = await prisma.cart.findFirst({ where: { id, userId } })
    if (!item) throw new AppError(40401, '购物车项不存在', 404)

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
