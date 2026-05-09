import { Router, Request, Response, NextFunction } from 'express'
import prisma from '../../utils/prisma'
import { success } from '../../utils/response'

const router = Router()

// GET /api/admin/stats
router.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const tomorrow = new Date(today)
    tomorrow.setDate(tomorrow.getDate() + 1)

    const [
      totalOrders,
      todayOrders,
      totalProducts,
      totalCategories,
      todayRevenue,
      hotProducts,
    ] = await prisma.$transaction([
      prisma.order.count(),
      prisma.order.count({ where: { createdAt: { gte: today, lt: tomorrow } } }),
      prisma.product.count({ where: { deletedAt: null } }),
      prisma.category.count({ where: { status: 1 } }),
      prisma.order.aggregate({
        where: {
          status: { in: ['PAID', 'SHIPPED', 'COMPLETED'] },
          paidAt: { gte: today, lt: tomorrow },
        },
        _sum: { actualAmount: true },
      }),
      prisma.product.findMany({
        where: { deletedAt: null },
        orderBy: { salesCount: 'desc' },
        take: 5,
        select: {
          id: true,
          name: true,
          coverImage: true,
          salesCount: true,
          price: true,
        },
      }),
    ])

    success(res, {
      today: {
        orderCount: todayOrders,
        salesAmount: todayRevenue._sum.actualAmount ?? 0,
      },
      total: {
        orderCount: totalOrders,
        productCount: totalProducts,
        categoryCount: totalCategories,
      },
      hotProducts,
    })
  } catch (e) {
    next(e)
  }
})

export default router
