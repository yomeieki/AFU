import { Router, Request, Response, NextFunction } from 'express'
import prisma from '../../../utils/prisma'
import { success } from '../../../utils/response'
import { parseRange, paidOrdersWhere, percentile, median, minutesBetween, rangeOut, type Range } from './shared'

const router = Router()
const SAMPLE_CAP = 2000

const STAGES = [
  { key: 'acceptToCall', label: '接单→呼叫' },
  { key: 'callToRider', label: '呼叫→骑手接单' },
  { key: 'riderToPickup', label: '骑手接单→取货' },
  { key: 'pickupToDone', label: '取货→送达' },
  { key: 'total', label: '下单→送达' },
] as const
type StageKey = (typeof STAGES)[number]['key']

/** 一次拉齐本期同城单与它们的全部配送单，所有数字在 JS 侧算（本店日单量两位数，92 天也不到封顶） */
async function localBlock(r: Range) {
  const orders = await prisma.order.findMany({
    where: paidOrdersWhere(r, 'LOCAL'),
    select: { id: true, status: true, paidAt: true, acceptedAt: true, shippingFee: true, actualAmount: true, distanceM: true, cancelRequestedAt: true },
    take: SAMPLE_CAP,
    orderBy: { paidAt: 'desc' },
  })
  const ids = orders.map((o) => o.id)
  const deliveries = ids.length
    ? await prisma.delivery.findMany({
        where: { orderId: { in: ids } },
        // ⚠ `provider` 列是系统内部的配送渠道抽象（KD100 | SELF | MOCK，见 schema 注释），
        // 不是「哪家运力」。承运商（闪送/达达/…）真正落在 `courierCompany`（回调 kuaidicom 写入，
        // callback.ts:167），与 utils/providers.ts 的 PROVIDER_LABEL 是同一套编码。
        select: { orderId: true, status: true, courierCompany: true, callStrategy: true, quotedFee: true, actualFee: true, tipFee: true, cancelFee: true, calledAt: true, acceptedAt: true, pickedUpAt: true, deliveredAt: true },
      })
    : []

  // KPI
  const orderCount = orders.length
  const revenueFen = orders.reduce((s, o) => s + o.actualAmount, 0)
  const withDist = orders.filter((o) => o.distanceM != null)
  const avgDistanceM = withDist.length ? Math.round(withDist.reduce((s, o) => s + o.distanceM!, 0) / withDist.length) : null
  const freeShipCount = orders.filter((o) => o.shippingFee === 0).length
  const kpi = { orderCount, revenueFen, avgDistanceM, freeShipCount, freeShipRate: orderCount ? freeShipCount / orderCount : null }

  // 运费账
  const fee = (d: { actualFee: number | null; quotedFee: number | null }) => d.actualFee ?? d.quotedFee ?? 0
  const customerPaidFen = orders.reduce((s, o) => s + o.shippingFee, 0)
  const deliveryFen = deliveries.filter((d) => d.status === 'DELIVERED').reduce((s, d) => s + fee(d), 0)
  const tipFen = deliveries.reduce((s, d) => s + d.tipFee, 0)
  const cancelFen = deliveries.filter((d) => d.status === 'CANCELLED').reduce((s, d) => s + d.cancelFee, 0)
  const riderTotalFen = deliveryFen + tipFen + cancelFen
  const freight = { customerPaidFen, deliveryFen, tipFen, cancelFen, riderTotalFen, netFen: customerPaidFen - riderTotalFen }

  // 时效：已完成单 × 它那张 DELIVERED 配送单
  const deliveredByOrder = new Map<number, (typeof deliveries)[number]>()
  for (const d of deliveries) if (d.status === 'DELIVERED' && !deliveredByOrder.has(d.orderId)) deliveredByOrder.set(d.orderId, d)
  const samples: Record<StageKey, number[]> = { acceptToCall: [], callToRider: [], riderToPickup: [], pickupToDone: [], total: [] }
  for (const o of orders) {
    if (o.status !== 'COMPLETED') continue
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
  const byProvider = new Map<string, { count: number; feeSum: number; pickup: number[] }>()
  for (const d of deliveries) {
    if (d.status !== 'DELIVERED') continue
    const key = d.courierCompany ?? '未知'
    const acc = byProvider.get(key) ?? { count: 0, feeSum: 0, pickup: [] }
    acc.count += 1
    acc.feeSum += fee(d)
    const pm = minutesBetween(d.calledAt, d.pickedUpAt)
    if (pm != null && pm >= 0) acc.pickup.push(pm)
    byProvider.set(key, acc)
  }
  const providers = [...byProvider.entries()]
    .map(([provider, a]) => ({ provider, count: a.count, avgFeeFen: Math.round(a.feeSum / a.count), avgPickupMin: a.pickup.length ? Math.round(a.pickup.reduce((x, y) => x + y, 0) / a.pickup.length) : null }))
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

  // 距离分布
  const distance = [
    { label: '≤2km', count: orders.filter((o) => o.distanceM != null && o.distanceM <= 2000).length },
    { label: '2–5km', count: orders.filter((o) => o.distanceM != null && o.distanceM > 2000 && o.distanceM <= 5000).length },
    { label: '>5km', count: orders.filter((o) => o.distanceM != null && o.distanceM > 5000).length },
    { label: '未知', count: orders.filter((o) => o.distanceM == null).length },
  ]

  const cancels = {
    requested: orders.filter((o) => o.cancelRequestedAt != null).length,
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
