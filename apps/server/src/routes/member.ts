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
import { redeemByPoints, claimCampaign, listUserCoupons, countAvailable, CouponListStatus } from '../services/member/coupons'

const router = Router()

// GET /api/member/summary — 积分余额 / 即将过期分与日期 / 可用券数
router.get('/summary', memberReadLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.userId!
    const [points, availableCoupons] = await Promise.all([getPointsSummary(userId), countAvailable(userId)])
    success(res, { pointsBalance: points.balance, expiringSoon: points.expiringSoon, availableCoupons })
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
// 输出白名单：id/code/name/amount/threshold/channel/status/source/expiresAt/usedAt
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
router.post('/points/redeem', memberWriteLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.userId!
    const { templateId } = templateIdSchema.parse(req.body)
    const coupon = await redeemByPoints(userId, templateId)
    success(res, coupon)
  } catch (e) {
    next(e)
  }
})

// POST /api/member/coupons/claim { templateId } — 领券中心领取
router.post('/coupons/claim', memberWriteLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.userId!
    const { templateId } = templateIdSchema.parse(req.body)
    const coupon = await claimCampaign(userId, templateId)
    success(res, coupon)
  } catch (e) {
    next(e)
  }
})

export default router
