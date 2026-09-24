/**
 * 库存预警门槛设置（settings 表 key='low_stock'）。
 * `lowThreshold`：0 < stock ≤ lowThreshold 视为「紧张」；stock ≤ 0 视为「售罄」。
 * `pushBelow`：即时推送门槛，`1 ≤ pushBelow ≤ lowThreshold`（越界回落/夹到 lowThreshold）。
 *
 * 缓存策略照 printer-settings.ts：60 秒进程内缓存，保存即失效；读失败不写 cached，
 * 下一次调用重新尝试读库（不把兜底默认值也缓存住）。
 */
import prisma from '../utils/prisma'

export const LOW_STOCK_SETTINGS_KEY = 'low_stock'
const CACHE_TTL_MS = 60 * 1000

export interface LowStockSettings {
  lowThreshold: number
  pushBelow: number
}

export const DEFAULT_LOW_STOCK_SETTINGS: LowStockSettings = { lowThreshold: 3, pushBelow: 2 }

const asObj = (v: unknown) => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {})
const intInRange = (v: unknown, fb: number, min = 1, max = 999) => {
  const n = Number(v)
  return Number.isInteger(n) && n >= min && n <= max ? n : fb
}

/** 读库/解析用：结构不合法或越界一律回落默认值，`pushBelow > lowThreshold` 夹到 `lowThreshold`。 */
export function sanitizeLowStockSettings(raw: unknown): LowStockSettings {
  const o = asObj(raw)
  const D = DEFAULT_LOW_STOCK_SETTINGS
  const lowThreshold = intInRange(o.lowThreshold, D.lowThreshold, 1, 999)
  let pushBelow = intInRange(o.pushBelow, D.pushBelow, 1, 999)
  if (pushBelow > lowThreshold) pushBelow = lowThreshold
  return { lowThreshold, pushBelow }
}

/**
 * 保存时校验（PUT 用）：给用户看得懂的中文错误，而不是静默夹到默认值。
 * 非整数/越界各一条；两者都合法时才检查 `pushBelow > lowThreshold`。
 */
export function validateLowStockSettings(raw: unknown): string[] {
  const errs: string[] = []
  const o = asObj(raw)
  const lowThreshold = Number(o.lowThreshold)
  const pushBelow = Number(o.pushBelow)
  const lowOk = Number.isInteger(lowThreshold) && lowThreshold >= 1 && lowThreshold <= 999
  const pushOk = Number.isInteger(pushBelow) && pushBelow >= 1 && pushBelow <= 999
  if (!lowOk) errs.push('紧张门槛须为 1–999 的整数')
  if (!pushOk) errs.push('即时推送门槛须为 1–999 的整数')
  if (lowOk && pushOk && pushBelow > lowThreshold) errs.push('即时推送门槛不能大于紧张门槛')
  return errs
}

let cached: { value: LowStockSettings; at: number } | null = null

export async function getLowStockSettings(): Promise<LowStockSettings> {
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value
  let value = DEFAULT_LOW_STOCK_SETTINGS
  try {
    const row = await prisma.setting.findUnique({ where: { key: LOW_STOCK_SETTINGS_KEY } })
    if (row) value = sanitizeLowStockSettings(JSON.parse(row.value))
  } catch (e) {
    console.warn('[low-stock-settings] 读取失败，回退默认值:', (e as Error).message)
  }
  cached = { value, at: Date.now() }
  return value
}

export async function setLowStockSettings(next: LowStockSettings): Promise<LowStockSettings> {
  const value = sanitizeLowStockSettings(next)
  const json = JSON.stringify(value)
  await prisma.setting.upsert({
    where: { key: LOW_STOCK_SETTINGS_KEY },
    create: { key: LOW_STOCK_SETTINGS_KEY, value: json },
    update: { value: json },
  })
  cached = { value, at: Date.now() }
  return value
}

/** 测试/脚本按需清缓存 */
export function clearLowStockSettingsCache(): void {
  cached = null
}
