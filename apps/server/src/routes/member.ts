/**
 * 顾客端会员积分/优惠券接口。挂在 verifyUserToken 之后（见 routes/index.ts），
 * 一律 where: { userId: req.userId! }，绝不接受前端传入的 userId（spec §5.7）。
 *
 * 五个端点：三个只读 + 两个写（2026-09-05 回填，见
 * docs/superpowers/plans/2026-09-04-member-m1-ledger.md Task 7 Step 1b）。
 * 写端点是薄壳：只做取 userId、校验 body、转调 services/member/*，把 AppError 原样透出，
 * 不含业务逻辑——逻辑全在 Task 4 的服务函数里。
 */
import { Router, Request, Response, NextFunction } from 'express'
import { z } from 'zod'
import { success } from '../utils/response'
import { memberReadLimiter, memberWriteLimiter } from '../middlewares/rate-limit'
import { getPointsSummary, listLedger } from '../services/member/points'
import { redeemByPoints, claimCampaign, listUserCoupons, countAvailable, toCouponView, CouponListStatus } from '../services/member/coupons'
import { loadCheckoutOptions } from '../services/member/checkout'
import { getMemberSettings } from '../services/member/settings'
import prisma from '../utils/prisma'

const router = Router()

// GET /api/member/summary — 积分余额 / 即将过期分与日期 / 可用券数
router.get('/summary', memberReadLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.userId!
    const [points, availableCoupons, settings] = await Promise.all([
      getPointsSummary(userId),
      countAvailable(userId),
      getMemberSettings(),
    ])
    // M16：docs/member-terms-copy.md 的常驻文案「若 1 年内无消费，您的 {balance} 分将于
    // {expiresAt} 全部过期」需要 pointsExpireAt 渲染——getPointsSummary 早已算出这个值
    // （PointsSummary.pointsExpireAt），只是这里漏透传，前端拿到的字段一直是 undefined。
    success(res, {
      pointsBalance: points.balance,
      expiringSoon: points.expiringSoon,
      pointsExpireAt: points.pointsExpireAt,
      availableCoupons,
      // 会员中心的「规则说明」是 spec §2 的**合规公示项**，文案里的比例与有效期
      // 必须是后台设置的实时值（docs/member-terms-copy.md 一开头就点名：
      // 「不要写死数字……写死了就会出现『文案说 100 分、实际发 50 分』这种最难解释的场面」）。
      // 顾客端此前拿不到 earnRatePerYuan / validDays / rulesText，只能写死——所以这里透传。
      // 只出这三项，不整包透传 settings：newcomer.templateId 是运营信息，顾客不需要知道。
      points: {
        enabled: settings.points.enabled,
        earnRatePerYuan: settings.points.earnRatePerYuan,
        validDays: settings.points.validDays,
      },
      rulesText: settings.rulesText,
    })
  } catch (e) {
    next(e)
  }
})

const ledgerQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
})

// GET /api/member/points/ledger?page=&pageSize= — 积分流水
// 输出白名单：type 文案 / delta / refType / refId / remark / createdAt（不返回内部自增 id、原始 type 码）
router.get('/points/ledger', memberReadLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.userId!
    const { page, pageSize } = ledgerQuerySchema.parse(req.query)
    const { list, total } = await listLedger(userId, page, pageSize)
    success(res, {
      list: list.map((r) => ({
        typeLabel: r.typeLabel,
        delta: r.delta,
        refType: r.refType,
        refId: r.refId,
        remark: r.remark,
        // 入账行的到期日（顾客端「有效期至」）与 ORDER 行的单号（listLedger 已限定本人的单联查出来）。
        // 仍然不放 id 与原始 type 码——那两个是内部口径。
        expiresAt: r.expiresAt,
        orderNo: r.orderNo,
        createdAt: r.createdAt,
      })),
      total,
      page,
      pageSize,
    })
  } catch (e) {
    next(e)
  }
})

const couponsQuerySchema = z.object({
  status: z.enum(['available', 'used', 'expired']),
})

// GET /api/member/coupons?status=available|used|expired
// 输出白名单：id/code/name/amount/threshold/channel/status/source/expiresAt/usedAt/orderId
// （orderId 是 M4 加的，「已用于订单 …」要能点进详情；它是顾客**自己的**订单 id，不是越权字段）
// （不返回 issuedBy/remark/sourceRef/templateId）——listUserCoupons 的 select 已经是这份白名单，
// 这里不再二次收窄，避免两处白名单各写一份、日后改漏一处。
router.get('/coupons', memberReadLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.userId!
    const { status } = couponsQuerySchema.parse(req.query)
    const list = await listUserCoupons(userId, status as CouponListStatus)
    success(res, { list })
  } catch (e) {
    next(e)
  }
})

const templateIdSchema = z.object({
  templateId: z.coerce.number().int().positive('templateId 必须为正整数'),
})

// POST /api/member/points/redeem { templateId } — 积分兑换优惠券
// 响应过 toCouponView() 裁剪成与 GET /coupons 同一份白名单——redeemByPoints() 返回的是
// issueCoupon() 建出来的完整 UserCoupon 行，直接透传会泄露 issuedBy/remark/sourceRef/
// templateId/userId 等内部字段（只是本人数据，无越权，但违反 spec §5.7 的输出约定）。
router.post('/points/redeem', memberWriteLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.userId!
    const { templateId } = templateIdSchema.parse(req.body)
    const coupon = await redeemByPoints(userId, templateId)
    success(res, toCouponView(coupon))
  } catch (e) {
    next(e)
  }
})

// POST /api/member/coupons/claim { templateId } — 领券中心领取（响应白名单同上）
router.post('/coupons/claim', memberWriteLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.userId!
    const { templateId } = templateIdSchema.parse(req.body)
    const coupon = await claimCampaign(userId, templateId)
    success(res, toCouponView(coupon))
  } catch (e) {
    next(e)
  }
})

const checkoutOptionsSchema = z.object({
  channel: z.enum(['LOCAL', 'EXPRESS']),
  // 小计由前端传：它是「这一单当前选了哪些商品」的结果，服务端在结算页阶段并不知道购物车选中项。
  // ⚠️ 这个值**只用于展示**——算券可不可用、抵多少，让顾客在点「提交」之前就看到准确数字。
  // 真正下单时 `POST /orders` 会用**自己算出来的**小计重新判一遍（Task 4/5），
  // 所以这里传假值最多让顾客看到一个乐观的预览，换不来任何实际优惠。
  subtotal: z.coerce.number().int().min(0).max(100000000),
})

// GET /api/member/checkout-options?channel=&subtotal= — 结算页的券与赠品
router.get('/checkout-options', memberReadLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { channel, subtotal } = checkoutOptionsSchema.parse(req.query)
    success(res, await loadCheckoutOptions(req.userId!, channel, subtotal))
  } catch (e) {
    next(e)
  }
})

// GET /api/member/mall — 积分商城：可用积分换的券模板 + 全部随单赠品
router.get('/mall', memberReadLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.userId!
    const [user, settings, templates, goods] = await Promise.all([
      prisma.user.findUnique({ where: { id: userId }, select: { pointsBalance: true } }),
      getMemberSettings(),
      prisma.couponTemplate.findMany({
        where: { source: 'POINTS', status: 'ON', pointsCost: { not: null } },
        select: { id: true, name: true, description: true, amount: true, threshold: true, channel: true, validDays: true, pointsCost: true },
        orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      }),
      prisma.pointsGood.findMany({
        where: { status: 'ON' },
        select: { id: true, productId: true, skuId: true, pointsCost: true, perOrderLimit: true, stockLimit: true, issuedCount: true },
        orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      }),
    ])

    // 商城页**不按渠道过滤赠品**，而是把 channel 原样带出去让前端分组展示：
    // 顾客是在「逛商城」而不是在结算，这时藏掉另一条渠道的东西只会让人以为东西没了。
    // 真正的渠道限制在结算页（loadCheckoutOptions）和下单时执行。
    const productIds = [...new Set(goods.map((g) => g.productId))]
    const skuIds = goods.map((g) => g.skuId).filter((v): v is number => v !== null)
    const [products, skus] = await Promise.all([
      productIds.length
        ? prisma.product.findMany({
            where: { id: { in: productIds }, deletedAt: null, status: 'ON_SHELF' },
            select: { id: true, name: true, coverImage: true, stock: true, channel: true },
          })
        : Promise.resolve([]),
      skuIds.length
        ? prisma.productSku.findMany({ where: { id: { in: skuIds } }, select: { id: true, specText: true, stock: true } })
        : Promise.resolve([]),
    ])
    const productById = new Map(products.map((x) => [x.id, x]))
    const skuById = new Map(skus.map((s) => [s.id, s]))

    const gifts = goods.flatMap((g) => {
      const product = productById.get(g.productId)
      if (!product) return []
      const sku = g.skuId !== null ? skuById.get(g.skuId) : undefined
      if (g.skuId !== null && !sku) return []
      const stock = sku ? sku.stock : product.stock
      const remaining = g.stockLimit === null ? null : g.stockLimit - g.issuedCount
      if (stock <= 0 || (remaining !== null && remaining <= 0)) return []
      return [{
        id: g.id, productId: g.productId, skuId: g.skuId, name: product.name, image: product.coverImage,
        specText: sku?.specText ?? null, channel: product.channel,
        pointsCost: g.pointsCost, perOrderLimit: g.perOrderLimit, stock, remaining,
      }]
    })

    success(res, {
      pointsBalance: user?.pointsBalance ?? 0,
      points: { enabled: settings.points.enabled, earnRatePerYuan: settings.points.earnRatePerYuan },
      coupons: templates,
      gifts,
    })
  } catch (e) {
    next(e)
  }
})

// GET /api/member/campaign — 领券中心：CAMPAIGN 模板 + 剩余量 + 本人已领张数
router.get('/campaign', memberReadLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.userId!
    const templates = await prisma.couponTemplate.findMany({
      where: { source: 'CAMPAIGN', status: 'ON' },
      select: {
        id: true, name: true, description: true, amount: true, threshold: true,
        channel: true, validDays: true, totalLimit: true, perUserLimit: true, issuedCount: true,
      },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    })
    // 「本人已领 N 张」按模板分组数一次，而不是逐张模板查一遍
    const mine = templates.length
      ? await prisma.userCoupon.groupBy({
          by: ['templateId'],
          where: { userId, templateId: { in: templates.map((t) => t.id) } },
          _count: { _all: true },
        })
      : []
    const mineByTemplate = new Map(mine.map((m) => [m.templateId, m._count._all]))

    success(res, {
      list: templates.map(({ totalLimit, issuedCount, ...t }) => ({
        ...t,
        // 剩余量：totalLimit 为空 = 不限量。issuedCount 本身不外露——它是运营数据，
        // 顾客只需要知道「还剩多少」和「自己领了几张」。
        remaining: totalLimit === null ? null : Math.max(0, totalLimit - issuedCount),
        claimedByMe: mineByTemplate.get(t.id) ?? 0,
      })),
    })
  } catch (e) {
    next(e)
  }
})

export default router
