import { Router, Request, Response, NextFunction } from 'express'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import prisma from '../../utils/prisma'
import { success, paginate } from '../../utils/response'
import { AppError } from '../../middlewares/error'
import { generateProductQrCode } from '../../services/qrcode'

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

      return tx.product.update({
        where: { id },
        data: { ...data, ...specData },
        include: skuInclude,
      })
    })
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
