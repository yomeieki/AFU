import { Router, Request, Response, NextFunction } from 'express'
import prisma from '../../../utils/prisma'
import { success } from '../../../utils/response'
import { parseRange, paidOrdersWhere, percentile, median, minutesBetween, rangeOut, type Range } from './shared'

const router = Router()
/** 只封顶「时效」的抽样（JS 侧算分位数）；单量、金额、分布一律走聚合，不封顶。 */
const SAMPLE_CAP = 2000

const STAGES = [
  { key: 'acceptToCall', label: '接单→呼叫' },
  { key: 'callToRider', label: '呼叫→骑手接单' },
  { key: 'riderToPickup', label: '骑手接单→取货' },
  { key: 'pickupToDone', label: '取货→送达' },
  { key: 'total', label: '下单→送达' },
] as const
type StageKey = (typeof STAGES)[number]['key']

async function localBlock(r: Range) {
  const where = paidOrdersWhere(r, 'LOCAL')
  const [agg, freeShipCount, scheduledCount, requested, dLe2, d2to5, dGt5, dNull, deliveries, completed] = await Promise.all([
    // KPI 与顾客付运费走聚合：复核时抓到过 take 封顶把「同城单量」截成正好 2000 的事，
    // 看着像真数，总览 tab 上同一区间却是另一个数。凡是给店主看的总数都不许经过抽样。
    prisma.order.aggregate({ where, _count: { _all: true }, _sum: { actualAmount: true, shippingFee: true }, _avg: { distanceM: true } }),
    prisma.order.count({ where: { ...where, shippingFee: 0 } }),
    prisma.order.count({ where: { ...where, scheduledAt: { not: null } } }),
    prisma.order.count({ where: { ...where, cancelRequestedAt: { not: null } } }),
    prisma.order.count({ where: { ...where, distanceM: { lte: 2000 } } }),
    prisma.order.count({ where: { ...where, distanceM: { gt: 2000, lte: 5000 } } }),
    prisma.order.count({ where: { ...where, distanceM: { gt: 5000 } } }),
    prisma.order.count({ where: { ...where, distanceM: null } }),
    // 本期同城单的**全部**配送单（一单可能呼叫多次），运费账 / 承运商 / 阶梯 / 取消都从这里出
    prisma.delivery.findMany({
      where: { order: where },
      // ⚠ `provider` 列是系统内部的配送渠道抽象（KD100 | SELF | MOCK，见 schema 注释），
      // 不是「哪家运力」。承运商（闪送/达达/…）真正落在 `courierCompany`（回调 kuaidicom 写入，
      // callback.ts:167），与 utils/providers.ts 的 PROVIDER_LABEL 是同一套编码。
      select: { orderId: true, status: true, courierCompany: true, callStrategy: true, quotedFee: true, actualFee: true, tipFee: true, cancelFee: true, calledAt: true, acceptedAt: true, pickedUpAt: true, deliveredAt: true },
    }),
    // 时效抽样：只要已完成单，最多 SAMPLE_CAP 张（spec §3.3）
    prisma.order.findMany({
      where: { ...where, status: 'COMPLETED' },
      select: { id: true, paidAt: true, acceptedAt: true },
      take: SAMPLE_CAP,
      orderBy: { paidAt: 'desc' },
    }),
  ])

  const orderCount = agg._count._all
  const kpi = {
    orderCount,
    revenueFen: agg._sum.actualAmount ?? 0,
    avgDistanceM: agg._avg.distanceM == null ? null : Math.round(Number(agg._avg.distanceM)),
    freeShipCount,
    freeShipRate: orderCount ? freeShipCount / orderCount : null,
    scheduledCount,
  }

  // 运费账。fee() 为 null = 这张送达单既没实扣也没报价（回调没认领 / 自送）：
  // 不能当 0 元记进去把均价拉低，单独计数给页面提示。
  const fee = (d: { actualFee: number | null; quotedFee: number | null }): number | null => d.actualFee ?? d.quotedFee ?? null
  const delivered = deliveries.filter((d) => d.status === 'DELIVERED')
  const customerPaidFen = agg._sum.shippingFee ?? 0
  const deliveryFen = delivered.reduce((s, d) => s + (fee(d) ?? 0), 0)
  const unpricedCount = delivered.filter((d) => fee(d) == null).length
  const tipFen = deliveries.reduce((s, d) => s + d.tipFee, 0)
  const cancelFen = deliveries.filter((d) => d.status === 'CANCELLED').reduce((s, d) => s + d.cancelFee, 0)
  const riderTotalFen = deliveryFen + tipFen + cancelFen
  const freight = { customerPaidFen, deliveryFen, tipFen, cancelFen, riderTotalFen, netFen: customerPaidFen - riderTotalFen, unpricedCount }

  // 时效：已完成单 × 它那张 DELIVERED 配送单
  const deliveredByOrder = new Map<number, (typeof deliveries)[number]>()
  for (const d of delivered) if (!deliveredByOrder.has(d.orderId)) deliveredByOrder.set(d.orderId, d)
  const samples: Record<StageKey, number[]> = { acceptToCall: [], callToRider: [], riderToPickup: [], pickupToDone: [], total: [] }
  for (const o of completed) {
    const d = deliveredByOrder.get(o.id)
    if (!d) continue
    const push = (k: StageKey, v: number | null) => { if (v != null && v >= 0) samples[k].push(v) }
    push('acceptToCall', minutesBetween(o.acceptedAt, d.calledAt))
    push('callToRider', minutesBetween(d.calledAt, d.acceptedAt))
    push('riderToPickup', minutesBetween(d.acceptedAt, d.pickedUpAt))
    push('pickupToDone', minutesBetween(d.pickedUpAt, d.deliveredAt))
    push('total', minutesBetween(o.paidAt, d.deliveredAt))
  }
  const timing = { stages: STAGES.map((s) => ({ key: s.key, label: s.label, medianMin: median(samples[s.key]), p90Min: percentile(samples[s.key], 0.9), n: samples[s.key].length })) }

  // 承运商（只看送达的那张）——按 courierCompany（kuaidicom 编码）分组，见上面 select 处的注释
  const byProvider = new Map<string, { count: number; feeSum: number; feeN: number; pickup: number[] }>()
  for (const d of delivered) {
    const key = d.courierCompany ?? '未知'
    const acc = byProvider.get(key) ?? { count: 0, feeSum: 0, feeN: 0, pickup: [] }
    acc.count += 1
    const f = fee(d)
    if (f != null) { acc.feeSum += f; acc.feeN += 1 }
    const pm = minutesBetween(d.calledAt, d.pickedUpAt)
    if (pm != null && pm >= 0) acc.pickup.push(pm)
    byProvider.set(key, acc)
  }
  const providers = [...byProvider.entries()]
    .map(([provider, a]) => ({
      provider,
      count: a.count,
      avgFeeFen: a.feeN ? Math.round(a.feeSum / a.feeN) : null,
      avgPickupMin: a.pickup.length ? Math.round(a.pickup.reduce((x, y) => x + y, 0) / a.pickup.length) : null,
    }))
    .sort((a, b) => b.count - a.count)

  // 呼叫阶梯：一单可能呼叫多次，看它走到最高哪一级
  const ladder = { first: 0, cheapestN: 0, all: 0 }
  const strategiesByOrder = new Map<number, Set<string>>()
  for (const d of deliveries) {
    if (!d.callStrategy) continue
    const s = d.callStrategy.replace(/_HELD$/, '')
    ;(strategiesByOrder.get(d.orderId) ?? strategiesByOrder.set(d.orderId, new Set()).get(d.orderId)!).add(s)
  }
  for (const set of strategiesByOrder.values()) {
    if (set.has('ALL')) ladder.all += 1
    else if (set.has('CHEAPEST')) ladder.cheapestN += 1
    else ladder.first += 1
  }

  const distance = [
    { label: '≤2km', count: dLe2 },
    { label: '2–5km', count: d2to5 },
    { label: '>5km', count: dGt5 },
    { label: '未知', count: dNull },
  ]

  const cancels = {
    requested,
    deliveryCancelled: deliveries.filter((d) => d.status === 'CANCELLED').length,
  }

  return { kpi, freight, timing, providers, ladder, distance, cancels }
}

// GET /api/admin/stats/local?startDate&endDate
router.get('/local', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { cur, prev } = parseRange(req.query)
    const [c, p] = await Promise.all([localBlock(cur), localBlock(prev)])
    success(res, {
      range: rangeOut(cur, prev),
      kpi: { ...c.kpi, prev: p.kpi },
      freight: { ...c.freight, prev: { customerPaidFen: p.freight.customerPaidFen, riderTotalFen: p.freight.riderTotalFen, netFen: p.freight.netFen } },
      timing: c.timing,
      providers: c.providers,
      ladder: c.ladder,
      distance: c.distance,
      cancels: c.cancels,
    })
  } catch (e) {
    next(e)
  }
})

export default router
