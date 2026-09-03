/**
 * 同城配送运营参数（settings 表 key=local_delivery）+ 全部纯计算。
 *
 * 这里是运费/范围/营业判定的唯一实现：小程序只展示 /local/quote 的结果，不再本地复刻算法
 * （邮寄运费两端各写一遍的教训见 pages/order/confirm.js 注释）。
 * 缓存策略与 services/settings.ts 一致：60 秒进程内缓存，保存即失效。
 */
import crypto from 'crypto'
import prisma from '../utils/prisma'
import { config } from '../config'

export const LOCAL_SETTINGS_KEY = 'local_delivery'
const CACHE_TTL_MS = 60 * 1000
const QUOTE_TTL_MS = 5 * 60 * 1000

export interface BusinessHour { start: string; end: string }

export interface LocalDeliverySettings {
  version: number
  enabled: boolean
  paused: { until: string | null; reason: string } | null
  store: {
    name: string; phone: string
    province: string; city: string; district: string; address: string
    latE6: number | null; lngE6: number | null
  }
  radiusKm: number
  detourFactor: number
  fee: { baseFee: number; baseKm: number; perKmFee: number; freeThreshold: number; minOrderAmount: number }
  businessHours: BusinessHour[]
  prepMinutes: number
  riderSpeedKmh: number
  acceptGraceMin: number
  autoCallDelayMin: number
  defaultProvider: 'KD100' | 'SELF'
  kd100: {
    providers: string[]; goodsType: string; defaultItemWeightG: number
    insurance: boolean; autoDowngradeToSelfOnNoBalance: boolean
  }
  limits: { maxItems: number; maxWeightKg: number }
  callTimeoutMin: number
  acceptedStuckMin: number
  deliveringTimeoutMin: number
  tip: { maxPerCall: number; maxPerOrder: number }
}

export const KD100_PROVIDERS = [
  'shunfengtongcheng', 'fengniaotongcheng', 'meituantongcheng', 'shansongtongcheng',
  'dadatongcheng', 'uupaotui', 'gxdtongcheng',
] as const

export const DEFAULT_LOCAL_SETTINGS: LocalDeliverySettings = {
  version: 0,
  enabled: false,
  paused: null,
  store: {
    name: '阿福凉菜', phone: '15309003232',
    province: '四川省', city: '自贡市', district: '高新区', address: '汇东新区丹桂40栋底楼',
    latE6: null, lngE6: null,
  },
  radiusKm: 5,
  detourFactor: 1.35,
  fee: { baseFee: 300, baseKm: 3, perKmFee: 100, freeThreshold: 0, minOrderAmount: 0 },
  businessHours: [{ start: '09:00', end: '20:00' }],
  prepMinutes: 15,
  riderSpeedKmh: 15,
  acceptGraceMin: 5,
  autoCallDelayMin: 0,
  defaultProvider: 'SELF',
  kd100: {
    providers: [...KD100_PROVIDERS], goodsType: '食品', defaultItemWeightG: 300,
    insurance: false, autoDowngradeToSelfOnNoBalance: false,
  },
  limits: { maxItems: 30, maxWeightKg: 10 },
  callTimeoutMin: 10,
  acceptedStuckMin: 30,
  deliveringTimeoutMin: 120,
  tip: { maxPerCall: 2000, maxPerOrder: 5000 },
}

// ── sanitize ────────────────────────────────────────────────
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/
const asObj = (v: unknown) => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {})
const int = (v: unknown, fb: number, min = 0, max = Number.MAX_SAFE_INTEGER) => {
  const n = Number(v)
  return Number.isInteger(n) && n >= min && n <= max ? n : fb
}
const num = (v: unknown, fb: number, min = 0, max = 1e9) => {
  const n = Number(v)
  return Number.isFinite(n) && n >= min && n <= max ? n : fb
}
const bool = (v: unknown, fb: boolean) => (typeof v === 'boolean' ? v : fb)
const str = (v: unknown, fb: string, max = 128) => (typeof v === 'string' ? v.trim().slice(0, max) : fb)
const intOrNull = (v: unknown, min: number, max: number) => {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isInteger(n) && n >= min && n <= max ? n : null
}

export function sanitizeLocalSettings(raw: unknown): LocalDeliverySettings {
  const o = asObj(raw)
  const D = DEFAULT_LOCAL_SETTINGS
  const store = asObj(o.store), fee = asObj(o.fee), kd = asObj(o.kd100), lim = asObj(o.limits), tip = asObj(o.tip)
  const paused = o.paused && typeof o.paused === 'object'
    ? { until: str(asObj(o.paused).until, '', 40) || null, reason: str(asObj(o.paused).reason, '', 60) }
    : null
  const hours = Array.isArray(o.businessHours)
    ? o.businessHours
        .map((h) => ({ start: str(asObj(h).start, '', 5), end: str(asObj(h).end, '', 5) }))
        .filter((h) => HHMM.test(h.start) && HHMM.test(h.end))
    : D.businessHours
  const providers = Array.isArray(kd.providers)
    ? kd.providers.filter((p): p is string => typeof p === 'string' && (KD100_PROVIDERS as readonly string[]).includes(p))
    : D.kd100.providers
  return {
    version: int(o.version, 0),
    enabled: bool(o.enabled, false),
    paused,
    store: {
      name: str(store.name, D.store.name, 64), phone: str(store.phone, D.store.phone, 20),
      province: str(store.province, D.store.province, 32), city: str(store.city, D.store.city, 32),
      district: str(store.district, D.store.district, 32), address: str(store.address, D.store.address, 255),
      latE6: intOrNull(store.latE6, -90_000_000, 90_000_000), lngE6: intOrNull(store.lngE6, -180_000_000, 180_000_000),
    },
    radiusKm: num(o.radiusKm, D.radiusKm, 0.5, 50),
    detourFactor: num(o.detourFactor, D.detourFactor, 1, 3),
    fee: {
      baseFee: int(fee.baseFee, D.fee.baseFee, 0, 100_000), baseKm: num(fee.baseKm, D.fee.baseKm, 0, 50),
      perKmFee: int(fee.perKmFee, D.fee.perKmFee, 0, 100_000),
      freeThreshold: int(fee.freeThreshold, D.fee.freeThreshold, 0, 10_000_000),
      minOrderAmount: int(fee.minOrderAmount, D.fee.minOrderAmount, 0, 10_000_000),
    },
    businessHours: hours,
    prepMinutes: int(o.prepMinutes, D.prepMinutes, 0, 180),
    riderSpeedKmh: num(o.riderSpeedKmh, D.riderSpeedKmh, 5, 60),
    acceptGraceMin: int(o.acceptGraceMin, D.acceptGraceMin, 0, 30),
    autoCallDelayMin: int(o.autoCallDelayMin, D.autoCallDelayMin, 0, 60),
    defaultProvider: o.defaultProvider === 'KD100' ? 'KD100' : 'SELF',
    kd100: {
      providers, goodsType: str(kd.goodsType, D.kd100.goodsType, 16),
      defaultItemWeightG: int(kd.defaultItemWeightG, D.kd100.defaultItemWeightG, 50, 20_000),
      insurance: bool(kd.insurance, false), autoDowngradeToSelfOnNoBalance: bool(kd.autoDowngradeToSelfOnNoBalance, false),
    },
    limits: { maxItems: int(lim.maxItems, D.limits.maxItems, 1, 500), maxWeightKg: num(lim.maxWeightKg, D.limits.maxWeightKg, 0.5, 100) },
    callTimeoutMin: int(o.callTimeoutMin, D.callTimeoutMin, 1, 120),
    acceptedStuckMin: int(o.acceptedStuckMin, D.acceptedStuckMin, 1, 240),
    deliveringTimeoutMin: int(o.deliveringTimeoutMin, D.deliveringTimeoutMin, 10, 600),
    tip: { maxPerCall: int(tip.maxPerCall, D.tip.maxPerCall, 0, 100_000), maxPerOrder: int(tip.maxPerOrder, D.tip.maxPerOrder, 0, 500_000) },
  }
}

// ── 校验 ────────────────────────────────────────────────────
const toMin = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5))

/** 保存时校验（结构合法但业务上不允许的组合） */
export function validateLocalSettings(s: LocalDeliverySettings): string[] {
  const errs: string[] = []
  const sorted = [...s.businessHours].sort((a, b) => toMin(a.start) - toMin(b.start))
  for (const h of sorted) {
    if (toMin(h.start) >= toMin(h.end)) errs.push(`营业时段 ${h.start}-${h.end}：结束须晚于开始（首期不支持跨零点）`)
  }
  for (let i = 1; i < sorted.length; i++) {
    if (toMin(sorted[i].start) < toMin(sorted[i - 1].end)) errs.push(`营业时段 ${sorted[i - 1].start}-${sorted[i - 1].end} 与 ${sorted[i].start}-${sorted[i].end} 重叠`)
  }
  if (s.autoCallDelayMin !== 0 && (s.autoCallDelayMin < s.acceptGraceMin || s.autoCallDelayMin > 15)) {
    errs.push(`自动呼叫延迟须为 0（手动）或介于顾客可取消窗口 ${s.acceptGraceMin} 分钟与 15 分钟之间`)
  }
  if (s.tip.maxPerCall > s.tip.maxPerOrder) errs.push('单次小费上限不能大于单笔订单累计上限')
  return errs
}

/**
 * 针对**原始请求体**的校验，必须在 sanitize 之前跑。
 *
 * sanitize 对营业时段的策略是「逐条丢掉不合法的项」，而管理端那一栏是自由文本
 * （每行 `HH:mm-HH:mm`）。于是店主把 `09:00` 打成中文冒号 `09：00` 或少写一位 `9:00`，
 * 这一行会被**静默丢掉**、接口照样返回 code:0、页面提示「已保存」。若他有两段营业时间
 * 只错了一段，`validateForEnable` 的「至少一个时段」也拦不住——结果是营业时段被悄悄收窄，
 * 非营业时段的同城单直接被 42222 拒单，而店主完全不知道为什么。
 *
 * sanitize 之后的对象已经看不出「丢了几条」，所以这个比对只能在这里做。
 */
export function validateRawLocalSettings(raw: unknown): string[] {
  const o = asObj(raw)
  const errs: string[] = []
  if (Array.isArray(o.businessHours)) {
    o.businessHours.forEach((h, i) => {
      const item = asObj(h)
      const start = typeof item.start === 'string' ? item.start.trim() : ''
      const end = typeof item.end === 'string' ? item.end.trim() : ''
      if (!HHMM.test(start) || !HHMM.test(end)) {
        errs.push(
          `营业时段第 ${i + 1} 行「${start || '(空)'}-${end || '(空)'}」格式不正确，应形如 09:00-20:00（半角冒号、小时两位）`
        )
      }
    })
  }
  return errs
}

/** 开启总开关前的完整性校验 */
export function validateForEnable(s: LocalDeliverySettings): string[] {
  const errs = validateLocalSettings(s)
  if (s.store.latE6 === null || s.store.lngE6 === null) errs.push('请先设置门店坐标（推荐在小程序商家端一键定位）')
  if (!s.store.phone) errs.push('请填写门店电话')
  if (!s.store.address) errs.push('请填写门店地址')
  if (s.businessHours.length === 0) errs.push('至少设置一个营业时段')
  if (s.radiusKm <= 0) errs.push('配送半径须大于 0')
  return errs
}

// ── 读写 + 缓存 ─────────────────────────────────────────────
let cached: { value: LocalDeliverySettings; at: number } | null = null

export async function getLocalSettings(): Promise<LocalDeliverySettings> {
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value
  let value = DEFAULT_LOCAL_SETTINGS
  try {
    const row = await prisma.setting.findUnique({ where: { key: LOCAL_SETTINGS_KEY } })
    if (row) value = sanitizeLocalSettings(JSON.parse(row.value))
  } catch (e) {
    // 读不到配置 = 默认值（enabled=false），同城入口关闭而不是放行错误运费
    console.warn('[local-settings] 读取失败，回退默认值:', (e as Error).message)
  }
  cached = { value, at: Date.now() }
  return value
}

export async function setLocalSettings(next: LocalDeliverySettings): Promise<LocalDeliverySettings> {
  const current = await getLocalSettings()
  const value = sanitizeLocalSettings({ ...next, version: current.version + 1 })
  const json = JSON.stringify(value)
  await prisma.setting.upsert({
    where: { key: LOCAL_SETTINGS_KEY },
    create: { key: LOCAL_SETTINGS_KEY, value: json },
    update: { value: json },
  })
  cached = { value, at: Date.now() }
  return value
}

// 这里的「patch」只对顶层字段生效：patch.fee/kd100/limits/tip 等嵌套对象一旦传入就会整体替换当前值，
// 不会跟 current 做字段级合并。这不是漏洞——Partial<LocalDeliverySettings> 只把顶层字段变成可选，
// 嵌套对象本身仍是完整类型，`npx tsc --noEmit` 会在编译期拒绝任何只传嵌套对象部分字段的调用
// （例如 patchLocalSettings({ fee: { minOrderAmount: 3000 } }) 会报 TS2739 缺 baseFee/baseKm/perKmFee/freeThreshold）。
// 所以调用方要改嵌套对象里的某一个字段时，正确写法是先 getLocalSettings() 取当前值、展开后再覆盖那个字段
// （Task 5 的门店坐标接口就是这么写的）。下面 store 这一处的展开合并是冗余的防御代码——类型系统已经保证
// 不会有调用方能绕过完整嵌套对象的要求触发它——保留不动只是为了不改动已通过复查的运行时行为。
export async function patchLocalSettings(patch: Partial<LocalDeliverySettings>): Promise<LocalDeliverySettings> {
  const current = await getLocalSettings()
  return setLocalSettings({ ...current, ...patch, store: { ...current.store, ...(patch.store ?? {}) } })
}

export function clearLocalSettingsCache(): void {
  cached = null
}

// ── 营业判定（Asia/Shanghai，不依赖进程时区）────────────────
const SH_FMT = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false })

export function shanghaiMinutes(now: Date = new Date()): number {
  const parts = SH_FMT.formatToParts(now)
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? 0) % 24
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? 0)
  return h * 60 + m
}

export function isPaused(s: LocalDeliverySettings, now: Date = new Date()): boolean {
  if (!s.paused) return false
  if (!s.paused.until) return true
  const until = Date.parse(s.paused.until)
  return Number.isFinite(until) ? until > now.getTime() : true
}

function inHours(s: LocalDeliverySettings, now: Date): boolean {
  const cur = shanghaiMinutes(now)
  return s.businessHours.some((h) => cur >= toMin(h.start) && cur < toMin(h.end))
}

export function isOpenNow(s: LocalDeliverySettings, now: Date = new Date()): boolean {
  return s.enabled && !isPaused(s, now) && inHours(s, now)
}

export function nextOpenText(s: LocalDeliverySettings, now: Date = new Date()): string {
  if (s.businessHours.length === 0) return '暂未设置营业时间'
  const cur = shanghaiMinutes(now)
  const sorted = [...s.businessHours].sort((a, b) => toMin(a.start) - toMin(b.start))
  const today = sorted.find((h) => toMin(h.start) > cur)
  return today ? `今天 ${today.start} 营业` : `明天 ${sorted[0].start} 营业`
}

// ── 距离与运费 ───────────────────────────────────────────────
const R_EARTH_M = 6371008.8
export function haversineM(aLatE6: number, aLngE6: number, bLatE6: number, bLngE6: number): number {
  const toRad = (e6: number) => (e6 / 1e6) * (Math.PI / 180)
  const dLat = toRad(bLatE6 - aLatE6), dLng = toRad(bLngE6 - aLngE6)
  const la1 = toRad(aLatE6), la2 = toRad(bLatE6)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2
  return Math.round(2 * R_EARTH_M * Math.asin(Math.min(1, Math.sqrt(h))))
}

/** 计费距离 = 直线 × 绕路系数；门店未设坐标返回 null（调用方按 42226 处理） */
export function billableDistanceM(s: LocalDeliverySettings, latE6: number, lngE6: number): number | null {
  if (s.store.latE6 === null || s.store.lngE6 === null) return null
  return Math.round(haversineM(s.store.latE6, s.store.lngE6, latE6, lngE6) * s.detourFactor)
}

export function calcLocalFee(
  s: LocalDeliverySettings,
  distanceM: number,
  subtotal: number
): { fee: number; inRange: boolean; belowMin: boolean } {
  const inRange = distanceM <= Math.round(s.radiusKm * 1000)
  const belowMin = s.fee.minOrderAmount > 0 && subtotal < s.fee.minOrderAmount
  const km = distanceM / 1000
  let fee = s.fee.baseFee + Math.max(0, Math.ceil(km - s.fee.baseKm)) * s.fee.perKmFee
  if (s.fee.freeThreshold > 0 && subtotal >= s.fee.freeThreshold) fee = 0
  return { fee, inRange, belowMin }
}

export function estimateMinutes(s: LocalDeliverySettings, distanceM: number): number {
  return Math.round(s.prepMinutes + (distanceM / 1000 / s.riderSpeedKmh) * 60)
}

// ── 报价签名（防 quote 与下单之间金额漂移）───────────────────
interface QuotePayload { fee: number; distanceM: number; addressId: number; version: number }
const b64u = (s: string) => Buffer.from(s, 'utf8').toString('base64url')
const hmac = (s: string) => crypto.createHmac('sha256', `quote:${config.jwt.userSecret}`).update(s).digest('hex').slice(0, 32)

export function signQuote(p: QuotePayload, now: Date = new Date()): string {
  const body = b64u(JSON.stringify({ f: p.fee, d: p.distanceM, a: p.addressId, v: p.version, e: now.getTime() + QUOTE_TTL_MS }))
  return `${body}.${hmac(body)}`
}

export function verifyQuote(token: string, now: Date = new Date()): QuotePayload | null {
  const [body, sig] = token.split('.')
  // sig 恒为 32 位小写 hex：用字符集校验而非 sig.length===32（字符数），
  // 否则多字节字符（如中文）字符数也可能凑到 32，但 Buffer.byteLength 会远大于 32，
  // 传给 timingSafeEqual 两个长度不等的 Buffer 会直接抛 RangeError，
  // 冒泡到全局错误处理会当作 500 触发店主告警（构造 token 即可远程刷告警）。
  if (!body || !sig || !/^[0-9a-f]{32}$/.test(sig)) return null
  const expect = hmac(body)
  try {
    if (!crypto.timingSafeEqual(Buffer.from(expect), Buffer.from(sig))) return null
  } catch {
    // 防御未来改动导致长度校验被绕过：timingSafeEqual 抛异常时按校验失败处理，不冒泡成 500
    return null
  }
  try {
    const o = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
    if (typeof o.e !== 'number' || o.e < now.getTime()) return null
    return { fee: Number(o.f), distanceM: Number(o.d), addressId: Number(o.a), version: Number(o.v) }
  } catch {
    return null
  }
}

/** /local/meta 下发的公开子集（不含小费上限、运力配置等运营参数） */
export function publicLocalMeta(s: LocalDeliverySettings, now: Date = new Date()) {
  return {
    enabled: s.enabled,
    isOpen: isOpenNow(s, now),
    paused: isPaused(s, now) ? { reason: s.paused?.reason ?? '', until: s.paused?.until ?? null } : null,
    nextOpenText: nextOpenText(s, now),
    businessHours: s.businessHours,
    store: {
      name: s.store.name, phone: s.store.phone, province: s.store.province, city: s.store.city,
      district: s.store.district, address: s.store.address, latE6: s.store.latE6, lngE6: s.store.lngE6,
    },
    radiusKm: s.radiusKm,
    radiusStraightKm: Math.round((s.radiusKm / s.detourFactor) * 10) / 10,
    fee: s.fee,
    prepMinutes: s.prepMinutes,
    acceptGraceMin: s.acceptGraceMin,
    limits: s.limits,
  }
}
