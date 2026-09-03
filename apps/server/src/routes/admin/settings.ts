/**
 * 店铺设置（后台）。目前只有运费规则，后续配置项往这里加。
 *
 * 金额以「分」传输，与订单接口一致；后台界面负责元/分换算。
 */

import { Router } from 'express'
import { z } from 'zod'
import { getShippingSettings, setShippingSettings } from '../../services/settings'

const router = Router()

// 上限不是随便定的：运费 ¥1000、门槛 ¥10 万，
// 挡住把「元」当「分」填进来这类手滑（少填两个 0 只会少收钱，多填才危险）。
const shippingSchema = z.object({
  fee: z.number().int().min(0).max(100_000),
  freeThreshold: z.number().int().min(0).max(10_000_000),
  minOrderAmount: z.number().int().min(0).max(10_000_000),
})

router.get('/shipping', async (_req, res, next) => {
  try {
    res.json({ code: 0, message: 'ok', data: await getShippingSettings() })
  } catch (e) {
    next(e)
  }
})

router.put('/shipping', async (req, res, next) => {
  try {
    const body = shippingSchema.parse(req.body)
    res.json({ code: 0, message: 'ok', data: await setShippingSettings(body) })
  } catch (e) {
    next(e)
  }
})

export default router
