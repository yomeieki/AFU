/**
 * 全国邮寄运营参数（settings 表 key=express_delivery）。
 * 与 local-settings.ts 同款：60 秒进程缓存、保存即失效、sanitize 只回落不抛。
 * 设计：docs/superpowers/specs/2026-09-08-express-shipping-kuaidi100-design.md §2
 */
import prisma from '../utils/prisma'
import { getShippingSettings, ShippingSettings } from './settings'
import { notifySystemAlert } from './notify'
import { AppError } from '../middlewares/error'

export const EXPRESS_SETTINGS_KEY = 'express_delivery'
const CACHE_TTL_MS = 60 * 1000

/** 快递100 上门取件（线上支付）支持的 9 家，编码即 kuaidicom */
export const EXPRESS_COURIERS = ['shunfeng', 'jd', 'debangkuaidi', 'jtexpress', 'yuantong', 'shentong', 'zhongtong', 'yunda', 'ems'] as const
export type ExpressCourier = (typeof EXPRESS_COURIERS)[number]
export const COURIER_LABEL: Record<string, string> = {
  shunfeng: '顺丰速运', jd: '京东物流', debangkuaidi: '德邦快递', jtexpress: '极兔速递', yuantong: '圆通速递',
  shentong: '申通快递', zhongtong: '中通快递', yunda: '韵达快递', ems: '邮政 EMS',
}

/** 微信 picker mode="region" 的省级全名 */
export const PROVINCE_NAMES = [
  '北京市', '天津市', '河北省', '山西省', '内蒙古自治区', '辽宁省', '吉林省', '黑龙江省', '上海市', '江苏省', '浙江省',
  '安徽省', '福建省', '江西省', '山东省', '河南省', '湖北省', '湖南省', '广东省', '广西壮族自治区', '海南省', '重庆市',
  '四川省', '贵州省', '云南省', '西藏自治区', '陕西省', '甘肃省', '青海省', '宁夏回族自治区', '新疆维吾尔自治区',
  '香港特别行政区', '澳门特别行政区', '台湾省',
] as const

export const OTHER_GROUP = '其他'

export interface RegionGroup {
  name: string
  provinces: string[]
  /** 满额包邮门槛（分），按券前商品小计判；0 = 该组不包邮 */
  freeShipMinFen: number
  /** 兜底表：首重 1 kg 价（分） */
  tableFirstFen: number
  /** 兜底表：续重每公斤（分） */
  tableOverPerKgFen: number
  /** 不寄送 */
  blocked: boolean
}

export interface ExpressSettings {
  version: number
  weight: { packagingG: number; defaultItemG: number }
  /** 参与中位数定价的 kuaidicom 列表 */
  pricingPool: string[]
  fee: { mode: 'QUOTE' | 'TABLE'; markupFen: number; roundToFen: number; minQuoteCount: number }
  minOrderAmountFen: number
  regionGroups: RegionGroup[]
  /** 接单后顾客可申请取消的窗口（分钟），0 = 关闭 */
  acceptGraceMin: number
  pickup: { cargoName: string; defaultRemark: string; unacceptedRemindHours: number; unpickedRemindMin: number }
  costAlertRatio: number
}

export const DEFAULT_EXPRESS_SETTINGS: ExpressSettings = {
  version: 0,
  weight: { packagingG: 800, defaultItemG: 300 },
  pricingPool: ['jtexpress', 'yuantong', 'shentong', 'yunda', 'zhongtong', 'jd'],
  fee: { mode: 'QUOTE', markupFen: 0, roundToFen: 50, minQuoteCount: 2 },
  minOrderAmountFen: 0,
  regionGroups: [
    { name: '四川', provinces: ['四川省'], freeShipMinFen: 9900, tableFirstFen: 800, tableOverPerKgFen: 150, blocked: false },
    { name: '周边', provinces: ['重庆市', '云南省', '贵州省', '陕西省', '甘肃省'], freeShipMinFen: 14900, tableFirstFen: 1000, tableOverPerKgFen: 300, blocked: false },
    { name: OTHER_GROUP, provinces: [], freeShipMinFen: 19900, tableFirstFen: 1200, tableOverPerKgFen: 300, blocked: false },
    { name: '不寄送', provinces: ['新疆维吾尔自治区', '西藏自治区', '香港特别行政区', '澳门特别行政区', '台湾省'], freeShipMinFen: 0, tableFirstFen: 0, tableOverPerKgFen: 0, blocked: true },
  ],
  acceptGraceMin: 10,
  pickup: { cargoName: '食品', defaultRemark: '食品请勿重压', unacceptedRemindHours: 4, unpickedRemindMin: 60 },
  costAlertRatio: 1.2,
}

// ── sanitize 小工具（与 local-settings 同款语义：非法一律回落到 fallback）──
const asObj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})
// Number('') === 0、Number(null) === 0、Number(false) === 0、Number([]) === 0——
// 清空的表单字段/勾选框不能悄悄变成合法的 0，所以先把这些非数字、非数字字符串的输入挡在外面。
const isNumericInput = (v: unknown): v is number | string => (typeof v === 'number' || (typeof v === 'string' && v.trim() !== ''))
const int = (v: unknown, fb: number, min = 0, max = Number.MAX_SAFE_INTEGER) => {
  if (!isNumericInput(v)) return fb
  const n = Number(v)
  return Number.isInteger(n) && n >= min && n <= max ? n : fb
}
const num = (v: unknown, fb: number, min: number, max: number) => {
  if (!isNumericInput(v)) return fb
  const n = Number(v)
  return Number.isFinite(n) && n >= min && n <= max ? n : fb
}
const str = (v: unknown, fb: string, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : fb)
const bool = (v: unknown, fb: boolean) => (typeof v === 'boolean' ? v : fb)
const PROVINCE_SET = new Set<string>(PROVINCE_NAMES)
const COURIER_SET = new Set<string>(EXPRESS_COURIERS)

function sanitizeGroup(raw: unknown): RegionGroup | null {
  const g = asObj(raw)
  const name = str(g.name, '', 16)
  if (!name) return null
  const provinces = Array.isArray(g.provinces) ? g.provinces.filter((p): p is string => typeof p === 'string' && PROVINCE_SET.has(p)) : []
  return {
    name,
    provinces: [...new Set(provinces)],
    freeShipMinFen: int(g.freeShipMinFen, 0, 0, 10_000_000),
    tableFirstFen: int(g.tableFirstFen, 0, 0, 100_000),
    tableOverPerKgFen: int(g.tableOverPerKgFen, 0, 0, 100_000),
    blocked: bool(g.blocked, false),
  }
}

export function sanitizeExpressSettings(raw: unknown): ExpressSettings {
  const o = asObj(raw)
  const D = DEFAULT_EXPRESS_SETTINGS
  const w = asObj(o.weight), fee = asObj(o.fee), pk = asObj(o.pickup)
  const pool = Array.isArray(o.pricingPool) ? o.pricingPool.filter((c): c is string => typeof c === 'string' && COURIER_SET.has(c)) : D.pricingPool
  const groups = Array.isArray(o.regionGroups)
    ? o.regionGroups.map(sanitizeGroup).filter((g): g is RegionGroup => g !== null)
    : D.regionGroups.map((g) => ({ ...g, provinces: [...g.provinces] }))
  return {
    version: int(o.version, 0),
    weight: { packagingG: int(w.packagingG, D.weight.packagingG, 0, 20_000), defaultItemG: int(w.defaultItemG, D.weight.defaultItemG, 1, 20_000) },
    pricingPool: [...new Set(pool)],
    fee: {
      mode: fee.mode === 'TABLE' ? 'TABLE' : 'QUOTE',
      markupFen: int(fee.markupFen, D.fee.markupFen, 0, 100_000),
      roundToFen: int(fee.roundToFen, D.fee.roundToFen, 0, 1000),
      minQuoteCount: int(fee.minQuoteCount, D.fee.minQuoteCount, 1, 9),
    },
    minOrderAmountFen: int(o.minOrderAmountFen, D.minOrderAmountFen, 0, 10_000_000),
    regionGroups: groups,
    acceptGraceMin: int(o.acceptGraceMin, D.acceptGraceMin, 0, 30),
    pickup: {
      cargoName: str(pk.cargoName, D.pickup.cargoName, 16) || D.pickup.cargoName,
      defaultRemark: str(pk.defaultRemark, D.pickup.defaultRemark, 50),
      unacceptedRemindHours: int(pk.unacceptedRemindHours, D.pickup.unacceptedRemindHours, 1, 72),
      unpickedRemindMin: int(pk.unpickedRemindMin, D.pickup.unpickedRemindMin, 10, 1440),
    },
    costAlertRatio: num(o.costAlertRatio, D.costAlertRatio, 1, 5),
  }
}

/** 业务校验（sanitize 之后调用）。返回空数组 = 通过。 */
export function validateExpressSettings(s: ExpressSettings): string[] {
  const errs: string[] = []
  const other = s.regionGroups.find((g) => g.name === OTHER_GROUP)
  if (!other) errs.push(`必须保留名为「${OTHER_GROUP}」的分组（没归组的省份落到它）`)
  else if (other.blocked) errs.push(`「${OTHER_GROUP}」分组不能设为不寄送`)
  const names = new Set<string>()
  for (const g of s.regionGroups) {
    if (names.has(g.name)) errs.push(`分组名重复：${g.name}`)
    names.add(g.name)
  }
  const seen = new Map<string, string>()
  for (const g of s.regionGroups) for (const p of g.provinces) {
    if (seen.has(p)) errs.push(`省份 ${p} 同时属于「${seen.get(p)}」和「${g.name}」`)
    seen.set(p, g.name)
  }
  if (s.pricingPool.length < 2) errs.push('参与定价的快递至少勾选 2 家')
  if (s.fee.minQuoteCount > s.pricingPool.length) errs.push(`至少几家回价才用中位数（${s.fee.minQuoteCount}）不能超过参与定价的家数（${s.pricingPool.length}）`)
  return errs
}

/** 按省份全名找分组；没归组的落「其他」。 */
export function findRegionGroup(s: ExpressSettings, province: string): RegionGroup {
  const hit = s.regionGroups.find((g) => g.provinces.includes(province))
  if (hit) return hit
  const fallback = s.regionGroups.find((g) => g.name === OTHER_GROUP)
  if (fallback) return fallback
  // 畸形数据（「其他」组被误删）兜底到默认定义；拷贝一份，不能把模块级常量的引用递出去被调用方改。
  const def = DEFAULT_EXPRESS_SETTINGS.regionGroups.find((g) => g.name === OTHER_GROUP)!
  return { ...def, provinces: [...def.provinces] }
}

/**
 * 老接口 /orders/meta 与 GET /admin/settings/shipping 的兼容视图：取「其他」组。
 * 只是兼容视图（仅供过渡期只读展示用）——QUOTE 模式下 tableFirstFen 是报价失败时的兜底价，
 * 不是顾客实际会付的运费，不能拿这个数字去做计费或展示成「运费」。
 */
export function legacyShippingView(s: ExpressSettings): ShippingSettings {
  const def = DEFAULT_EXPRESS_SETTINGS.regionGroups.find((g) => g.name === OTHER_GROUP)!
  const other = s.regionGroups.find((g) => g.name === OTHER_GROUP) ?? { ...def, provinces: [...def.provinces] }
  return { fee: other.tableFirstFen, freeThreshold: other.freeShipMinFen, minOrderAmount: s.minOrderAmountFen }
}

/**
 * 老接口 PUT /admin/settings/shipping 的兼容写法：一口价 = 全部分组同一张兜底表 + 同一包邮线，且切到 TABLE。
 * 只给 e2e 与过渡期用；新后台页不调它。
 */
export function applyLegacyShipping(s: ExpressSettings, legacy: ShippingSettings): ExpressSettings {
  return {
    ...s,
    fee: { ...s.fee, mode: 'TABLE' },
    minOrderAmountFen: legacy.minOrderAmount,
    // blocked（不寄送）组不发货，包邮线对它没有意义，即便迁移一口价也不给它凭空加一条门槛——
    // 与 getExpressSettings 无行分支的迁移语义保持一致。
    regionGroups: s.regionGroups.map((g) => ({ ...g, tableFirstFen: legacy.fee, tableOverPerKgFen: 0, freeShipMinFen: g.blocked ? 0 : legacy.freeThreshold })),
  }
}

let cached: { value: ExpressSettings; at: number } | null = null

/**
 * 读取。settings 表没有 express_delivery 行时（首次上线），用默认值 + 把旧 shipping 的三个数
 * 迁进「其他」组（fee → tableFirstFen、freeThreshold → freeShipMinFen、minOrderAmount）。
 * 不自动落库——店主第一次在新页面点保存才写入新 key。
 */
export async function getExpressSettings(): Promise<ExpressSettings> {
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value
  let value: ExpressSettings
  try {
    const row = await prisma.setting.findUnique({ where: { key: EXPRESS_SETTINGS_KEY } })
    if (row) {
      value = sanitizeExpressSettings(JSON.parse(row.value))
    } else {
      const legacy = await getShippingSettings()
      const base = sanitizeExpressSettings(DEFAULT_EXPRESS_SETTINGS)
      // 首次读取时完全复刻旧一口价（含 0 = 免运费），店主在新页面切到 QUOTE 才开始按报价收——
      // 服务端可以先于小程序上线：mode 强制 TABLE，每个分组的兜底表都填成老的那一口价，
      // 不能让刚部署这一批代码的当晚，价格就悄悄从「旧一口价」跳成「按快递100报价中位数」。
      value = applyLegacyShipping(base, legacy)
    }
  } catch (e) {
    const message = (e as Error).message
    console.warn('[express-settings] 读取失败，回退默认值:', message)
    notifySystemAlert('邮寄设置读取失败', ['本单按默认邮寄设置计费（未写缓存，下一单重读）', message], {
      key: 'settings:express-fallback',
    })
    return sanitizeExpressSettings(DEFAULT_EXPRESS_SETTINGS)
  }
  cached = { value, at: Date.now() }
  return value
}

export async function setExpressSettings(next: ExpressSettings): Promise<ExpressSettings> {
  const current = await getExpressSettings()
  const value = sanitizeExpressSettings({ ...next, version: current.version + 1 })
  const errs = validateExpressSettings(value)
  if (errs.length) throw new AppError(40001, errs.join('；'))
  const json = JSON.stringify(value)
  await prisma.setting.upsert({ where: { key: EXPRESS_SETTINGS_KEY }, create: { key: EXPRESS_SETTINGS_KEY, value: json }, update: { value: json } })
  cached = { value, at: Date.now() }
  return value
}

/** 顶层字段级 patch（嵌套对象整体替换，与 local-settings 同约定） */
export async function patchExpressSettings(patch: Partial<ExpressSettings>): Promise<ExpressSettings> {
  const current = await getExpressSettings()
  return setExpressSettings({ ...current, ...patch })
}

export function clearExpressSettingsCache(): void {
  cached = null
}
