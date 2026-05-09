import { Router, Request, Response, NextFunction } from 'express'
import { z } from 'zod'
import prisma from '../../utils/prisma'
import { success, paginate } from '../../utils/response'
import { AppError } from '../../middlewares/error'
import { generateProductQrCode } from '../../services/qrcode'

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
})

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
        include: { category: { select: { id: true, name: true } } },
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
    const data = productSchema.parse(req.body)
    const cat = await prisma.category.findUnique({ where: { id: data.categoryId } })
    if (!cat) throw new AppError(40401, '分类不存在', 404)

    const product = await prisma.product.create({ data })
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

    const data = productSchema.partial().parse(req.body)
    const product = await prisma.product.update({ where: { id }, data })
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
