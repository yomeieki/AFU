import { Router, Request, Response, NextFunction } from 'express'
import { z } from 'zod'
import prisma from '../../utils/prisma'
import { success } from '../../utils/response'
import { AppError } from '../../middlewares/error'
import { channelSchema, parseChannelQuery } from '../../utils/channel'
import { changeCategoryChannel } from '../../services/product-channel'
import { PRODUCT_SORT_MODES } from '../../services/product-sort'
import { clearProductSalesCache } from '../../services/product-sales'

const router = Router()

// 同 products.ts：.partial() 不会剥离 .default()，默认值只能加在创建路径上，
// 否则部分更新会把请求里没带的 sortOrder/status 静默重置。
// productSortMode 不用 .default()、用 .optional()：创建时不带则 Prisma 不写这个 key，
// 交给库的 DEFAULT 'MANUAL' 兜底（而不是在应用层硬编码一份默认值）；部分更新不带这个
// 字段时同样不会动它，不会把已设的值静默重置。
const categoryBaseSchema = z.object({
  name: z.string().min(1, '分类名称不能为空').max(64),
  iconUrl: z.string().max(500).nullable().optional(),
  sortOrder: z.number().int(),
  status: z.number().int().min(0).max(1),
  channel: channelSchema,
  productSortMode: z.enum(PRODUCT_SORT_MODES).optional(),
})

const categoryCreateSchema = categoryBaseSchema.extend({
  sortOrder: categoryBaseSchema.shape.sortOrder.default(0),
  status: categoryBaseSchema.shape.status.default(1),
  channel: categoryBaseSchema.shape.channel.default('EXPRESS'),
})

const categoryUpdateSchema = categoryBaseSchema.partial()

// GET /api/admin/categories
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const channel = req.query.channel ? parseChannelQuery(req.query.channel) : undefined
    const categories = await prisma.category.findMany({
      where: channel ? { channel } : {},
      orderBy: [{ channel: 'asc' }, { sortOrder: 'asc' }],
      include: { _count: { select: { products: { where: { deletedAt: null } } } } },
    })
    success(res, categories)
  } catch (e) {
    next(e)
  }
})

// POST /api/admin/categories
router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = categoryCreateSchema.parse(req.body)
    const category = await prisma.category.create({ data })
    success(res, category)
  } catch (e) {
    next(e)
  }
})

// PUT /api/admin/categories/:id
router.put('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id)
    const exists = await prisma.category.findUnique({ where: { id } })
    if (!exists) throw new AppError(40401, '分类不存在', 404)

    const { channel, ...data } = categoryUpdateSchema.parse(req.body)
    if (channel && channel !== exists.channel) {
      await changeCategoryChannel(id, channel)
    }
    const category = await prisma.category.update({ where: { id }, data })
    // 排序方式真的变了才清缓存：切换会立刻影响公开列表的排序结果（销量聚合本身没变）。
    if (data.productSortMode !== undefined && data.productSortMode !== exists.productSortMode) {
      clearProductSalesCache()
    }
    success(res, category)
  } catch (e) {
    next(e)
  }
})

// POST /api/admin/categories/:id/product-order
// body { ids: number[] }：按数组下标写 sort_order = index；ids 必须正好是该分类下全部
// 未删除商品（多、少、重复、跨分类一律 40001），事务内查全集+批量更新，防止并发编辑打架
// （2026-09-17 分类内排序设计 §4.2）。
const productOrderSchema = z.object({ ids: z.array(z.number().int().positive()) })
router.post('/:id/product-order', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id)
    const category = await prisma.category.findUnique({ where: { id } })
    if (!category) throw new AppError(40401, '分类不存在', 404)

    const { ids } = productOrderSchema.parse(req.body)

    await prisma.$transaction(async (tx) => {
      const existing = await tx.product.findMany({ where: { categoryId: id, deletedAt: null }, select: { id: true } })
      const existingIds = new Set(existing.map((p) => p.id))
      const uniqueIds = new Set(ids)
      const isSameSet = ids.length === existingIds.size && uniqueIds.size === ids.length && ids.every((pid) => existingIds.has(pid))
      if (!isSameSet) {
        throw new AppError(40001, '商品列表与该分类当前商品不一致，请刷新后重试')
      }
      // 锁序（2026-09-24，L 级复核 R4 成立，店主选项 A）：按请求体原始顺序逐个 update 会让
      // 本接口与「多商品订单按 productId 升序扣库存」（routes/orders.ts）反向，两者并发同一
      // 批商品时有成环风险（同源于全局锁序 L2）。这里按商品 id 升序处理，`sortOrder` 仍取
      // 该 id 在请求体里的原始下标——语义不变，只改加锁顺序（店员拖拽排序是低频操作，不加
      // 重试，与整包编辑商品同类留后项一致：靠下单侧的重试兜底）。
      for (const [i, pid] of [...ids.entries()].sort((a, b) => a[1] - b[1])) {
        await tx.product.update({ where: { id: pid }, data: { sortOrder: i } })
      }
    })

    clearProductSalesCache()
    success(res, { updated: ids.length })
  } catch (e) {
    next(e)
  }
})

// DELETE /api/admin/categories/:id
router.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id)
    const exists = await prisma.category.findUnique({ where: { id } })
    if (!exists) throw new AppError(40401, '分类不存在', 404)

    const productCount = await prisma.product.count({
      where: { categoryId: id, deletedAt: null },
    })
    if (productCount > 0) {
      throw new AppError(40901, `该分类下还有 ${productCount} 个商品，请先移除商品再删除`)
    }

    await prisma.category.delete({ where: { id } })
    success(res, null, '删除成功')
  } catch (e) {
    next(e)
  }
})

export default router
