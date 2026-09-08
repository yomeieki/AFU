import { Router, Request, Response, NextFunction } from 'express'
import prisma from '../../../utils/prisma'
import { success } from '../../../utils/response'
import { REAL_ORDERS } from '../../../utils/stats-scope'
import { parseRange, paidOrdersWhere, percentile, median, rangeOut, type Range } from './shared'

const router = Router()
const SAMPLE_CAP = 2000

async function expressBlock(r: Range) {
  const orders = await prisma.order.findMany({
    where: paidOrdersWhere(r, 'EXPRESS'),
    select: { id: true, paidAt: true, actualAmount: true, shippingFee: true, refundedAmount: true, receiverProvince: true, shipment: { select: { shippedAt: true, expressCompany: true } } },
    take: SAMPLE_CAP,
    orderBy: { paidAt: 'desc' },
  })
  const orderCount = orders.length
  const kpi = {
    orderCount,
    revenueFen: orders.reduce((s, o) => s + o.actualAmount, 0),
    shippingFeeFen: orders.reduce((s, o) => s + o.shippingFee, 0),
  }
  const hoursToShip = orders
    .filter((o) => o.paidAt && o.shipment?.shippedAt)
    .map((o) => (o.shipment!.shippedAt!.getTime() - o.paidAt!.getTime()) / 3600000)
    .filter((h) => h >= 0)
  const shipTiming = { medianHours: median(hoursToShip), p90Hours: percentile(hoursToShip, 0.9), n: hoursToShip.length }

  const count = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1)
  const comp = new Map<string, number>()
  const prov = new Map<string, number>()
  for (const o of orders) {
    if (o.shipment?.shippedAt) count(comp, o.shipment.expressCompany?.trim() || '未填')
    count(prov, o.receiverProvince || '未知')
  }
  const companies = [...comp.entries()].map(([name, c]) => ({ name, count: c })).sort((a, b) => b.count - a.count)
  const regions = [...prov.entries()].map(([province, c]) => ({ province, count: c })).sort((a, b) => b.count - a.count).slice(0, 5)

  const refunded = orders.filter((o) => o.refundedAmount > 0)
  const afterSaleCount = orderCount ? await prisma.afterSale.count({ where: { orderId: { in: orders.map((o) => o.id) } } }) : 0
  const afterSales = { refundCount: refunded.length, refundFen: refunded.reduce((s, o) => s + o.refundedAmount, 0), afterSaleCount }

  return { kpi, shipTiming, companies, regions, afterSales }
}

// GET /api/admin/stats/express?startDate&endDate
router.get('/express', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { cur, prev } = parseRange(req.query)
    const [c, p, backlogRows] = await Promise.all([
      expressBlock(cur),
      expressBlock(prev),
      // 待发货积压是「当前」的事，不受时间范围影响
      prisma.order.findMany({
        where: { ...REAL_ORDERS, deliveryType: 'EXPRESS', status: { in: ['PAID', 'PREPARING'] } },
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
