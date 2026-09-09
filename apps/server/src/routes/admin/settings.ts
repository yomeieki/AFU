/**
 * 店铺设置（后台）。目前只有运费规则，后续配置项往这里加。
 *
 * 金额以「分」传输，与订单接口一致；后台界面负责元/分换算。
 */

import { Router } from 'express'
import { z } from 'zod'
import { config } from '../../config'
import { getMemberSettings, setMemberSettings } from '../../services/member/settings'
import { AppError } from '../../middlewares/error'
import {
  getLocalSettings, setLocalSettings, patchLocalSettings, sanitizeLocalSettings,
  validateLocalSettings, validateForEnable, validateRawLocalSettings,
} from '../../services/local-settings'
import { getDeliveryProvider } from '../../services/delivery/provider'
import {
  getExpressSettings, setExpressSettings, sanitizeExpressSettings, validateExpressSettings,
  legacyShippingView, applyLegacyShipping,
} from '../../services/express-settings'

const router = Router()

// 上限不是随便定的：运费 ¥1000、门槛 ¥10 万，
// 挡住把「元」当「分」填进来这类手滑（少填两个 0 只会少收钱，多填才危险）。
const shippingSchema = z.object({
  fee: z.number().int().min(0).max(100_000),
  freeThreshold: z.number().int().min(0).max(10_000_000),
  minOrderAmount: z.number().int().min(0).max(10_000_000),
})

// 老接口，过渡期兼容：读写都落在新的 express_delivery 设置上（services/express-settings.ts
// 的 legacyShippingView / applyLegacyShipping），不再有独立的 shipping key。
router.get('/shipping', async (_req, res, next) => {
  try {
    res.json({ code: 0, message: 'ok', data: legacyShippingView(await getExpressSettings()) })
  } catch (e) {
    next(e)
  }
})

// 写侧只在非生产挂载：applyLegacyShipping 会把全店切回 TABLE 一口价并抹平分组表（2026-09-09 线上事故），
// 生产只留 GET 兼容视图；e2e（dev 端口）仍靠 PUT 造一口价基线。
if (!config.isProduction) {
  router.put('/shipping', async (req, res, next) => {
    try {
      const body = shippingSchema.parse(req.body)
      const merged = applyLegacyShipping(await getExpressSettings(), body)
      res.json({ code: 0, message: 'ok', data: legacyShippingView(await setExpressSettings(merged)) })
    } catch (e) {
      next(e)
    }
  })
}

// 数值范围与结构在此校验；templateId 是否存在且为 NEWCOMER 模板，业务语义更重，交给
// setMemberSettings 去查库校验（返回 40001，见 services/member/settings.ts）
const memberSettingsSchema = z.object({
  points: z.object({
    enabled: z.boolean(),
    earnRatePerYuan: z.number().int().min(1).max(100),
    validDays: z.number().int().min(1).max(3650),
  }),
  newcomer: z.object({
    templateId: z.number().int().positive().nullable(),
  }),
  rulesText: z.string().max(2000),
})

router.get('/member', async (_req, res, next) => {
  try {
    res.json({ code: 0, message: 'ok', data: await getMemberSettings() })
  } catch (e) {
    next(e)
  }
})

router.put('/member', async (req, res, next) => {
  try {
    const body = memberSettingsSchema.parse(req.body)
    res.json({ code: 0, message: 'ok', data: await setMemberSettings(body) })
  } catch (e) {
    next(e)
  }
})

router.get('/local-delivery', async (_req, res, next) => {
  try {
    res.json({ code: 0, message: 'ok', data: await getLocalSettings() })
  } catch (e) {
    next(e)
  }
})

// 全量保存：先 sanitize 再业务校验；开启总开关时额外做完整性校验
router.put('/local-delivery', async (req, res, next) => {
  try {
    // 顺序要紧：先拿**原始请求体**查一遍，再 sanitize。
    // sanitize 会把不合法的营业时段整条丢掉，之后就再也看不出「丢了几条」了。
    const rawErrs = validateRawLocalSettings(req.body)
    const next_ = sanitizeLocalSettings(req.body)
    const errs = [...rawErrs, ...(next_.enabled ? validateForEnable(next_) : validateLocalSettings(next_))]
    if (errs.length) throw new AppError(40001, errs.join('；'))
    res.json({ code: 0, message: 'ok', data: await setLocalSettings(next_) })
  } catch (e) {
    next(e)
  }
})

const locationSchema = z.object({
  latE6: z.number().int().min(-90_000_000).max(90_000_000),
  lngE6: z.number().int().min(-180_000_000).max(180_000_000),
})
router.patch('/local-delivery/store-location', async (req, res, next) => {
  try {
    const { latE6, lngE6 } = locationSchema.parse(req.body)
    const current = await getLocalSettings()
    res.json({ code: 0, message: 'ok', data: await patchLocalSettings({ store: { ...current.store, latE6, lngE6 } }) })
  } catch (e) {
    next(e)
  }
})

const pauseSchema = z.object({
  reason: z.string().trim().min(1, '请填写暂停原因').max(60),
  until: z.string().datetime().optional(),
})
router.post('/local-delivery/pause', async (req, res, next) => {
  try {
    const { reason, until } = pauseSchema.parse(req.body)
    res.json({ code: 0, message: 'ok', data: await patchLocalSettings({ paused: { reason, until: until ?? null } }) })
  } catch (e) {
    next(e)
  }
})
router.delete('/local-delivery/pause', async (_req, res, next) => {
  try {
    res.json({ code: 0, message: 'ok', data: await patchLocalSettings({ paused: null }) })
  } catch (e) {
    next(e)
  }
})

// POST /local-delivery/probe — 用当前门店坐标 + 一个探测点试算运力报价（不落库、不下单）
router.post('/local-delivery/probe', async (req, res, next) => {
  try {
    const { latE6, lngE6 } = locationSchema.parse(req.body)
    const s = await getLocalSettings()
    if (s.store.latE6 === null || s.store.lngE6 === null) throw new AppError(42226, '门店尚未设置坐标')
    const r = await getDeliveryProvider().price({
      sender: { name: s.store.name, mobile: s.store.phone, province: s.store.province, city: s.store.city, district: s.store.district, address: s.store.address, latE6: s.store.latE6, lngE6: s.store.lngE6 },
      receiver: { name: '探测', mobile: '13800000000', province: s.store.province, city: s.store.city, district: s.store.district, address: '探测点', latE6, lngE6 },
    })
    res.json({ code: 0, message: 'ok', data: { feeFen: r.feeFen, distanceM: r.distanceM } })
  } catch (e) { next(e) }
})

router.get('/express', async (_req, res, next) => {
  try { res.json({ code: 0, message: 'ok', data: await getExpressSettings() }) } catch (e) { next(e) }
})
router.put('/express', async (req, res, next) => {
  try {
    const next_ = sanitizeExpressSettings(req.body)
    const errs = validateExpressSettings(next_)
    if (errs.length) throw new AppError(40001, errs.join('；'))
    res.json({ code: 0, message: 'ok', data: await setExpressSettings(next_) })
  } catch (e) { next(e) }
})

export default router
