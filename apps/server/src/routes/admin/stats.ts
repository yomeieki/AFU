import { Router, Request, Response, NextFunction } from 'express'
import prisma from '../../utils/prisma'
import { success } from '../../utils/response'
import { REAL_ORDERS, realOrdersSql } from '../../utils/stats-scope'

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

    // ⚠️ 分桶为什么按小时聚合、再回 JS 归日，而不是直接 `GROUP BY DATE(created_at)`：
    //
    // `created_at` 是 DATETIME(3)，Prisma 以 **UTC 墙钟**写入（2026-09-06 实测：本地 JST 01:23
    // 落库是 15:48 UTC）。MySQL 的 `DATE()` 是纯提取、不做任何时区换算，所以它给出的是 **UTC 日期**；
    // 而下面 `fmt()` 用的是 `getFullYear/getMonth/getDate`，给出的是 **进程本地日期**。
    // 两者只有在「数据库时区 == 进程时区」时才碰巧一致——生产两边都是 CST 所以看不出问题，
    // 但本机 Docker MySQL 跑 UTC、Node 跑 JST，每天 JST 00:00–09:00 这段时间里今天的单会被
    // 归进昨天那一桶，趋势图直接错位一天。
    //
    // 修法不是「把两边都钉到系统时区」——那只是把巧合固化。这里让 SQL 只做**不涉及时区的提取**
    // （年月日 + 小时），JS 侧用真实 Date 把它还原成瞬时再按本地日历归桶。这样跨夏令时也正确，
    // 且不需要在任何地方硬编码偏移量。30 天窗口最多 720 行，代价可以忽略。
    //
    // 仍然承载的唯一假设：落库值是 UTC。这条假设本来就是全站承重的（`created_at >= ${start}`
    // 这类比较同样依赖它），不是本函数新引入的。
    const rows = await prisma.$queryRaw<
      { y: number; mo: number; d: number; h: number; cnt: bigint; amt: bigint | null }[]
    >`
      SELECT YEAR(created_at) y, MONTH(created_at) mo, DAY(created_at) d, HOUR(created_at) h,
             COUNT(*) cnt, SUM(actual_amount) amt
      FROM orders
      WHERE created_at >= ${start} AND created_at < ${endExclusive} AND status != 'CANCELLED'
        ${realOrdersSql()}
      GROUP BY y, mo, d, h`

    const fmt = (dd: Date) =>
      `${dd.getFullYear()}-${String(dd.getMonth() + 1).padStart(2, '0')}-${String(dd.getDate()).padStart(2, '0')}`

    const byDate = new Map<string, { cnt: number; amt: number }>()
    for (const r of rows) {
      // Date.UTC 把「UTC 的年月日时」还原成瞬时，fmt 再按本地日历落桶——两次换算都由 Date 负责
      const key = fmt(new Date(Date.UTC(Number(r.y), Number(r.mo) - 1, Number(r.d), Number(r.h))))
      const acc = byDate.get(key) ?? { cnt: 0, amt: 0 }
      acc.cnt += Number(r.cnt)
      acc.amt += Number(r.amt ?? 0)
      byDate.set(key, acc)
    }

    const list: { date: string; orderCount: number; salesAmount: number }[] = []
    for (const d = new Date(start); d < endExclusive; d.setDate(d.getDate() + 1)) {
      const row = byDate.get(fmt(d))
      list.push({
        date: fmt(d),
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
