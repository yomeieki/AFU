import { Prisma } from '@prisma/client'
import prisma from '../../utils/prisma'
import { AppError } from '../../middlewares/error'
import { consumePoints } from './points'
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

// ─────────────────────────────────────────────────────────
// 下单事务：券核销 / 积分扣减 / 赠品名额（M2 Task 4）
// ─────────────────────────────────────────────────────────

export interface GiftLine {
  pointsGoodId: number
  productId: number
  skuId: number | null
  quantity: number
  /** 单件积分价 */
  pointsCost: number
  productName: string
  productImage: string | null
  specText: string | null
  /** 单件净重（克），同城件数/重量上限要用——赠品是骑手真的要拎的东西 */
  netWeightG: number | null
}

export interface ValidatedCoupon {
  id: number
  name: string
  amount: number
  threshold: number
  channel: string
  expiresAt: Date
  /** 本单实际抵扣额（券面额与小计取小） */
  discount: number
}

/**
 * 事务前的券校验。不可用一律 42251，消息区分四种原因（spec §5.2）。
 *
 * 这里做的是**只读预检**，真正的并发防线在 `applyOrderBenefits` 里的条件更新——
 * 两个请求同时用同一张券时，预检会双双通过，靠事务内 `updateMany` 判 count 定胜负。
 */
export async function loadCouponForOrder(
  userId: number,
  couponId: number,
  channel: CheckoutChannel,
  subtotal: number
): Promise<ValidatedCoupon> {
  const c = await prisma.userCoupon.findFirst({
    where: { id: couponId, userId },
    select: { id: true, userId: true, name: true, amount: true, threshold: true, channel: true, status: true, expiresAt: true },
  })
  // 查不到与不属于本人是同一个回答：不暴露「这张券存在但不是你的」
  if (!c) throw new AppError(42251, '优惠券不存在')
  const r = checkCouponUsable(
    { userId: c.userId, amount: c.amount, threshold: c.threshold, channel: c.channel as 'ALL' | 'LOCAL' | 'EXPRESS', status: c.status, expiresAt: c.expiresAt },
    { userId, channel, subtotal }
  )
  if (!r.usable) throw new AppError(42251, r.message)
  return { id: c.id, name: c.name, amount: c.amount, threshold: c.threshold, channel: c.channel, expiresAt: c.expiresAt, discount: r.discount }
}

/**
 * 事务前的赠品校验，返回可直接落库的行与总积分。
 *
 * 校验顺序与错误码沿用 spec §5.3：赠品项停用/超限 42252、商品下架 42202、
 * 渠道不符 42224（消息格式与付费行保持一致）、库存不足 42201。
 *
 * `pointsUsed > 余额` 在这里先快速失败一次（42250），但**真正的防线是事务内的
 * `consumePoints`**——预检与扣减之间余额可能被另一笔兑换消耗掉。
 */
export async function loadGiftLines(
  userId: number,
  channel: CheckoutChannel,
  gifts: { pointsGoodId: number; quantity: number }[]
): Promise<{ lines: GiftLine[]; pointsUsed: number }> {
  if (gifts.length === 0) return { lines: [], pointsUsed: 0 }

  const goods = await prisma.pointsGood.findMany({
    where: { id: { in: gifts.map((g) => g.pointsGoodId) } },
    select: { id: true, productId: true, skuId: true, pointsCost: true, perOrderLimit: true, stockLimit: true, issuedCount: true, status: true },
  })
  const goodById = new Map(goods.map((g) => [g.id, g]))

  const productIds = [...new Set(goods.map((g) => g.productId))]
  const skuIds = goods.map((g) => g.skuId).filter((v): v is number => v !== null)
  const [products, skus] = await Promise.all([
    prisma.product.findMany({
      where: { id: { in: productIds } },
      select: { id: true, name: true, coverImage: true, stock: true, status: true, channel: true, deletedAt: true, netWeightG: true },
    }),
    skuIds.length
      ? prisma.productSku.findMany({ where: { id: { in: skuIds } }, select: { id: true, specText: true, stock: true } })
      : Promise.resolve([]),
  ])
  const productById = new Map(products.map((p) => [p.id, p]))
  const skuById = new Map(skus.map((s) => [s.id, s]))

  const lines: GiftLine[] = []
  let pointsUsed = 0
  for (const g of gifts) {
    const pg = goodById.get(g.pointsGoodId)
    if (!pg) throw new AppError(42252, '赠品不存在或已下架')
    if (pg.status !== 'ON') throw new AppError(42252, '赠品已下架')
    if (g.quantity > pg.perOrderLimit) throw new AppError(42252, `该赠品每单最多 ${pg.perOrderLimit} 份`)
    if (pg.stockLimit !== null && pg.issuedCount + g.quantity > pg.stockLimit) {
      throw new AppError(42252, '赠品已兑完')
    }
    const product = productById.get(pg.productId)
    if (!product || product.deletedAt) throw new AppError(40401, '赠品商品不存在')
    if (product.status !== 'ON_SHELF') throw new AppError(42202, `${product.name} 已下架`)
    // 渠道消息沿用付费行的格式（routes/orders.ts 里那两句），顾客看到的措辞一致
    if (product.channel !== channel) {
      throw new AppError(42224, channel === 'LOCAL' ? `${product.name} 不是同城配送商品` : `${product.name} 是同城配送商品，请到同城页面下单`)
    }
    const sku = pg.skuId !== null ? skuById.get(pg.skuId) : undefined
    if (pg.skuId !== null && !sku) throw new AppError(40401, `${product.name} 所选规格已失效`)
    const stock = sku ? sku.stock : product.stock
    const label = sku ? `${product.name}（${sku.specText}）` : product.name
    if (stock < g.quantity) throw new AppError(42201, `${label} 库存不足（剩余 ${stock}）`)

    lines.push({
      pointsGoodId: pg.id,
      productId: pg.productId,
      skuId: pg.skuId,
      quantity: g.quantity,
      pointsCost: pg.pointsCost,
      productName: product.name,
      productImage: product.coverImage,
      specText: sku?.specText ?? null,
      netWeightG: product.netWeightG,
    })
    pointsUsed += pg.pointsCost * g.quantity
  }

  if (pointsUsed > 0) {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { pointsBalance: true } })
    if ((user?.pointsBalance ?? 0) < pointsUsed) {
      throw new AppError(42250, `积分不足，本单需 ${pointsUsed} 分，当前 ${user?.pointsBalance ?? 0} 分`)
    }
  }
  return { lines, pointsUsed }
}

/**
 * 下单事务内落实优惠：核销券、扣积分、占赠品名额。**必须在调用方的事务 tx 内执行**，
 * 任何一步失败整单回滚（spec §5.2/§5.3）。
 *
 * 三步都用条件更新判 `count`，这是并发防线：事务前的只读预检挡不住「两个请求同时用同一张券」
 * 或「最后一个赠品名额被两单同时抢」。
 */
export async function applyOrderBenefits(
  tx: Prisma.TransactionClient,
  input: { orderId: number; userId: number; coupon: ValidatedCoupon | null; giftLines: GiftLine[]; pointsUsed: number }
): Promise<void> {
  const { orderId, userId, coupon, giftLines, pointsUsed } = input

  if (coupon) {
    const used = await tx.userCoupon.updateMany({
      where: { id: coupon.id, userId, status: 'UNUSED' },
      data: { status: 'USED', usedAt: new Date(), orderId },
    })
    // count===0：这张券在预检之后被另一笔订单核销了
    if (used.count === 0) throw new AppError(42251, '优惠券已被使用')
  }

  if (pointsUsed > 0) {
    const { minExpiresAt } = await consumePoints(tx, userId, pointsUsed, {
      type: 'GIFT',
      refType: 'ORDER',
      refId: String(orderId),
      remark: '随单赠品',
    })
    // 把「被扣掉的那些入账行里最早的到期日」记在这条 GIFT 出账行上（spec §5.5）。
    // 未支付取消释放时，GIFT_REVERT 要继承它——**退回来的积分不该比原来更耐用**。
    // consumePoints 自己不写这个字段（它是通用扣减函数，不知道调用方要不要继承），
    // 所以由这里补写；`@@unique([type, refType, refId])` 保证只会命中那一行。
    if (minExpiresAt) {
      await tx.pointsLedger.updateMany({
        where: { type: 'GIFT', refType: 'ORDER', refId: String(orderId) },
        data: { expiresAt: minExpiresAt },
      })
    }
  }

  for (const g of giftLines) {
    // stockLimit 判定要的是 `issuedCount + quantity <= stockLimit`，
    // 用 `lt: stockLimit - quantity + 1` 表达（Prisma 没有直接的算术比较）
    const taken = await tx.pointsGood.updateMany({
      where: {
        id: g.pointsGoodId,
        status: 'ON',
        ...(await giftLimitWhere(tx, g)),
      },
      data: { issuedCount: { increment: g.quantity } },
    })
    if (taken.count === 0) throw new AppError(42252, '赠品已兑完')
  }
}

/** stockLimit 为 NULL 时不加限量条件；否则加 `issuedCount < stockLimit - quantity + 1` */
async function giftLimitWhere(tx: Prisma.TransactionClient, g: GiftLine) {
  const pg = await tx.pointsGood.findUnique({ where: { id: g.pointsGoodId }, select: { stockLimit: true } })
  return pg?.stockLimit != null ? { issuedCount: { lt: pg.stockLimit - g.quantity + 1 } } : {}
}

// ─────────────────────────────────────────────────────────
// 未支付取消：释放券与赠品积分（M2 Task 6，spec §5.5）
// ─────────────────────────────────────────────────────────

/**
 * 把这一单占用的券与积分还回去。**只服务 `PENDING_PAYMENT → CANCELLED`。**
 *
 * ⚠️ **调用方必须已经确认状态翻转成功**——即
 * `tx.order.updateMany({ where: { id, status: 'PENDING_PAYMENT' }, ... })` 的 `count === 1`。
 * 这条前提是整个函数幂等性的基础：`issuedCount` 的 decrement 靠 `{ gte: qty }` 判 count，
 * 它本身**不是真幂等**（同一单跑两次，若期间别人又兑了一份，第二次会把别人的名额减掉）。
 * 有了状态守卫，第二次调用根本进不来。
 *
 * **为什么按「状态守卫」而不是按端点名列白名单**：本项目有**四条** `PENDING_PAYMENT → CANCELLED`
 * 路径（顾客手点 / 后台改状态 / 商家拒单的待付款分支 / 超时任务），四处形状完全一致。
 * 按端点名列名单的写法在计划里就已经出过错——它把「拒单」整体归进「已支付、不释放」，
 * 而 `POST /admin/orders/:id/reject` 明明有一条 `PENDING_PAYMENT` 分支，照那样写就是
 * **待付款单被商家拒掉时顾客的券和积分永久蒸发，且没有任何日志**。
 * 名单会漏，状态守卫不会——将来加第五条路径，只要它遵守同一个模式就自动正确。
 *
 * **已支付后一律不释放**（P7）：秒退、商家取消已付款单、拒单的已付款分支、全额/部分退款，
 * 全都不经过这里。守卫条件写死 PENDING_PAYMENT 就是这条边界的执行者。
 *
 * 库存回滚**不在这里做**——四个调用点各自已经调了 `rollbackOrderStock(tx, order.items)`，
 * 而 `order.items` 天然包含赠品行（赠品行就是普通 OrderItem，只是 isGift=1），赠品库存随之回滚。
 * 2026-09-06 实测确认过这一点。
 */
export async function releaseOrderBenefits(
  tx: Prisma.TransactionClient,
  order: {
    id: number
    userId: number
    couponId: number | null
    pointsUsed: number
    // productId 可空：商品被硬删时 OrderItem 会置空。这种行的名额无处可退，下面直接跳过。
    items: { productId: number | null; skuId: number | null; quantity: number; isGift: boolean }[]
  }
): Promise<void> {
  const now = new Date()

  // ── 券 ────────────────────────────────────────────────
  if (order.couponId) {
    const c = await tx.userCoupon.findUnique({
      where: { id: order.couponId },
      select: { id: true, expiresAt: true },
    })
    if (c) {
      // 过期券不还给顾客用，但也不能留在 USED 状态误导（spec §5.5）。
      // ⚠️ 过期判定取 `<=`，与 pricing.ts 的 checkCouponUsable 和 scheduler 的 expireCouponsBatch
      // 同口径——三处必须一致，否则到期那一毫秒会出现「这边说过期、那边说能用」。
      const expired = c.expiresAt.getTime() <= now.getTime()
      await tx.userCoupon.updateMany({
        where: { id: order.couponId, status: 'USED', orderId: order.id },
        data: expired
          ? { status: 'EXPIRED', usedAt: null, orderId: null }
          : { status: 'UNUSED', usedAt: null, orderId: null },
      })
      // count===0 = 已经释放过了（或这张券根本不是本单核销的）。不报错：释放要幂等。
    }
  }

  // ── 赠品积分 ──────────────────────────────────────────
  if (order.pointsUsed > 0) {
    // 退回来的积分不该比原来更耐用（spec §5.5）：继承下单时那条 GIFT 出账行上记的
    // 「被扣掉的入账行里最早的到期日」。applyOrderBenefits 专门为此回填过这个字段。
    const giftRow = await tx.pointsLedger.findFirst({
      where: { type: 'GIFT', refType: 'ORDER', refId: String(order.id) },
      select: { expiresAt: true },
    })
    try {
      // balanceAfter 必须从 update 的返回值取，不能自己算——并发下自己算会写出错误的快照值
      const updated = await tx.user.update({
        where: { id: order.userId },
        data: { pointsBalance: { increment: order.pointsUsed } },
      })
      await tx.pointsLedger.create({
        data: {
          userId: order.userId,
          type: 'GIFT_REVERT',
          delta: order.pointsUsed,
          balanceAfter: updated.pointsBalance,
          // GIFT_REVERT 是入账行：remaining 要有值，它会跟 EARN 一起参与 FIFO 扣减与过期扫描
          remaining: order.pointsUsed,
          refType: 'ORDER',
          refId: String(order.id),
          remark: '取消订单退回赠品积分',
          expiresAt: giftRow?.expiresAt ?? null,
        },
      })
    } catch (e) {
      // @@unique([type, refType, refId]) 命中 = 这一单已经退过分了。
      // 但上面的 user.update 已经加过一次余额，必须原样减回去，否则余额会比账本多。
      if (isUniqueViolation(e)) {
        await tx.user.update({
          where: { id: order.userId },
          data: { pointsBalance: { decrement: order.pointsUsed } },
        })
      } else {
        throw e
      }
    }
  }

  // ── 赠品名额 ──────────────────────────────────────────
  for (const it of order.items) {
    if (!it.isGift) continue
    // productId 为空 = 商品被硬删。名额无处可退，跳过（不是错误）
    if (it.productId === null) continue
    // 按 (productId, skuId) 找回对应的 PointsGood——OrderItem 上不存 pointsGoodId
    // （它落的是商品快照，与 PointsGood 配置解耦，配置删了历史订单也不受影响）
    const pg = await tx.pointsGood.findFirst({
      where: { productId: it.productId, skuId: it.skuId },
      select: { id: true },
    })
    if (!pg) continue // 配置已被删除，名额无处可退，跳过
    await tx.pointsGood.updateMany({
      where: { id: pg.id, issuedCount: { gte: it.quantity } },
      data: { issuedCount: { decrement: it.quantity } },
    })
  }
}

/** Prisma 唯一约束冲突 */
function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: string }).code === 'P2002'
}
