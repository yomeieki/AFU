/**
 * 随单赠品管理（服务端；页面在 M3）。
 *
 * 「随单赠品」= 顾客在结算页用积分加购、**跟着付费订单一起履约**的商品（masterplan P3）。
 * 不是单独的 0 元兑换单——那条路要单独发货、单独退款、单独售后，本轮明确不做。
 *
 * 有 DELETE（与券模板不同）：`OrderItem` 落的是商品快照，不引用 `PointsGood.id`，
 * 所以删掉一条赠品配置不会让任何历史订单指向空。
 */
import { Router, Request, Response, NextFunction } from 'express'
import { z } from 'zod'
import prisma from '../../utils/prisma'
import { success } from '../../utils/response'
import { AppError } from '../../middlewares/error'

const router = Router()

const baseSchema = z.object({
  pointsCost: z.number().int().min(1).max(100000000),
  perOrderLimit: z.number().int().min(1).max(99).default(1),
  stockLimit: z.number().int().min(1).max(1000000).optional().nullable(),
  sortOrder: z.number().int().min(-9999).max(9999).default(0),
  status: z.enum(['ON', 'OFF']).default('ON'),
})
const createSchema = baseSchema.extend({
  productId: z.number().int().positive(),
  skuId: z.number().int().positive().optional().nullable(),
})
// productId / skuId 不可改：改了就是换了一件商品，等于另一条配置。
// 允许改会让「这条赠品历史上送的是什么」无从追溯，而新建一条的成本是零。
const updateSchema = baseSchema.partial()

// GET /api/admin/points-goods
router.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const list = await prisma.pointsGood.findMany({ orderBy: [{ sortOrder: 'asc' }, { id: 'desc' }] })
    // PointsGood 没有 product/sku 关系字段（普通 Int 列），批量捞一次拼上，别在 map 里逐条查
    const products = list.length
      ? await prisma.product.findMany({
          where: { id: { in: [...new Set(list.map((g) => g.productId))] } },
          select: { id: true, name: true, coverImage: true, stock: true, status: true, channel: true, deletedAt: true },
        })
      : []
    const skuIds = list.map((g) => g.skuId).filter((v): v is number => v !== null)
    const skus = skuIds.length
      ? await prisma.productSku.findMany({ where: { id: { in: skuIds } }, select: { id: true, specText: true, stock: true } })
      : []
    const productById = new Map(products.map((p) => [p.id, p]))
    const skuById = new Map(skus.map((s) => [s.id, s]))
    success(
      res,
      list.map((g) => {
        const p = productById.get(g.productId)
        const s = g.skuId !== null ? skuById.get(g.skuId) : undefined
        return {
          ...g,
          // 把商品当前状态一并带出来：后台要能一眼看出「这条赠品配着，但商品已经下架/删了」
          // ——那种配置在顾客侧是隐形的（loadCheckoutOptions 会过滤掉），不显式标出来店主永远不知道。
          productName: p?.name ?? null,
          productImage: p?.coverImage ?? null,
          productStatus: p?.deletedAt ? 'DELETED' : (p?.status ?? 'MISSING'),
          productChannel: p?.channel ?? null,
          specText: s?.specText ?? null,
          stock: s ? s.stock : (p?.stock ?? 0),
        }
      })
    )
  } catch (e) {
    next(e)
  }
})

// POST /api/admin/points-goods
router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = createSchema.parse(req.body)
    const product = await prisma.product.findFirst({
      where: { id: data.productId, deletedAt: null },
      include: { skus: { select: { id: true } } },
    })
    if (!product) throw new AppError(40401, '商品不存在', 404)
    // 有 SKU 的商品必须指定规格：不指定就不知道该扣哪个规格的库存、票面也打不出规格
    if (product.skus.length > 0) {
      if (!data.skuId) throw new AppError(40001, '该商品有规格，请选择具体规格')
      if (!product.skus.some((s) => s.id === data.skuId)) throw new AppError(40401, '商品规格不存在', 404)
    } else if (data.skuId) {
      throw new AppError(40001, '该商品无规格')
    }
    // ⚠️ `@@unique([productId, skuId])` 在 MySQL 下**不约束 NULL**：无 SKU 商品可以插进多条
    // (productId, NULL)，唯一索引拦不住。所以这里先查一次（与 Cart 表同款处理）。
    // 有 SKU 的那一支交给唯一索引即可，但一并在这里查掉，错误消息比 P2002 好读。
    const dup = await prisma.pointsGood.findFirst({
      where: { productId: data.productId, skuId: data.skuId ?? null },
    })
    if (dup) throw new AppError(40001, '该商品（规格）已配置为赠品，请直接编辑')
    success(res, await prisma.pointsGood.create({ data: { ...data, skuId: data.skuId ?? null } }))
  } catch (e) {
    next(e)
  }
})

// PUT /api/admin/points-goods/:id
router.put('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id)
    if (!Number.isInteger(id) || id <= 0) throw new AppError(40001, '无效的赠品 ID')
    const data = updateSchema.parse(req.body)
    const exists = await prisma.pointsGood.findUnique({ where: { id } })
    if (!exists) throw new AppError(40401, '赠品配置不存在', 404)
    success(res, await prisma.pointsGood.update({ where: { id }, data }))
  } catch (e) {
    next(e)
  }
})

// DELETE /api/admin/points-goods/:id — 硬删（OrderItem 不引用它的 id，历史订单不受影响）
router.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id)
    if (!Number.isInteger(id) || id <= 0) throw new AppError(40001, '无效的赠品 ID')
    const deleted = await prisma.pointsGood.deleteMany({ where: { id } })
    if (deleted.count === 0) throw new AppError(40401, '赠品配置不存在', 404)
    success(res, { ok: true })
  } catch (e) {
    next(e)
  }
})

export default router
