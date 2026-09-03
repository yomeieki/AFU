import { Router, Request, Response, NextFunction } from 'express'
import { z } from 'zod'
import prisma from '../../utils/prisma'
import { success } from '../../utils/response'
import { AppError } from '../../middlewares/error'
import { channelSchema, parseChannelQuery } from '../../utils/channel'
import { changeCategoryChannel } from '../../services/product-channel'

const router = Router()

// 同 products.ts：.partial() 不会剥离 .default()，默认值只能加在创建路径上，
// 否则部分更新会把请求里没带的 sortOrder/status 静默重置。
const categoryBaseSchema = z.object({
  name: z.string().min(1, '分类名称不能为空').max(64),
  iconUrl: z.string().max(500).nullable().optional(),
  sortOrder: z.number().int(),
  status: z.number().int().min(0).max(1),
  channel: channelSchema,
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
    success(res, category)
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
