import { Router, Request, Response, NextFunction } from 'express'
import { z } from 'zod'
import prisma from '../../utils/prisma'
import { success } from '../../utils/response'
import { AppError } from '../../middlewares/error'

const router = Router()

const bannerSchema = z.object({
  title: z.string().max(64).optional().nullable(),
  imageUrl: z.string().min(1, '请上传图片').max(500),
  linkType: z.enum(['none', 'product']).default('none'),
  productId: z.number().int().positive().optional().nullable(),
  sortOrder: z.number().int().default(0),
  status: z.number().int().min(0).max(1).default(1),
})

async function validateLink(data: { linkType: string; productId?: number | null }) {
  if (data.linkType === 'product') {
    if (!data.productId) throw new AppError(40001, '跳转商品时必须选择商品')
    const p = await prisma.product.findFirst({ where: { id: data.productId, deletedAt: null } })
    if (!p) throw new AppError(40401, '所选商品不存在', 404)
  }
}

// GET /api/admin/banners — 全量（量小不分页）
router.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const list = await prisma.banner.findMany({
      orderBy: [{ sortOrder: 'asc' }, { id: 'desc' }],
    })
    success(res, list)
  } catch (e) {
    next(e)
  }
})

// POST /api/admin/banners
router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = bannerSchema.parse(req.body)
    await validateLink(data)
    const banner = await prisma.banner.create({
      data: { ...data, productId: data.linkType === 'product' ? data.productId : null },
    })
    success(res, banner)
  } catch (e) {
    next(e)
  }
})

// PUT /api/admin/banners/:id/status
router.put('/:id/status', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id)
    const { status } = z.object({ status: z.number().int().min(0).max(1) }).parse(req.body)
    const banner = await prisma.banner.update({ where: { id }, data: { status } })
    success(res, banner)
  } catch (e) {
    next(e)
  }
})

// PUT /api/admin/banners/:id
router.put('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id)
    const data = bannerSchema.parse(req.body)
    await validateLink(data)
    const banner = await prisma.banner.update({
      where: { id },
      data: { ...data, productId: data.linkType === 'product' ? data.productId : null },
    })
    success(res, banner)
  } catch (e) {
    next(e)
  }
})

// DELETE /api/admin/banners/:id
router.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id)
    await prisma.banner.delete({ where: { id } })
    success(res, null)
  } catch (e) {
    next(e)
  }
})

export default router
