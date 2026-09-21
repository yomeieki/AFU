/**
 * 同城配送公开接口：菜单页店头（meta）与地址报价（quote）。
 * 未登录也可浏览菜单 → meta 完全公开；quote 传 addressId 时需登录（校验地址归属）。
 */
import { Router, Request, Response, NextFunction } from 'express'
import { z } from 'zod'
import prisma from '../utils/prisma'
import { success } from '../utils/response'
import { AppError } from '../middlewares/error'
import { optionalUserAuth } from '../middlewares/auth'
import { localQuoteLimiter } from '../middlewares/rate-limit'
import {
  getLocalSettings, publicLocalMeta, isOpenNow, isPaused, nextOpenText, closedKind,
  billableDistanceM, haversineM, calcLocalFee, tableBaseFee, quoteBaseFee, estimateMinutesRange, signQuote, quoteExpiresAt,
} from '../services/local-settings'
import { promoPreviewOf } from '../services/promotion'
import { measureRoadQuote } from '../services/delivery/quote'
import { buildPickupSlots } from '../services/pickup'
import { buildDeliverySlots, earliestScheduleText } from '../services/delivery/schedule'
import { deliveryTypeSchema } from '../utils/channel'

const router = Router()

router.get('/meta', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const s = await getLocalSettings()
    const meta = publicLocalMeta(s)
    // 页头还没有地址算不出路上时间，用配送半径算一个保守的最早送达（spec §4.3）
    success(res, { ...meta, delivery: { ...meta.delivery, earliestScheduleText: earliestScheduleText(s) } })
  } catch (e) {
    next(e)
  }
})

// 自取时段（公开；不登录也能看）。全部计算在 services/pickup.ts，这里只是读设置 + 出参
router.get('/pickup-slots', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    success(res, buildPickupSlots(await getLocalSettings(), new Date()))
  } catch (e) {
    next(e)
  }
})

// 预约外送时段（公开）。distanceM 必传：来自结算页已拿到的报价，时段的提前量取决于路上时间
const deliverySlotsSchema = z.object({ distanceM: z.coerce.number().int().min(0).max(200_000) })
router.get('/delivery-slots', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { distanceM } = deliverySlotsSchema.parse(req.query)
    success(res, buildDeliverySlots(await getLocalSettings(), distanceM, new Date()))
  } catch (e) {
    next(e)
  }
})

const quoteSchema = z
  .object({
    addressId: z.number().int().positive().optional(),
    latE6: z.number().int().min(-90_000_000).max(90_000_000).optional(),
    lngE6: z.number().int().min(-180_000_000).max(180_000_000).optional(),
    subtotal: z.number().int().min(0).max(100_000_000).default(0),
  })
  .refine((v) => v.addressId !== undefined || (v.latE6 !== undefined && v.lngE6 !== undefined), {
    message: '请提供 addressId 或坐标',
  })

router.post('/quote', localQuoteLimiter, optionalUserAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = quoteSchema.parse(req.body)
    const s = await getLocalSettings()
    if (!s.enabled) throw new AppError(42226, '同城配送暂未开通')
    if (s.store.latE6 === null || s.store.lngE6 === null) throw new AppError(42226, '门店尚未设置坐标，暂不能配送')

    let latE6: number, lngE6: number, addressId = 0
    if (body.addressId !== undefined) {
      if (!req.userId) throw new AppError(40101, '请先登录', 401)
      const addr = await prisma.address.findFirst({ where: { id: body.addressId, userId: req.userId, deletedAt: null } })
      if (!addr) throw new AppError(40401, '收货地址不存在', 404)
      if (addr.latE6 === null || addr.lngE6 === null) throw new AppError(42223, '该地址缺少定位，请编辑地址并在地图上选点')
      latE6 = addr.latE6; lngE6 = addr.lngE6; addressId = addr.id
    } else {
      latE6 = body.latE6!; lngE6 = body.lngE6!
    }

    // 真实道路距离优先，查不到（超时/运力方报错/门店未设坐标）就退回直线 × detourFactor 的估算，
    // **不报错**：顾客只是在看运费，让他看到一个偏保守的数字远好过弹一个「暂时查不到」。
    // distanceSource 让调用方分得清这次是实测还是估算（小程序据此决定文案）。
    const estimatedM = billableDistanceM(s, latE6, lngE6)!
    const measured = await measureRoadQuote(s, { latE6, lngE6 })
    const distanceM = measured?.distanceM ?? estimatedM
    const distanceSource: 'MEASURED' | 'ESTIMATED' = measured === null ? 'ESTIMATED' : 'MEASURED'
    // 定价口径（PO 2026-09-08）：QUOTE = 最低报价 + 加价（取整），查不到报价就退回固定表。
    // 退回是**必须有**的一条路：查价 5 秒超时或运力方报错时没有价可依，
    // 而顾客只是在看运费——给他一个偏保守的表价，远好过让运费这一栏空着。
    const baseFee = s.fee.mode === 'QUOTE' && measured?.lowestFen != null
      ? quoteBaseFee(s, measured.lowestFen, distanceM)
      : tableBaseFee(s, distanceM)
    const feeSource: 'QUOTE' | 'TABLE' =
      s.fee.mode === 'QUOTE' && measured?.lowestFen != null ? 'QUOTE' : 'TABLE'
    const q = calcLocalFee(s, distanceM, body.subtotal, baseFee)
    const est = estimateMinutesRange(s, distanceM)
    // token 与 quoteExpiresAt 必须出自**同一个 issuedAt**：分别取 new Date() 的话，
    // 两次调用之间的毫秒差会让客户端算出的过期时刻比 token 里的 e 早或晚，
    // 边界上会出现「页面以为还新鲜、服务端已经拒了」。
    const issuedAt = new Date()
    // 全店满减（2026-09-17 设计 §4.4）：结算页/购物车条要显示「本单减多少 / 还差多少到下一档」，
    // 与 quote 同一批返回，避免多一次请求。用 LOCAL 渠道、body.subtotal（券前、满减前商品小计）。
    const promoPreview = promoPreviewOf(s, body.subtotal, 'LOCAL', issuedAt)
    success(res, {
      enabled: s.enabled,
      isOpen: isOpenNow(s),
      paused: isPaused(s) ? { reason: s.paused?.reason ?? '' } : null,
      nextOpenText: nextOpenText(s),
      closedKind: closedKind(s),
      inRange: q.inRange,
      distanceM,
      distanceSource,
      straightDistanceM: haversineM(s.store.latE6, s.store.lngE6, latE6, lngE6),
      fee: q.fee,
      // 这一单的运费是按实时报价定的还是退回了固定表。**只给口径，不给金额**——
      // 各家报价是店家付给骑手的成本，不能顺着顾客侧接口漏出去。
      feeSource,
      minOrderAmount: s.fee.minOrderAmount,
      belowMin: q.belowMin,
      // 结算页只给**大概**，不给钟点（PO 2026-09-07）：备餐是从店员接单才开始的，
      // 而这一刻店员还没接单，任何绝对时刻都是在替他打包票。高峰期给区间（25–30 + 路上），
      // 平时 min===max。真正的预计送达钟点在接单时才落库，见 admin/delivery.ts 的 doAccept。
      estimatedMinutes: est.max,          // 兼容旧字段：老版本小程序仍读它，给上界（保守）
      estimatedMinRange: est.min,
      estimatedMaxRange: est.max,
      isPeakNow: est.isPeak,
      // 收货坐标与门店坐标一并签进 token：下单端点信任 token 里的 distanceM，两对坐标任何一边动了
      // 这段距离就不再成立（见 signQuote 注释）。
      //
      // 签发条件是 `inRange && addressId > 0`，不是只看 inRange：匿名报价（只传坐标、不传 addressId）
      // 签出来的是 addressId=0，而下单必然带一个真实地址 id，这张票 100% 兑不了。留着它就是个陷阱——
      // 将来有人拿匿名报价的 token 去下单，只会看到一个指不到病根的 42239。
      // 于是这里的不变量可以直说：**签出来的凭证，在签发那一刻一定是可兑付的**。
      quoteToken: q.inRange && addressId > 0
        ? signQuote({
            fee: q.fee, baseFee, feeSource, distanceM, addressId, latE6, lngE6,
            storeLatE6: s.store.latE6, storeLngE6: s.store.lngE6,
            distanceSource,
          }, issuedAt)
        : null,
      // 没签 token 就没有「过期」可言（匿名报价、超范围）——给 null 而不是给一个
      // 悬空的时刻，免得客户端拿它去判一张根本不存在的凭证还新不新鲜。
      quoteExpiresAt: q.inRange && addressId > 0 ? quoteExpiresAt(issuedAt).toISOString() : null,
      promoDiscountFen: promoPreview.discountFen,
      nextTierGapFen: promoPreview.nextTierGapFen,
    })
  } catch (e) {
    next(e)
  }
})

const promoPreviewSchema = z.object({
  deliveryType: deliveryTypeSchema,
  subtotal: z.coerce.number().int().min(0).max(100_000_000),
})

// 公开、不登录、无限流：自取结算页与购物车条唯一能拿到「本单减多少 / 还差多少」的地方——
// 自取没有报价接口，购物车阶段也没有地址报不了 LOCAL 的价（2026-09-17 全店满减设计 §4.4）。
// subtotal 是顾客传的展示用值，真正下单时服务端自己按 totalAmount 重算（同
// member/checkout-options 的说明：前端展示可以信任传参，落库金额永远服务端说了算）。
router.get('/promo-preview', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { deliveryType, subtotal } = promoPreviewSchema.parse(req.query)
    success(res, promoPreviewOf(await getLocalSettings(), subtotal, deliveryType, new Date()))
  } catch (e) {
    next(e)
  }
})

export default router
