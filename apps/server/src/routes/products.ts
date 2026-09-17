import { Router, Request, Response, NextFunction } from 'express'
import prisma from '../utils/prisma'
import { success, paginate } from '../utils/response'
import { AppError } from '../middlewares/error'
import { parseChannelQuery } from '../utils/channel'
import { getLocalSettings } from '../services/local-settings'
import { packingFeeEach } from '../services/packing-fee'
import { sortProducts, type CategorySortInfo, type ProductSortMode } from '../services/product-sort'
import { getSales30d } from '../services/product-sales'

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

    // 排序：不同分类可能用不同规则（手动排 / 近 30 天销量），SQL 一条 ORDER BY 表达不了，
    // 所以整表取回该渠道上架商品 → 交给 services/product-sort.ts 的 sortProducts 在内存里排 →
    // 再分页。数据量小（同城 121 道、邮寄 19 道，2026-09-17 实测），成本远小于一次网络往返。
    // 列表本身不加缓存（否则上下架/改库存/下单扣库存会在顾客端滞后），只有销量聚合走 60s 缓存
    // （见 product-sales.ts）；规则详见 2026-09-17 分类内排序设计 §4.1。
    const [rows, cats, sales] = await Promise.all([
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
          categoryId: true,
          sortOrder: true,
          isRecommended: true,
          createdAt: true,
          _count: { select: { skus: true } },
        },
      }),
      prisma.category.findMany({ where: { channel }, select: { id: true, sortOrder: true, productSortMode: true } }),
      getSales30d(),
    ])
    const catMap = new Map<number, CategorySortInfo>(
      cats.map((c) => [c.id, { sortOrder: c.sortOrder, productSortMode: c.productSortMode as ProductSortMode }]),
    )
    const sorted = sortProducts(rows, catMap, sales)
    const total = sorted.length
    const page1 = sorted.slice((page - 1) * pageSize, page * pageSize)

    // 打包费预览（2026-09-13 打包费设计 §3.1）：packingFeeEach 是「已解析出的单份实收」，
    // 一个请求只取一次设置（60s 缓存），不必每条商品各查一遍。
    const s = await getLocalSettings()
    // 多规格商品价格为最低 SKU 价（冗余同步），前端据 hasSkus 显示「¥xx起」
    // isRecommended、createdAt 只用于排序，输出前剥掉；categoryId、sortOrder 保留供后台/联动使用。
    const items = page1.map(({ _count, isRecommended, createdAt, ...p }) => ({
      ...p,
      hasSkus: _count.skus > 0,
      packingFeeEach: packingFeeEach(s, p),
    }))
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
