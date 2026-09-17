/**
 * 近 30 天销量聚合（分类内排序 SALES_30D 模式用，2026-09-17 分类内排序设计 §3.2）。
 *
 * 口径与后台热销榜（routes/admin/stats/overview.ts 的 hot 聚合）完全一致：
 * 非赠品行、商品未删（productId 非空）、订单 spread REAL_ORDERS（只排除测试单，
 * 不看订单 status、不排除已付款后又退款/取消的单）、paidAt 落在近 30 天。
 *
 * 只缓存这份「聚合结果」（进程内 Map<productId, qty>，60 秒 TTL，写法照
 * services/local-settings.ts）——不缓存商品列表本身：列表现查，才能保证后台改库存/
 * 上下架、顾客下单扣库存都立刻反映在顾客端；后台改排序方式或拖拽保存排序后，才需要
 * 主动清这份缓存（销量本身没变，但为了让「模式切换」立刻按最新销量重排，统一清一次）。
 *
 * 单进程（fork 模式）下 clear 后下一次 getSales30d() 立刻重新聚合，不存在跨进程不一致问题
 * （同 local-settings.ts 的说明）。
 *
 * 聚合失败（库异常）时 console.warn 并返回空 Map：排序退化为该分类的 MANUAL 兜底顺序，
 * 不让公开列表因为销量聚合的偶发异常而 500。
 */
import prisma from '../utils/prisma'
import { REAL_ORDERS } from '../utils/stats-scope'

const CACHE_TTL_MS = 60 * 1000

let cached: { value: Map<number, number>; at: number } | null = null

export async function getSales30d(): Promise<Map<number, number>> {
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value

  try {
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    const rows = await prisma.orderItem.groupBy({
      by: ['productId'],
      where: {
        isGift: false,
        productId: { not: null },
        order: { ...REAL_ORDERS, paidAt: { gte: since } },
      },
      _sum: { quantity: true },
    })
    const value = new Map<number, number>()
    for (const r of rows) {
      if (r.productId != null) value.set(r.productId, r._sum.quantity ?? 0)
    }
    cached = { value, at: Date.now() }
    return value
  } catch (e) {
    console.warn('[product-sales] 近 30 天销量聚合失败，排序退化为 MANUAL 兜底顺序', e)
    return new Map()
  }
}

/** 后台切换排序方式或拖拽保存排序后调用；下一次 getSales30d() 会重新聚合。 */
export function clearProductSalesCache(): void {
  cached = null
}
