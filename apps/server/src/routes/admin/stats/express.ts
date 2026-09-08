import { Router, Request, Response, NextFunction } from 'express'
import prisma from '../../../utils/prisma'
import { success } from '../../../utils/response'
import { REAL_ORDERS } from '../../../utils/stats-scope'
import { parseRange, paidOrdersWhere, percentile, median, rangeOut, type Range } from './shared'

const router = Router()
/** 只封顶「发货时效 / 快递公司」的抽样；单量、金额、地区一律走聚合，不封顶。 */
const SAMPLE_CAP = 2000

async function expressBlock(r: Range) {
  const where = paidOrdersWhere(r, 'EXPRESS')
  const [agg, refundAgg, afterSaleCount, byProvince, shipped] = await Promise.all([
    // 总数走聚合，不许经过抽样（同 local.ts 的理由）
    prisma.order.aggregate({ where, _count: { _all: true }, _sum: { actualAmount: true, shippingFee: true } }),
    prisma.order.aggregate({ where: { ...where, refundedAmount: { gt: 0 } }, _count: { _all: true }, _sum: { refundedAmount: true } }),
    prisma.afterSale.count({ where: { order: where } }),
    prisma.order.groupBy({
      by: ['receiverProvince'],
      where,
      _count: { _all: true },
      orderBy: { _count: { receiverProvince: 'desc' } },
      take: 5,
    }),
    // 已发货的单：付款→发货时效 + 快递公司分布
    prisma.order.findMany({
      where: { ...where, shipment: { shippedAt: { not: null } } },
      select: { paidAt: true, shipment: { select: { shippedAt: true, expressCompany: true } } },
      take: SAMPLE_CAP,
      orderBy: { paidAt: 'desc' },
    }),
  ])

  const kpi = {
    orderCount: agg._count._all,
    revenueFen: agg._sum.actualAmount ?? 0,
    shippingFeeFen: agg._sum.shippingFee ?? 0,
  }
  const hoursToShip = shipped
    .filter((o) => o.paidAt && o.shipment?.shippedAt)
    .map((o) => (o.shipment!.shippedAt!.getTime() - o.paidAt!.getTime()) / 3600000)
    .filter((h) => h >= 0)
  const shipTiming = { medianHours: median(hoursToShip), p90Hours: percentile(hoursToShip, 0.9), n: hoursToShip.length }

  const comp = new Map<string, number>()
  for (const o of shipped) {
    const k = o.shipment?.expressCompany?.trim() || '未填'
    comp.set(k, (comp.get(k) ?? 0) + 1)
  }
  const companies = [...comp.entries()].map(([name, c]) => ({ name, count: c })).sort((a, b) => b.count - a.count)
  const regions = byProvince.map((g) => ({ province: g.receiverProvince || '未知', count: g._count._all }))

  const afterSales = { refundCount: refundAgg._count._all, refundFen: refundAgg._sum.refundedAmount ?? 0, afterSaleCount }

  return { kpi, shipTiming, companies, regions, afterSales }
}

// GET /api/admin/stats/express?startDate&endDate
router.get('/express', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { cur, prev } = parseRange(req.query)
    const [c, p, backlogRows] = await Promise.all([
      expressBlock(cur),
      expressBlock(prev),
      // 待发货积压是「当前」的事，不受时间范围影响。paidAt 非空是为了别让 NULL 排到最前面顶掉真正最久的那单。
      prisma.order.findMany({
        where: { ...REAL_ORDERS, deliveryType: 'EXPRESS', status: { in: ['PAID', 'PREPARING'] }, paidAt: { not: null } },
        select: { orderNo: true, paidAt: true },
        orderBy: { paidAt: 'asc' },
      }),
    ])
    const oldest = backlogRows[0]
    const backlog = {
      count: backlogRows.length,
      oldestHours: oldest?.paidAt ? Math.floor((Date.now() - oldest.paidAt.getTime()) / 3600000) : null,
      oldestOrderNo: oldest?.orderNo ?? null,
    }
    success(res, {
      range: rangeOut(cur, prev),
      kpi: { ...c.kpi, prev: p.kpi },
      backlog,
      shipTiming: c.shipTiming,
      companies: c.companies,
      regions: c.regions,
      afterSales: c.afterSales,
    })
  } catch (e) {
    next(e)
  }
})

export default router
