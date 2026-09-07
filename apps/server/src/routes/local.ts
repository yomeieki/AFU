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
  getLocalSettings, publicLocalMeta, isOpenNow, isPaused, nextOpenText,
  billableDistanceM, haversineM, calcLocalFee, estimateMinutesRange, signQuote, quoteExpiresAt,
} from '../services/local-settings'
import { measureRoadDistanceM } from '../services/delivery/quote'

const router = Router()

router.get('/meta', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    success(res, publicLocalMeta(await getLocalSettings()))
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
    const measuredM = await measureRoadDistanceM(s, { latE6, lngE6 })
    const distanceM = measuredM ?? estimatedM
    const distanceSource: 'MEASURED' | 'ESTIMATED' = measuredM === null ? 'ESTIMATED' : 'MEASURED'
    const q = calcLocalFee(s, distanceM, body.subtotal)
    const est = estimateMinutesRange(s, distanceM)
    // token 与 quoteExpiresAt 必须出自**同一个 issuedAt**：分别取 new Date() 的话，
    // 两次调用之间的毫秒差会让客户端算出的过期时刻比 token 里的 e 早或晚，
    // 边界上会出现「页面以为还新鲜、服务端已经拒了」。
    const issuedAt = new Date()
    success(res, {
      enabled: s.enabled,
      isOpen: isOpenNow(s),
      paused: isPaused(s) ? { reason: s.paused?.reason ?? '' } : null,
      nextOpenText: nextOpenText(s),
      inRange: q.inRange,
      distanceM,
      distanceSource,
      straightDistanceM: haversineM(s.store.latE6, s.store.lngE6, latE6, lngE6),
      fee: q.fee,
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
            fee: q.fee, distanceM, addressId, latE6, lngE6,
            storeLatE6: s.store.latE6, storeLngE6: s.store.lngE6,
            distanceSource,
          }, issuedAt)
        : null,
      // 没签 token 就没有「过期」可言（匿名报价、超范围）——给 null 而不是给一个
      // 悬空的时刻，免得客户端拿它去判一张根本不存在的凭证还新不新鲜。
      quoteExpiresAt: q.inRange && addressId > 0 ? quoteExpiresAt(issuedAt).toISOString() : null,
    })
  } catch (e) {
    next(e)
  }
})

export default router
