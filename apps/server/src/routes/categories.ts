import { Router, Request, Response, NextFunction } from 'express'
import prisma from '../utils/prisma'
import { success } from '../utils/response'
import { parseChannelQuery } from '../utils/channel'

const router = Router()

// GET /api/categories?channel=EXPRESS|LOCAL（缺省 EXPRESS：现有分类页/首页零改动）
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const channel = parseChannelQuery(req.query.channel)
    const categories = await prisma.category.findMany({
      where: { status: 1, channel },
      orderBy: { sortOrder: 'asc' },
      select: {
        id: true,
        name: true,
        iconUrl: true,
        sortOrder: true,
        channel: true,
      },
    })
    success(res, categories)
  } catch (e) {
    next(e)
  }
})

export default router
