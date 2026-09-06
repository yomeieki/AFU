import prisma from '../../utils/prisma'
import { getMemberSettings } from './settings'
import { checkCouponUsable } from './pricing'

export type CheckoutChannel = 'LOCAL' | 'EXPRESS'

export interface CheckoutCouponView {
  id: number
  name: string
  amount: number
  threshold: number
  channel: string
  expiresAt: Date
  usable: boolean
  /** 可用时给出实际抵扣额（券面额与小计取小） */
  discount?: number
  reason?: string
  message?: string
}

export interface CheckoutGiftView {
  id: number
  productId: number
  skuId: number | null
  name: string
  image: string | null
  specText: string | null
  pointsCost: number
  perOrderLimit: number
  /** 商品/SKU 的真实库存——赠品照常扣真实库存 */
  stock: number
  /** 兑换名额剩余；stockLimit 为 NULL 时是 null（不限） */
  remaining: number | null
}

export interface CheckoutOptions {
  pointsBalance: number
  points: { enabled: boolean; earnRatePerYuan: number }
  coupons: CheckoutCouponView[]
  gifts: CheckoutGiftView[]
}

/**
 * 结算页要展示的全部会员选项：可用积分、券列表（带可用性判定）、可换的随单赠品。
 *
 * **`usable` / `discount` 一律由服务端算好给出，小程序只负责显示**（spec §6）。
 * 客户端不重算——一旦两边各算一次，「顾客看到能用、下单被拒」这类问题就会长期存在，
 * 而且判定规则改一次要改两处。
 *
 * 不可用的券**也返回**，带 `reason` 与 `message`：结算页要把它们灰掉并说明原因，
 * 而不是直接藏起来。藏起来顾客会以为券丢了，然后来问客服。
 */
export async function loadCheckoutOptions(
  userId: number,
  channel: CheckoutChannel,
  subtotal: number
): Promise<CheckoutOptions> {
  const now = new Date()
  const settings = await getMemberSettings()

  const [user, rawCoupons, rawGifts] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { pointsBalance: true } }),
    // 只取「未使用且未过期」的：已用/已过期的券在「我的券」页看，不进结算页。
    // expiresAt 直接在 where 里比，不依赖 expireCoupons 定时任务准时（它只负责把状态刷成
    // EXPIRED，读取侧任何时候都必须自己按时间判——M1 的既有口径，这里沿用）。
    prisma.userCoupon.findMany({
      where: { userId, status: 'UNUSED', expiresAt: { gt: now } },
      select: { id: true, name: true, amount: true, threshold: true, channel: true, expiresAt: true },
    }),
    // ⚠️ `PointsGood` 在 schema 里**没有 product 关系字段**（productId/skuId 都是普通 Int 列，
    // 与 Order.couponId 同款处理，避免双向强关联），所以商品条件没法写进这条 where，
    // 只能先取赠品项、再按 id 批量捞商品、在 JS 侧过滤。
    prisma.pointsGood.findMany({
      where: { status: 'ON' },
      select: {
        id: true, productId: true, skuId: true, pointsCost: true, perOrderLimit: true,
        stockLimit: true, issuedCount: true, sortOrder: true,
      },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    }),
  ])

  // 商品与 SKU 都按 id 批量捞（同上：没有关系字段可 include）。
  // 赠品可见性的四条件里，「商品未删 + 在架 + 渠道一致」在这条 where 里过滤——
  // 查不到的商品在下面的循环里直接跳过，等价于「该赠品当前不可见」。
  const productIds = [...new Set(rawGifts.map((g) => g.productId))]
  const skuIds = rawGifts.map((g) => g.skuId).filter((v): v is number => v !== null)
  const [products, skus] = await Promise.all([
    productIds.length
      ? prisma.product.findMany({
          where: {
            id: { in: productIds },
            deletedAt: null,
            status: 'ON_SHELF',
            channel: channel === 'LOCAL' ? 'LOCAL' : 'EXPRESS',
          },
          select: { id: true, name: true, coverImage: true, stock: true },
        })
      : Promise.resolve([]),
    skuIds.length
      ? prisma.productSku.findMany({
          where: { id: { in: skuIds } },
          select: { id: true, specText: true, stock: true },
        })
      : Promise.resolve([]),
  ])
  const productById = new Map(products.map((p) => [p.id, p]))
  const skuById = new Map(skus.map((s) => [s.id, s]))

  const coupons: CheckoutCouponView[] = rawCoupons.map((c) => {
    const r = checkCouponUsable(
      { userId, amount: c.amount, threshold: c.threshold, channel: c.channel as 'ALL' | 'LOCAL' | 'EXPRESS', status: 'UNUSED', expiresAt: c.expiresAt },
      { userId, channel, subtotal, now }
    )
    const base = { id: c.id, name: c.name, amount: c.amount, threshold: c.threshold, channel: c.channel, expiresAt: c.expiresAt }
    return r.usable
      ? { ...base, usable: true, discount: r.discount }
      : { ...base, usable: false, reason: r.reason, message: r.message }
  })

  // 排序：能用的排前面 → 抵得多的排前面 → 快过期的排前面。
  // 「快过期优先」是有意的：同样能抵 5 元的两张券，先用掉快过期那张对顾客更有利。
  coupons.sort((a, b) => {
    if (a.usable !== b.usable) return a.usable ? -1 : 1
    if ((b.discount ?? 0) !== (a.discount ?? 0)) return (b.discount ?? 0) - (a.discount ?? 0)
    return a.expiresAt.getTime() - b.expiresAt.getTime()
  })

  const gifts: CheckoutGiftView[] = []
  for (const g of rawGifts) {
    // 查不到商品 = 已删 / 已下架 / 渠道不符（见上面那条 where），本单不展示
    const product = productById.get(g.productId)
    if (!product) continue
    const sku = g.skuId !== null ? skuById.get(g.skuId) : undefined
    // 有 skuId 却查不到 SKU：该规格被删了。这条赠品已经指不到实物，直接不展示。
    if (g.skuId !== null && !sku) continue
    const stock = sku ? sku.stock : product.stock
    if (stock <= 0) continue
    const remaining = g.stockLimit === null ? null : g.stockLimit - g.issuedCount
    if (remaining !== null && remaining <= 0) continue
    gifts.push({
      id: g.id,
      productId: g.productId,
      skuId: g.skuId,
      name: product.name,
      image: product.coverImage,
      specText: sku?.specText ?? null,
      pointsCost: g.pointsCost,
      perOrderLimit: g.perOrderLimit,
      stock,
      remaining,
    })
  }

  return {
    pointsBalance: user?.pointsBalance ?? 0,
    points: { enabled: settings.points.enabled, earnRatePerYuan: settings.points.earnRatePerYuan },
    coupons,
    gifts,
  }
}
