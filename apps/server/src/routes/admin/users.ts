import { Router, Request, Response, NextFunction } from 'express'
import prisma from '../../utils/prisma'
import { success, paginate } from '../../utils/response'
import { AppError } from '../../middlewares/error'

const router = Router()

// GET /api/admin/users — 用户列表（分页 + 昵称/手机号搜索）
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1)
    const pageSize = Math.min(50, Math.max(1, Number(req.query.pageSize) || 20))
    const keyword = (req.query.keyword as string | undefined)?.trim()

    const where = keyword
      ? {
          OR: [{ nickname: { contains: keyword } }, { phone: { contains: keyword } }],
        }
      : {}

    const [list, total] = await prisma.$transaction([
      prisma.user.findMany({
        where,
        select: {
          id: true,
          openid: true,
          nickname: true,
          avatarUrl: true,
          phone: true,
          status: true,
          lastLoginAt: true,
          createdAt: true,
          _count: { select: { orders: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.user.count({ where }),
    ])

    paginate(
      res,
      list.map(({ _count, ...u }) => ({ ...u, orderCount: _count.orders })),
      total,
      page,
      pageSize
    )
  } catch (e) {
    next(e)
  }
})

// GET /api/admin/users/:id/orders — 某用户的订单列表
router.get('/:id/orders', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = Number(req.params.id)
    const page = Math.max(1, Number(req.query.page) || 1)
    const pageSize = Math.min(50, Math.max(1, Number(req.query.pageSize) || 20))

    const user = await prisma.user.findUnique({ where: { id: userId } })
    if (!user) throw new AppError(40401, '用户不存在', 404)

    const where = { userId }
    const [list, total] = await prisma.$transaction([
      prisma.order.findMany({
        where,
        select: {
          id: true,
          orderNo: true,
          status: true,
          actualAmount: true,
          createdAt: true,
          items: { select: { productName: true, quantity: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.order.count({ where }),
    ])

    paginate(res, list, total, page, pageSize)
  } catch (e) {
    next(e)
  }
})

export default router
