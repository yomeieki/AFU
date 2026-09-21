import { Router, Request, Response, NextFunction } from 'express'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import prisma from '../../utils/prisma'
import { success, paginate } from '../../utils/response'
import { AppError } from '../../middlewares/error'
import { generateProductQrCode } from '../../services/qrcode'
import { specDimensionSchema, skuSchema, validateSpecs, aggregateFromSkus, syncProductSkus } from '../../services/specs'

const router = Router()

const productSchema = z.object({
  categoryId: z.number().int().positive('分类不能为空'),
  name: z.string().min(1, '商品名称不能为空').max(128),
  subtitle: z.string().max(255).nullable().optional(),
  coverImage: z.string().max(500).nullable().optional(),
  price: z.number().int().positive('价格必须大于 0'),
  originalPrice: z.number().int().positive().nullable().optional(),
  stock: z.number().int().min(0).default(0),
  unit: z.string().max(16).default('份'),
  weight: z.string().max(32).nullable().optional(),
  shelfLife: z.string().max(64).nullable().optional(),
  storageMethod: z.string().max(128).nullable().optional(),
  deliveryInfo: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  status: z.enum(['ON_SHELF', 'OFF_SHELF']).default('ON_SHELF'),
  deliveryType: z.string().max(64).default('EXPRESS'),
  isRecommended: z.number().int().min(0).max(1).default(0),
  // 商品多图（详情轮播），按数组顺序作为 sortOrder 同步到 ProductImage
  imageUrls: z.array(z.string().max(500)).max(9).optional(),
  // 规格维度 + SKU 组合；specDimensions 为 null/[] 且 skus 为空 = 无规格商品
  specDimensions: z.array(specDimensionSchema).max(3).nullable().optional(),
  skus: z.array(skuSchema).max(60).optional(),
})

const skuInclude = {
  images: { orderBy: { sortOrder: 'asc' as const } },
  skus: { orderBy: { sortOrder: 'asc' as const } },
}

// GET /api/admin/products
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1)
    const pageSize = Math.min(50, Math.max(1, Number(req.query.pageSize) || 20))
    const categoryId = req.query.categoryId ? Number(req.query.categoryId) : undefined
    const keyword = req.query.keyword as string | undefined
    const status = req.query.status as string | undefined

    const where = {
      deletedAt: null,
      ...(categoryId ? { categoryId } : {}),
      ...(status ? { status } : {}),
      ...(keyword ? { name: { contains: keyword } } : {}),
    }

    const [list, total] = await prisma.$transaction([
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

    paginate(res, list, total, page, pageSize)
  } catch (e) {
    next(e)
  }
})

// POST /api/admin/products
router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { imageUrls, specDimensions, skus, ...data } = productSchema.parse(req.body)
    const cat = await prisma.category.findUnique({ where: { id: data.categoryId } })
    if (!cat) throw new AppError(40401, '分类不存在', 404)

    const { dims, skuList } = validateSpecs(specDimensions, skus)

    const product = await prisma.product.create({
      data: {
        ...data,
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
    success(res, product)
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
})

router.post('/batch-status', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { status, categoryId } = batchStatusSchema.parse(req.body ?? {})
    const result = await prisma.product.updateMany({
      where: { deletedAt: null, ...(categoryId ? { categoryId } : {}) },
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

router.put('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id)
    const exists = await prisma.product.findFirst({ where: { id, deletedAt: null } })
    if (!exists) throw new AppError(40401, '商品不存在', 404)

    const { imageUrls, specDimensions, skus, ...data } = productSchema.partial().parse(req.body)

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

        // 两阶段同步 SKU（见 services/specs.ts）：先删本次未携带的旧行（cascade 清购物车），
        // 再把 specText 有变化的行先改临时名，避免维度重排后两个 SKU 的 specText 互换时
        // 撞 (product_id, spec_text) 唯一索引，最后按最终值更新/创建。
        await syncProductSkus(tx, id, skuList)

        specData = {
          specDimensions: dims ?? Prisma.DbNull,
          ...(dims ? aggregateFromSkus(skuList) : {}),
        }
      }

      return tx.product.update({
        where: { id },
        data: { ...data, ...specData },
        include: skuInclude,
      })
    }, { maxWait: 5000, timeout: 20000 })
    success(res, product)
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
