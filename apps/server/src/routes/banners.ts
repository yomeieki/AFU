import { Router, Request, Response, NextFunction } from 'express'
import prisma from '../utils/prisma'
import { success } from '../utils/response'

const router = Router()

// GET /api/banners — 小程序首页轮播（仅上架，按排序）
router.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const list = await prisma.banner.findMany({
      where: { status: 1 },
      orderBy: [{ sortOrder: 'asc' }, { id: 'desc' }],
      select: { id: true, title: true, imageUrl: true, linkType: true, productId: true },
    })
    success(res, list)
  } catch (e) {
    next(e)
  }
})

export default router
