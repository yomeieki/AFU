import { Router, Request, Response, NextFunction } from 'express'
import prisma from '../../utils/prisma'
import { success } from '../../utils/response'
import { REAL_ORDERS, realOrdersSql } from '../../utils/stats-scope'
import { localDayPartsSql, LOCAL_DAY_GROUP_BY, localDayKey, localDayKeyFromParts } from '../../utils/local-day'

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
      prisma.order.count({ where: { ...REAL_ORDERS } }),
      prisma.order.count({ where: { ...REAL_ORDERS, createdAt: { gte: today, lt: tomorrow } } }),
      // 前端标签是「在售商品数」，必须只数上架的：
      // 全部下架时若仍显示总数，店家会以为商城正常，实际顾客看到的是空货架
      prisma.product.count({ where: { deletedAt: null, status: 'ON_SHELF' } }),
      prisma.category.count({ where: { status: 1 } }),
      prisma.order.aggregate({
        where: {
          ...REAL_ORDERS,
          status: { in: ['PAID', 'SHIPPED', 'COMPLETED'] },
          paidAt: { gte: today, lt: tomorrow },
        },
        _sum: { actualAmount: true },
      }),
      // 热销榜按 salesCount 冗余列排序，REAL_ORDERS 对它无效（那列在下单瞬间 +1，不查订单行）。
      // 测试单的销量污染靠「联调用专门的测试商品 + 联调后软删除」隔离——本查询已按 deletedAt 过滤，
      // 软删除后它就从榜上消失。分工写在这里，免得后人以为这处漏接了 isTest。详见 docs/ops-test-orders.md
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

    // 分桶按**本地自然日**：SQL 只做不涉时区的年月日时提取，JS 侧还原成瞬时再落本地日历。
    // 为什么不能直接 `GROUP BY DATE(created_at)`、以及半小时偏移时区的适用前提，
    // 全部写在 utils/local-day.ts 上——那里是这套做法的唯一实现，改一处两处都跟着改。
    // 本查询聚合的是 COUNT/SUM，跨小时可加，所以按小时桶直接相加即可（见该模块关于「可不可加」的注释）。
    const rows = await prisma.$queryRaw<
      { y: number; mo: number; d: number; h: number; cnt: bigint; amt: bigint | null }[]
    >`
      SELECT ${localDayPartsSql()}, COUNT(*) cnt, SUM(actual_amount) amt
      FROM orders
      WHERE created_at >= ${start} AND created_at < ${endExclusive} AND status != 'CANCELLED'
        ${realOrdersSql()}
      GROUP BY ${LOCAL_DAY_GROUP_BY}`

    const byDate = new Map<string, { cnt: number; amt: number }>()
    for (const r of rows) {
      const key = localDayKeyFromParts(r)
      const acc = byDate.get(key) ?? { cnt: 0, amt: 0 }
      acc.cnt += Number(r.cnt)
      acc.amt += Number(r.amt ?? 0)
      byDate.set(key, acc)
    }

    const list: { date: string; orderCount: number; salesAmount: number }[] = []
    for (const d = new Date(start); d < endExclusive; d.setDate(d.getDate() + 1)) {
      const row = byDate.get(localDayKey(d))
      list.push({
        date: localDayKey(d),
        orderCount: row?.cnt ?? 0,
        salesAmount: row?.amt ?? 0,
      })
    }
    success(res, { list })
  } catch (e) {
    next(e)
  }
})

export default router
