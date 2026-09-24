import { Router, Request, Response, NextFunction } from 'express'
import { z } from 'zod'
import prisma from '../utils/prisma'
import { success } from '../utils/response'
import { AppError } from '../middlewares/error'
import { parseChannelQuery } from '../utils/channel'
import { getLocalSettings } from '../services/local-settings'
import { packingFeeEach } from '../services/packing-fee'

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
            packingFeeFen: true,
          },
        },
        sku: {
          select: { id: true, specText: true, price: true, stock: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    })

    // 打包费预览（2026-09-13 打包费设计 §3.1）：结算页按这一份 × quantity 本地预览，
    // 提交后以服务端下单时重算的为准。一个请求只取一次设置，不必每行各查一遍。
    const s = await getLocalSettings()
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
        packingFeeFen: item.product.packingFeeFen,
        packingFeeEach: packingFeeEach(s, item.product),
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
    // 叠加超库存时按库存静默封顶（顾客已有 95 件、库存 100、再加 10 件 → 只加 5 件）。
    // 之前响应只回 {id, channel}，前端两个加购入口拿到成功响应一律弹「已加入」，
    // 顾客会以为按自己选的数量全加上了，实际只加了差额，只能到结算页逐行核对才发现。
    // 这里把「最终数量」与「是否被封顶」一起回传，让前端能提示真实加购结果。
    // added=本次实际加入件数：合并分支是 newQty 相对合并前的差额（被封顶时小于本次
    // 请求的 quantity）；新建分支就是 quantity 本身。前端拿它拼「本次加入 N 件」，
    // 不能直接用请求里的 quantity——那是顾客想加的数量，不是服务端真正加上的数量。
    let capped = false
    let added = quantity
    if (existing) {
      const desiredQty = existing.quantity + quantity
      const newQty = Math.min(desiredQty, availableStock)
      capped = newQty < desiredQty
      added = newQty - existing.quantity
      cart = await prisma.cart.update({ where: { id: existing.id }, data: { quantity: newQty } })
    } else {
      // 锁序对齐（2026-09-24，L 级复核 R1 成立，店主选项 A）：`INSERT carts` 的外键校验
      // 顺序是 users S → products S → product_skus S（`SHOW CREATE TABLE carts` 的二级索引
      // 插入顺序），与下单/回滚/改库存的全局锁序 L1(sku)→L2(product)→L3(user) 两处反向——
      // 加购是顾客的常规高频路径，不是后台低频操作，放任它靠 withDeadlockRetry 兜底会让
      // 「加购 vs 下单」在晚高峰热菜上变成常规重试甚至偶发穿透。这里在插入前按 L1→L2→L3
      // 顺序先拿三把共享锁（S，互不阻塞其它加购），插入时的外键 S 锁被已持有的 S 锁覆盖，
      // 与下单/回滚/改库存的 X 锁只会排队、不会成环（探针 R1-c 已证）。不包
      // `withDeadlockRetry`：它的日志文案固定是「下单遇死锁」，会污染下单侧的计数，而
      // 对齐锁序后加购本身没有已知的环，不需要重试。
      cart = await prisma.$transaction(async (tx) => {
        if (skuId) await tx.$queryRaw`SELECT id FROM product_skus WHERE id = ${skuId} FOR SHARE`
        await tx.$queryRaw`SELECT id FROM products WHERE id = ${productId} FOR SHARE`
        await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId} FOR SHARE`
        return tx.cart.create({
          data: { userId, productId, skuId: skuId ?? null, quantity, isSelected: 1 },
        })
      })
    }

    success(res, { id: cart.id, channel: product.channel, quantity: cart.quantity, capped, added })
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
