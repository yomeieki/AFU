import { Router, Request, Response, NextFunction } from 'express'
import prisma from '../utils/prisma'
import { success } from '../utils/response'

const router = Router()

router.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const categories = await prisma.category.findMany({
      where: { status: 1 },
      orderBy: { sortOrder: 'asc' },
      select: {
        id: true,
        name: true,
        iconUrl: true,
        sortOrder: true,
      },
    })
    success(res, categories)
  } catch (e) {
    next(e)
  }
})

export default router
