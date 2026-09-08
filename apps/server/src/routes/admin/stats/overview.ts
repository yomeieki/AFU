import { Router, Request, Response, NextFunction } from 'express'
import { z } from 'zod'
import prisma from '../../../utils/prisma'
import { success } from '../../../utils/response'
import { REAL_ORDERS, realOrdersSql } from '../../../utils/stats-scope'
import { localDayPartsSql, LOCAL_DAY_GROUP_BY, localDayKey, localDayKeyFromParts } from '../../../utils/local-day'
import { parseRange, paidOrdersWhere, localHourFromParts, rangeOut, type Range } from './shared'

const router = Router()
type Channel = 'LOCAL' | 'EXPRESS'
const channelSchema = z.object({ channel: z.enum(['ALL', 'LOCAL', 'EXPRESS']).optional() })

async function kpiOf(r: Range) {
  const agg = await prisma.order.aggregate({
    where: paidOrdersWhere(r),
    _count: { _all: true },
    _sum: { actualAmount: true, refundedAmount: true },
  })
  const orderCount = agg._count._all
  const revenueFen = agg._sum.actualAmount ?? 0
  return {
    orderCount,
    revenueFen,
    refundFen: agg._sum.refundedAmount ?? 0,
    avgOrderFen: orderCount ? Math.round(revenueFen / orderCount) : 0,
  }
}

// GET /api/admin/stats/overview?startDate&endDate&channel=ALL|LOCAL|EXPRESS
router.get('/overview', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { cur, prev } = parseRange(req.query)
    const ch = channelSchema.parse(req.query).channel ?? 'ALL'
    const hotChannel: Channel | undefined = ch === 'ALL' ? undefined : ch

    const [kpi, prevKpi, byChannel, rows, userRows] = await Promise.all([
      kpiOf(cur),
      kpiOf(prev),
      prisma.order.groupBy({
        by: ['deliveryType'],
        where: paidOrdersWhere(cur),
        _count: { _all: true },
        _sum: { actualAmount: true },
      }),
      // 趋势与时段分布共用一次查询：按渠道 × 上海小时桶聚合，JS 侧再折成日 / 小时
      prisma.$queryRaw<{ dt: string; y: number; mo: number; d: number; h: number; cnt: bigint; amt: bigint | null }[]>`
        SELECT delivery_type dt, ${localDayPartsSql('paid_at')}, COUNT(*) cnt, SUM(actual_amount) amt
        FROM orders
        WHERE paid_at >= ${cur.start} AND paid_at < ${cur.endExclusive}
          ${realOrdersSql()}
        GROUP BY dt, ${LOCAL_DAY_GROUP_BY}`,
      prisma.order.groupBy({ by: ['userId'], where: paidOrdersWhere(cur) }),
    ])

    const channels = { LOCAL: { orderCount: 0, revenueFen: 0 }, EXPRESS: { orderCount: 0, revenueFen: 0 } }
    for (const g of byChannel) {
      if (g.deliveryType === 'LOCAL' || g.deliveryType === 'EXPRESS') {
        channels[g.deliveryType] = { orderCount: g._count._all, revenueFen: g._sum.actualAmount ?? 0 }
      }
    }

    const byDay = new Map<string, { LOCAL: { orderCount: number; revenueFen: number }; EXPRESS: { orderCount: number; revenueFen: number } }>()
    const hourly = new Array<number>(24).fill(0)
    for (const r of rows) {
      const key = localDayKeyFromParts(r)
      const acc = byDay.get(key) ?? { LOCAL: { orderCount: 0, revenueFen: 0 }, EXPRESS: { orderCount: 0, revenueFen: 0 } }
      const c = r.dt === 'LOCAL' ? 'LOCAL' : 'EXPRESS'
      acc[c].orderCount += Number(r.cnt)
      acc[c].revenueFen += Number(r.amt ?? 0)
      byDay.set(key, acc)
      hourly[localHourFromParts(r)] += Number(r.cnt)
    }
    const trend: { date: string; LOCAL: { orderCount: number; revenueFen: number }; EXPRESS: { orderCount: number; revenueFen: number } }[] = []
    for (const d = new Date(cur.start); d < cur.endExclusive; d.setDate(d.getDate() + 1)) {
      const key = localDayKey(d)
      trend.push({ date: key, ...(byDay.get(key) ?? { LOCAL: { orderCount: 0, revenueFen: 0 }, EXPRESS: { orderCount: 0, revenueFen: 0 } }) })
    }

    // 新客 = 该用户历史第一张已付单落在本期
    const userIds = userRows.map((u) => u.userId)
    const firstPaid = userIds.length
      ? await prisma.order.groupBy({
          by: ['userId'],
          where: { ...REAL_ORDERS, userId: { in: userIds }, paidAt: { not: null } },
          _min: { paidAt: true },
        })
      : []
    const newUsers = firstPaid.filter((f) => f._min.paidAt && f._min.paidAt >= cur.start).length
    const users = userIds.length
    const customers = {
      users,
      newUsers,
      returningUsers: users - newUsers,
      repeatRate: users ? (users - newUsers) / users : null,
    }

    // 热销榜按 order_items 聚合（不再读 Product.salesCount 冗余列，测试单自然排除）
    const hot = await prisma.orderItem.groupBy({
      by: ['productId'],
      where: { isGift: false, productId: { not: null }, order: paidOrdersWhere(cur, hotChannel) },
      _sum: { quantity: true, subtotal: true },
      orderBy: { _sum: { quantity: 'desc' } },
      take: 5,
    })
    const hotIds = hot.map((h) => h.productId!).filter((id) => id != null)
    const names = hotIds.length
      ? await prisma.orderItem.findMany({
          where: { productId: { in: hotIds } },
          orderBy: { id: 'desc' },
          // MySQL 上 Prisma 的 distinct 是取回来在内存里去重，不加 take 会把这 5 个商品的全部历史明细拉回来
          take: 200,
          distinct: ['productId'],
          select: { productId: true, productName: true },
        })
      : []
    const nameOf = new Map(names.map((n) => [n.productId, n.productName]))
    const hotProducts = hot.map((h) => ({
      productId: h.productId!,
      name: nameOf.get(h.productId!) ?? `#${h.productId}`,
      qty: h._sum.quantity ?? 0,
      revenueFen: h._sum.subtotal ?? 0,
    }))

    success(res, {
      range: rangeOut(cur, prev),
      kpi: { ...kpi, prev: prevKpi },
      channels,
      trend,
      hourly,
      customers,
      hotProducts,
    })
  } catch (e) {
    next(e)
  }
})

export default router
