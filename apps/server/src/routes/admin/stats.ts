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

// GET /api/admin/stats/trend?days=7|30 — 按日订单数与销售额（分），补齐空缺日期
router.get('/trend', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const days = Number(req.query.days) === 30 ? 30 : 7
    const end = new Date(new Date().setHours(0, 0, 0, 0))
    const endExclusive = new Date(end)
    endExclusive.setDate(endExclusive.getDate() + 1)
    const start = new Date(end)
    start.setDate(start.getDate() - (days - 1))

    const rows = await prisma.$queryRaw<{ d: Date; cnt: bigint; amt: bigint | null }[]>`
      SELECT DATE(created_at) d, COUNT(*) cnt, SUM(actual_amount) amt
      FROM orders
      WHERE created_at >= ${start} AND created_at < ${endExclusive} AND status != 'CANCELLED'
      GROUP BY d ORDER BY d`

    const fmt = (dd: Date) =>
      `${dd.getFullYear()}-${String(dd.getMonth() + 1).padStart(2, '0')}-${String(dd.getDate()).padStart(2, '0')}`
    const byDate = new Map(rows.map((r) => [fmt(new Date(r.d)), r]))
    const list: { date: string; orderCount: number; salesAmount: number }[] = []
    for (const d = new Date(start); d < endExclusive; d.setDate(d.getDate() + 1)) {
      const row = byDate.get(fmt(d))
      list.push({
        date: fmt(d),
        orderCount: Number(row?.cnt ?? 0),
        salesAmount: Number(row?.amt ?? 0),
      })
    }
    success(res, { list })
  } catch (e) {
    next(e)
  }
})

export default router
