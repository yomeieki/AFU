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
import {
  getLocalSettings, publicLocalMeta, isOpenNow, isPaused, nextOpenText,
  billableDistanceM, haversineM, calcLocalFee, estimateMinutes, signQuote,
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

router.post('/quote', optionalUserAuth, async (req: Request, res: Response, next: NextFunction) => {
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
      estimatedMinutes: estimateMinutes(s, distanceM),
      // 坐标一并签进 token：下单端点信任 token 里的 distanceM，若只绑 addressId，顾客可以
      // 「近处报价 → 改这个地址的坐标到远处 → 用旧 token 下单」按近处收费（见 signQuote 注释）。
      quoteToken: q.inRange ? signQuote({ fee: q.fee, distanceM, addressId, latE6, lngE6, version: s.version }) : null,
    })
  } catch (e) {
    next(e)
  }
})

export default router
