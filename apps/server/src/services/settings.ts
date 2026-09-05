/**
 * 店铺设置：settings 表的读写 + 进程内缓存。
 *
 * 下单是热路径，每单都查一次配置不值当；配置又极少改动，
 * 所以读一次缓存 60 秒，后台保存时立即失效。多实例部署下最坏
 * 情况是别的实例晚 60 秒生效——运费改动不需要秒级一致。
 */

import prisma from '../utils/prisma'
import { notifySystemAlert } from './notify'

/** 运费规则。金额单位一律「分」，与订单表保持一致，避免浮点误差。 */
export interface ShippingSettings {
  /** 运费（分）。0 = 不收运费 */
  fee: number
  /** 满额包邮门槛（分），按**商品小计**判断。0 = 不设包邮门槛 */
  freeThreshold: number
  /** 起送金额（分），按**商品小计**判断。0 = 无门槛 */
  minOrderAmount: number
}

export const DEFAULT_SHIPPING: ShippingSettings = {
  fee: 0,
  freeThreshold: 0,
  minOrderAmount: 0,
}

const SHIPPING_KEY = 'shipping'
const CACHE_TTL_MS = 60 * 1000

let cached: { value: ShippingSettings; at: number } | null = null

function sanitize(raw: unknown): ShippingSettings {
  const o = (raw ?? {}) as Record<string, unknown>
  const int = (v: unknown, fallback: number) => {
    const n = Number(v)
    return Number.isInteger(n) && n >= 0 ? n : fallback
  }
  return {
    fee: int(o.fee, DEFAULT_SHIPPING.fee),
    freeThreshold: int(o.freeThreshold, DEFAULT_SHIPPING.freeThreshold),
    minOrderAmount: int(o.minOrderAmount, DEFAULT_SHIPPING.minOrderAmount),
  }
}

export async function getShippingSettings(): Promise<ShippingSettings> {
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value
  let value = DEFAULT_SHIPPING
  try {
    const row = await prisma.setting.findUnique({ where: { key: SHIPPING_KEY } })
    if (row) value = sanitize(JSON.parse(row.value))
  } catch (e) {
    // 配置读不出来时用默认值（全 0 = 全包邮无门槛），
    // 宁可少收运费也不能让顾客下不了单。
    // 但兜底值只给这一单用，不进缓存：一次 DB 抖动不能让之后 60 秒的每一单都免运费、绕过起送门槛，
    // 下一单就该重新去读真值。同时告警，让人知道这段时间有单是按全 0 收的。
    console.warn('[settings] 读取运费配置失败，回退默认值:', (e as Error).message)
    notifySystemAlert('运费配置读取失败', ['本单按免运费、无起送门槛处理（未写缓存，下一单重读）', (e as Error).message], {
      key: 'settings:shipping-fallback',
    })
    return value
  }
  cached = { value, at: Date.now() }
  return value
}

export async function setShippingSettings(next: ShippingSettings): Promise<ShippingSettings> {
  const value = sanitize(next)
  const json = JSON.stringify(value)
  await prisma.setting.upsert({
    where: { key: SHIPPING_KEY },
    create: { key: SHIPPING_KEY, value: json },
    update: { value: json },
  })
  cached = { value, at: Date.now() }
  return value
}

/** 测试与后台保存后手动失效用 */
export function clearSettingsCache(): void {
  cached = null
}

/**
 * 按商品小计算运费。
 * 口径固定为「商品小计」而非含运费总价——后者会自我循环
 * （加了运费才够包邮门槛，包邮后又不够了）。
 */
export function calcShippingFee(itemsSubtotal: number, s: ShippingSettings): number {
  if (s.fee <= 0) return 0
  if (s.freeThreshold > 0 && itemsSubtotal >= s.freeThreshold) return 0
  return s.fee
}
