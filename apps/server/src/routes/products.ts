import { Router, Request, Response, NextFunction } from 'express'
import prisma from '../utils/prisma'
import { success, paginate } from '../utils/response'
import { AppError } from '../middlewares/error'
import { parseChannelQuery } from '../utils/channel'
import { getLocalSettings } from '../services/local-settings'
import { packingFeeEach } from '../services/packing-fee'

const router = Router()

// GET /api/products
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1)
    const pageSize = Math.min(50, Math.max(1, Number(req.query.pageSize) || 20))
    const categoryId = req.query.categoryId ? Number(req.query.categoryId) : undefined
    const keyword = req.query.keyword as string | undefined
    const channel = parseChannelQuery(req.query.channel)

    const where = {
      status: 'ON_SHELF' as const,
      deletedAt: null,
      channel,
      ...(categoryId ? { categoryId } : {}),
      ...(keyword ? { name: { contains: keyword } } : {}),
    }

    const [list, total] = await prisma.$transaction([
      prisma.product.findMany({
        where,
        select: {
          id: true,
          name: true,
          subtitle: true,
          coverImage: true,
          price: true,
          originalPrice: true,
          unit: true,
          salesCount: true,
          stock: true,
          status: true,
          channel: true,
          packingFeeFen: true,
          _count: { select: { skus: true } },
        },
        orderBy: [{ isRecommended: 'desc' }, { createdAt: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.product.count({ where }),
    ])

    // 打包费预览（2026-09-13 打包费设计 §3.1）：packingFeeEach 是「已解析出的单份实收」，
    // 一个请求只取一次设置（60s 缓存），不必每条商品各查一遍。
    const s = await getLocalSettings()
    // 多规格商品价格为最低 SKU 价（冗余同步），前端据 hasSkus 显示「¥xx起」
    const items = list.map(({ _count, ...p }) => ({ ...p, hasSkus: _count.skus > 0, packingFeeEach: packingFeeEach(s, p) }))
    paginate(res, items, total, page, pageSize)
  } catch (e) {
    next(e)
  }
})

// GET /api/products/:id
router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id)
    if (!id) throw new AppError(40001, '商品 ID 无效')

    const product = await prisma.product.findFirst({
      where: { id, deletedAt: null },
      include: {
        images: {
          orderBy: { sortOrder: 'asc' },
          select: { id: true, imageUrl: true, sortOrder: true },
        },
        category: { select: { id: true, name: true } },
        skus: {
          orderBy: { sortOrder: 'asc' },
          select: {
            id: true,
            specText: true,
            specValues: true,
            price: true,
            originalPrice: true,
            stock: true,
          },
        },
      },
    })

    if (!product) throw new AppError(40401, '商品不存在', 404)

    const s = await getLocalSettings()
    success(res, { ...product, packingFeeEach: packingFeeEach(s, product) })
  } catch (e) {
    next(e)
  }
})

export default router
