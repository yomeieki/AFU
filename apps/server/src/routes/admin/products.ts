import { Router, Request, Response, NextFunction } from 'express'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import prisma from '../../utils/prisma'
import { success, paginate } from '../../utils/response'
import { AppError } from '../../middlewares/error'
import { generateProductQrCode } from '../../services/qrcode'
import { channelSchema, parseChannelQuery } from '../../utils/channel'
import { channelOfCategory, assertNoUnpaidAndPurgeCarts } from '../../services/product-channel'
import { Channel } from '../../utils/channel'
import { sortProducts, type CategorySortInfo, type ProductSortMode } from '../../services/product-sort'
import { getSales30d } from '../../services/product-sales'
import { getLowStockSettings } from '../../services/low-stock-settings'
import { lowStockOverview, productAlertSummary } from '../../services/low-stock'

const router = Router()

const specDimensionSchema = z.object({
  name: z.string().min(1, '规格维度名不能为空').max(32),
  values: z.array(z.string().min(1).max(32)).min(1, '规格维度至少一个值').max(20),
})

const skuSchema = z.object({
  id: z.number().int().positive().optional(),
  specText: z.string().min(1).max(128),
  specValues: z.array(z.string().min(1).max(32)).min(1),
  price: z.number().int().positive('规格价格必须大于 0'),
  originalPrice: z.number().int().positive().nullable().optional(),
  stock: z.number().int().min(0).default(0),
  sortOrder: z.number().int().min(0).default(0),
})

// 商品字段基线：一律不带 .default()。
// zod 的 .partial() 只把字段变成 optional，不会剥离 .default()——带默认值的字段
// 在部分更新时仍会被填成默认值，把请求里没带的 status/isRecommended 等静默重置。
// 所以默认值只叠加在创建路径（productCreateSchema）上，更新走 productUpdateSchema。
const productBaseSchema = z.object({
  categoryId: z.number().int().positive('分类不能为空'),
  name: z.string().min(1, '商品名称不能为空').max(128),
  subtitle: z.string().max(255).nullable().optional(),
  coverImage: z.string().max(500).nullable().optional(),
  price: z.number().int().positive('价格必须大于 0'),
  originalPrice: z.number().int().positive().nullable().optional(),
  stock: z.number().int().min(0),
  unit: z.string().max(16),
  weight: z.string().max(32).nullable().optional(),
  shelfLife: z.string().max(64).nullable().optional(),
  storageMethod: z.string().max(128).nullable().optional(),
  deliveryInfo: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  status: z.enum(['ON_SHELF', 'OFF_SHELF']),
  // @deprecated 兼容旧后台仍可能传入；服务端忽略，渠道以分类为准
  deliveryType: z.string().max(64).optional(),
  netWeightG: z.number().int().min(1).max(50_000).nullable().optional(),
  // 打包费商品级覆盖（2026-09-13 打包费设计 §2.1）：null=跟随全店默认，0=不收，>0=按这个数（分）。
  packingFeeFen: z.number().int().min(0).max(10_000).nullable().optional(),
  isRecommended: z.number().int().min(0).max(1),
  // 商品多图（详情轮播），按数组顺序作为 sortOrder 同步到 ProductImage
  imageUrls: z.array(z.string().max(500)).max(9).optional(),
  // 规格维度 + SKU 组合；specDimensions 为 null/[] 且 skus 为空 = 无规格商品
  specDimensions: z.array(specDimensionSchema).max(3).nullable().optional(),
  skus: z.array(skuSchema).max(60).optional(),
})

// 创建：缺省字段补默认值
const productCreateSchema = productBaseSchema.extend({
  stock: productBaseSchema.shape.stock.default(0),
  unit: productBaseSchema.shape.unit.default('份'),
  status: productBaseSchema.shape.status.default('ON_SHELF'),
  // deliveryType 在本分支已废弃（渠道以分类为准），本就无默认值，不再叠加
  isRecommended: productBaseSchema.shape.isRecommended.default(0),
})

// 更新：只写请求里显式带的字段，没带的一律不动
const productUpdateSchema = productBaseSchema.partial()

/** 校验维度与 SKU 组合一致性；返回规范化后的 dimensions（null=无规格） */
function validateSpecs(
  specDimensions: z.infer<typeof specDimensionSchema>[] | null | undefined,
  skus: z.infer<typeof skuSchema>[] | undefined
) {
  const dims = specDimensions?.length ? specDimensions : null
  const skuList = skus ?? []
  if (dims && skuList.length === 0) {
    throw new AppError(40001, '配置了规格维度但未提供任何规格组合', 400)
  }
  if (!dims && skuList.length > 0) {
    throw new AppError(40001, '提供了规格组合但缺少规格维度定义', 400)
  }
  if (!dims) return { dims: null, skuList: [] }

  const seen = new Set<string>()
  for (const sku of skuList) {
    if (sku.specValues.length !== dims.length) {
      throw new AppError(40001, `规格「${sku.specText}」的值数量与维度数不一致`, 400)
    }
    sku.specValues.forEach((v, i) => {
      if (!dims[i].values.includes(v)) {
        throw new AppError(40001, `规格值「${v}」不在维度「${dims[i].name}」中`, 400)
      }
    })
    const joined = sku.specValues.join('/')
    if (sku.specText !== joined) {
      throw new AppError(40001, `规格「${sku.specText}」与其值组合「${joined}」不一致`, 400)
    }
    if (seen.has(sku.specText)) {
      throw new AppError(40001, `规格「${sku.specText}」重复`, 400)
    }
    seen.add(sku.specText)
  }
  return { dims, skuList }
}

/** 有 SKU 时按 SKU 汇总回写商品冗余字段（price=min, stock=sum, originalPrice=min价 SKU 的原价） */
function aggregateFromSkus(skuList: z.infer<typeof skuSchema>[]) {
  const minPriceSku = skuList.reduce((m, s) => (s.price < m.price ? s : m), skuList[0])
  return {
    price: minPriceSku.price,
    originalPrice: minPriceSku.originalPrice ?? null,
    stock: skuList.reduce((sum, s) => sum + s.stock, 0),
  }
}

const skuInclude = {
  images: { orderBy: { sortOrder: 'asc' as const } },
  skus: { orderBy: { sortOrder: 'asc' as const } },
}

// GET /api/admin/products
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1)
    // 上限从 50 提到 200：选定分类时拖拽排序要求一页取完该分类全集（2026-09-17 分类内排序设计 §5）。
    const pageSize = Math.min(200, Math.max(1, Number(req.query.pageSize) || 20))
    const categoryId = req.query.categoryId ? Number(req.query.categoryId) : undefined
    const keyword = req.query.keyword as string | undefined
    const status = req.query.status as string | undefined
    const channel = req.query.channel ? parseChannelQuery(req.query.channel) : undefined

    const where = {
      deletedAt: null,
      ...(channel ? { channel } : {}),
      ...(categoryId ? { categoryId } : {}),
      ...(status ? { status } : {}),
      ...(keyword ? { name: { contains: keyword } } : {}),
    }

    const sales = await getSales30d()
    const lowStockSettings = await getLowStockSettings()
    const withSales = <T extends { id: number; status: string; stock: number; skus?: { stock: number }[] }>(rows: T[]) =>
      rows.map((p) => ({ ...p, sales30d: sales.get(p.id) ?? 0, stockAlert: productAlertSummary(p, lowStockSettings) }))

    let list: unknown[]
    let total: number

    if (categoryId) {
      // 选定分类：顺序与顾客端一致（同一套 sortProducts），一次取该分类全集再内存分页。
      const category = await prisma.category.findUnique({ where: { id: categoryId }, select: { sortOrder: true, productSortMode: true } })
      const rows = await prisma.product.findMany({
        where,
        include: {
          category: { select: { id: true, name: true } },
          images: { select: { imageUrl: true }, orderBy: { sortOrder: 'asc' } },
          skus: { orderBy: { sortOrder: 'asc' } },
        },
      })
      const catMap = new Map<number, CategorySortInfo>(
        category ? [[categoryId, { sortOrder: category.sortOrder, productSortMode: category.productSortMode as ProductSortMode }]] : [],
      )
      const sorted = sortProducts(rows, catMap, sales)
      total = sorted.length
      list = withSales(sorted.slice((page - 1) * pageSize, page * pageSize))
    } else {
      const [rows, count] = await prisma.$transaction([
        prisma.product.findMany({
          where,
          include: {
            category: { select: { id: true, name: true } },
            images: { select: { imageUrl: true }, orderBy: { sortOrder: 'asc' } },
            skus: { orderBy: { sortOrder: 'asc' } },
          },
          orderBy: { createdAt: 'desc' },
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
        prisma.product.count({ where }),
      ])
      total = count
      list = withSales(rows)
    }

    paginate(res, list, total, page, pageSize)
  } catch (e) {
    next(e)
  }
})

// POST /api/admin/products
router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { imageUrls, specDimensions, skus, ...data } = productCreateSchema.parse(req.body)
    const { deliveryType: _ignored, ...rest } = data
    const channel = await channelOfCategory(prisma, rest.categoryId)

    const { dims, skuList } = validateSpecs(specDimensions, skus)

    // 新建商品排到本分类最后（S6）：取该分类当前最大 sortOrder + 1；空分类得 0。
    const { _max } = await prisma.product.aggregate({
      where: { categoryId: rest.categoryId, deletedAt: null },
      _max: { sortOrder: true },
    })
    const sortOrder = (_max.sortOrder ?? -1) + 1

    const product = await prisma.product.create({
      data: {
        ...rest,
        channel,
        sortOrder,
        ...(dims ? aggregateFromSkus(skuList) : {}),
        specDimensions: dims ?? Prisma.DbNull,
        ...(imageUrls?.length
          ? { images: { create: imageUrls.map((imageUrl, i) => ({ imageUrl, sortOrder: i })) } }
          : {}),
        ...(skuList.length
          ? {
              skus: {
                create: skuList.map((s, i) => ({
                  specText: s.specText,
                  specValues: s.specValues,
                  price: s.price,
                  originalPrice: s.originalPrice ?? null,
                  stock: s.stock,
                  sortOrder: s.sortOrder ?? i,
                })),
              },
            }
          : {}),
      },
      include: skuInclude,
    })
    // R2-3（修订 2）：与列表同一口径下发 stockAlert，前端局部合并时不必自己算、
    // 也不受 pending-count 30 秒轮询门槛陈旧的影响
    success(res, { ...product, stockAlert: productAlertSummary(product, await getLowStockSettings()) })
  } catch (e) {
    next(e)
  }
})

// PUT /api/admin/products/:id
// POST /api/admin/products/batch-status — 批量上/下架（开档/收档）
// categoryId 缺省 = 全部商品
const batchStatusSchema = z.object({
  status: z.enum(['ON_SHELF', 'OFF_SHELF']),
  categoryId: z.number().int().positive().optional(),
  channel: channelSchema.optional(),
})

router.post('/batch-status', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { status, categoryId, channel } = batchStatusSchema.parse(req.body ?? {})
    const result = await prisma.product.updateMany({
      where: { deletedAt: null, ...(channel ? { channel } : {}), ...(categoryId ? { categoryId } : {}) },
      data: { status },
    })
    success(res, { updated: result.count })
  } catch (e) {
    next(e)
  }
})

// POST /api/admin/products/qrcode/batch — 批量生成二维码
// 注意：必须注册在 /:id 类路由之前，避免 "qrcode" 被当作 :id 匹配
router.post('/qrcode/batch', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { ids } = z.object({ ids: z.array(z.number().int().positive()).optional() }).parse(req.body ?? {})
    // 缺省 = 所有无二维码的上架商品
    const targets = await prisma.product.findMany({
      where: ids?.length
        ? { id: { in: ids }, deletedAt: null }
        : { deletedAt: null, status: 'ON_SHELF', qrCodeUrl: null },
      select: { id: true },
    })

    let generated = 0
    const failed: number[] = []
    for (const t of targets) {
      try {
        const { scene, qrCodeUrl } = await generateProductQrCode(t.id)
        await prisma.product.update({
          where: { id: t.id },
          data: { qrScene: scene, qrCodeUrl, qrGeneratedAt: new Date() },
        })
        generated++
      } catch {
        failed.push(t.id)
      }
    }
    success(res, { generated, failed })
  } catch (e) {
    next(e)
  }
})

// GET /api/admin/products/low-stock — 库存预警总览（后台新页签，2026-09-24）
// 注意：必须注册在 /:id 类路由之前，避免 "low-stock" 被当作 :id 匹配
router.get('/low-stock', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    success(res, await lowStockOverview())
  } catch (e) {
    next(e)
  }
})

// PUT /api/admin/products/:id/stock — 库存预警页/商品列表库存快改（按规格或无规格商品本身）
//
// R1（2026-09-24 修订 2，L 级复核阻断）：有规格分支不能再「改 sku → aggregate 全部 sku →
// 绝对覆盖 product.stock」——REPEATABLE-READ 下 aggregate 读到的是事务开始时的快照，读不到
// 并发下单扣减/取消回滚已提交或在途的其它 sku 行，绝对覆盖会把它们的改动冲掉（复核实测
// product=15 而 SUM=14 一类的丢更新）。改为「锁读旧值 + 相对增量」：
//   1. `SELECT ... FOR UPDATE` 锁住并读到这一刻的真实旧值（不是快照）；
//   2. 把这一个 sku 写成店员实点的绝对值；
//   3. product.stock 只按 `delta = 新值 − 旧值` 相对增量，不去动其它 sku 贡献的部分。
// 锁序 sku → product，与 routes/orders.ts:612-623（下单扣减）、utils/order-stock.ts:19-30
// （取消/退款回滚）同序，两个「单行」事务之间不会互相等待成环。唯一会成环的是
// 「一张跨两个 sku 的订单」与「这个改库存请求」互锁——这与既有的「两笔多行订单以不同
// 顺序扣同一商品」是同一类死锁，InnoDB 会立即探测到并选一方做牺牲者（MySQL 1213 →
// Prisma P2034），所以这里对 P2034 做有限重试；无规格分支没有 sum 不变量，维持绝对值写入
// （与既有 `PUT /:id {stock}` 的编辑语义一致）。
const stockUpdateSchema = z.object({
  skuId: z.number().int().positive().nullable().optional(),
  stock: z.number().int().min(0).max(999999),
})

type StockUpdateResult = { productId: number; skuId: number | null; stock: number; productStock: number }

function isDeadlockRetry(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2034'
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const STOCK_UPDATE_MAX_ATTEMPTS = 3

router.put('/:id/stock', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id)
    const { skuId, stock } = stockUpdateSchema.parse(req.body)

    let result: StockUpdateResult | null = null
    for (let attempt = 1; attempt <= STOCK_UPDATE_MAX_ATTEMPTS; attempt++) {
      try {
        result = await prisma.$transaction(async (tx) => {
          const product = await tx.product.findFirst({ where: { id, deletedAt: null } })
          if (!product) throw new AppError(40401, '商品不存在', 404)
          const skuCount = await tx.productSku.count({ where: { productId: id } })
          if (skuId != null) {
            if (skuCount === 0) throw new AppError(40001, '该商品没有规格，请直接改库存', 400)
            // 锁定读：拿到的是这一刻的真实值，不是事务开始时的一致性快照
            const locked = await tx.$queryRaw<
              { id: number; stock: number }[]
            >`SELECT id, stock FROM product_skus WHERE id = ${skuId} AND product_id = ${id} FOR UPDATE`
            if (locked.length === 0) throw new AppError(40401, '规格不存在', 404)
            const prevStock = locked[0].stock
            await tx.productSku.update({ where: { id: skuId }, data: { stock } })
            const delta = stock - prevStock
            const updated = await tx.product.update({ where: { id }, data: { stock: { increment: delta } } })
            return { productId: id, skuId, stock, productStock: updated.stock }
          }
          if (skuCount > 0) throw new AppError(40001, '多规格商品请按规格改库存', 400)
          // 无规格商品没有 sum 不变量：维持绝对值写入，语义同既有 PUT /:id {stock}
          const updated = await tx.product.update({ where: { id }, data: { stock } })
          return { productId: id, skuId: null, stock, productStock: updated.stock }
        })
        break
      } catch (e) {
        if (isDeadlockRetry(e) && attempt < STOCK_UPDATE_MAX_ATTEMPTS) {
          console.warn(`[products] 改库存遇死锁，重试 ${attempt}/${STOCK_UPDATE_MAX_ATTEMPTS}`)
          await sleep(50 * attempt)
          continue
        }
        throw e
      }
    }
    success(res, result)
  } catch (e) {
    next(e)
  }
})

router.put('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id)
    const exists = await prisma.product.findFirst({ where: { id, deletedAt: null } })
    if (!exists) throw new AppError(40401, '商品不存在', 404)

    const { imageUrls, specDimensions, skus, ...data } = productUpdateSchema.parse(req.body)
    const { deliveryType: _ignored, ...rest } = data
    // 换分类时渠道跟随分类（同事务内取，防止读到并发改渠道前的旧值）

    // 只有请求显式携带规格字段时才动规格（partial 更新语义与 imageUrls 一致）
    const touchSpecs = specDimensions !== undefined || skus !== undefined

    const product = await prisma.$transaction(async (tx) => {
      // 传了 imageUrls 时全量替换多图（未传则不动）
      if (imageUrls !== undefined) {
        await tx.productImage.deleteMany({ where: { productId: id } })
        if (imageUrls.length > 0) {
          await tx.productImage.createMany({
            data: imageUrls.map((imageUrl, i) => ({ productId: id, imageUrl, sortOrder: i })),
          })
        }
      }

      let specData: Record<string, unknown> = {}
      if (touchSpecs) {
        const { dims, skuList } = validateSpecs(specDimensions ?? null, skus)

        // diff 同步 SKU：有 id 且仍存在→更新；无 id→创建；库里有但本次未带→删除（cascade 清购物车）
        const existing = await tx.productSku.findMany({ where: { productId: id } })
        const keepIds = new Set(skuList.filter((s) => s.id).map((s) => s.id!))
        const toDelete = existing.filter((e) => !keepIds.has(e.id)).map((e) => e.id)
        if (toDelete.length) {
          await tx.productSku.deleteMany({ where: { id: { in: toDelete }, productId: id } })
        }
        for (let i = 0; i < skuList.length; i++) {
          const s = skuList[i]
          const payload = {
            specText: s.specText,
            specValues: s.specValues,
            price: s.price,
            originalPrice: s.originalPrice ?? null,
            stock: s.stock,
            sortOrder: s.sortOrder ?? i,
          }
          if (s.id && existing.some((e) => e.id === s.id)) {
            await tx.productSku.update({ where: { id: s.id }, data: payload })
          } else {
            await tx.productSku.create({ data: { ...payload, productId: id } })
          }
        }

        specData = {
          specDimensions: dims ?? Prisma.DbNull,
          ...(dims ? aggregateFromSkus(skuList) : {}),
        }
      }

      // 换分类时渠道跟随新分类。若跨了渠道，必须走与「分类改渠道」同一套防线：
      // 否则这个入口能绕过待付款订单校验，并让顾客购物车里的行静默换渠道（刷新后商品无声消失）。
      let channelPatch: { channel?: Channel; sortOrder?: number } = {}
      if (rest.categoryId !== undefined) {
        const nextChannel = await channelOfCategory(tx, rest.categoryId)
        if (nextChannel !== exists.channel) {
          await assertNoUnpaidAndPurgeCarts(tx, [id])
        }
        channelPatch = { channel: nextChannel }
        // 换到另一个分类时，旧的 sortOrder（多为 0）会让它跳到新分类最前；
        // 取新分类当前最大值 +1，视觉上排到新分类最后（S6 精神，spec 未写换分类场景）。
        if (rest.categoryId !== exists.categoryId) {
          const { _max } = await tx.product.aggregate({
            where: { categoryId: rest.categoryId, deletedAt: null },
            _max: { sortOrder: true },
          })
          channelPatch.sortOrder = (_max.sortOrder ?? -1) + 1
        }
      }
      return tx.product.update({
        where: { id },
        data: { ...rest, ...channelPatch, ...specData },
        include: skuInclude,
      })
    })
    // R2-3（修订 2）：局部更新（上下架/改库存走这个整包 PUT 的调用方也会经过这里）响应
    // 补 stockAlert，前端不必整页刷新就能拿到最新值
    success(res, { ...product, stockAlert: productAlertSummary(product, await getLowStockSettings()) })
  } catch (e) {
    next(e)
  }
})

// DELETE /api/admin/products/:id  (软删除)
router.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id)
    const exists = await prisma.product.findFirst({ where: { id, deletedAt: null } })
    if (!exists) throw new AppError(40401, '商品不存在', 404)

    await prisma.product.update({
      where: { id },
      data: { deletedAt: new Date() },
    })
    success(res, null, '删除成功')
  } catch (e) {
    next(e)
  }
})

// POST /api/admin/products/:id/qrcode
router.post('/:id/qrcode', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id)
    const product = await prisma.product.findFirst({ where: { id, deletedAt: null } })
    if (!product) throw new AppError(40401, '商品不存在', 404)

    const { scene, qrCodeUrl } = await generateProductQrCode(id)
    const now = new Date()

    const updated = await prisma.product.update({
      where: { id },
      data: { qrScene: scene, qrCodeUrl, qrGeneratedAt: now },
    })

    success(res, {
      qrCodeUrl: updated.qrCodeUrl,
      qrScene: updated.qrScene,
      qrGeneratedAt: updated.qrGeneratedAt,
    })
  } catch (e) {
    next(e)
  }
})

export default router
