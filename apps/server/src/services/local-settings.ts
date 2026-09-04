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
/**
 * 报价凭证有效期。5 → 15 分钟：凭证里每一个「会变」的量（运费、配送范围、起送门槛）在下单时
 * 都用当前设置重新求值，唯一不能重算的是运力方给的道路距离——而同一对坐标之间的道路 15 分钟内
 * 不会变。把窗口开大只放宽「顾客在结算页磨蹭多久要重报一次价」，不放宽任何一条计费保护。
 */
const QUOTE_TTL_MS = 15 * 60 * 1000

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
    /**
     * 「一对一 / 指定单家运力」将来要用的槽（规格 §10）。v1 界面不暴露、服务端也不消费它——
     * 呼叫接口已经收 providers?: string[]，真要启用时把这个值传进去即可，接口与数据结构都不用动。
     * 之所以先把槽留在设置里：换运力是运营决策，不该每次都改代码。
     */
    soloProvider: string | null
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
    // district 必须写**正式行政区**「自流井区」而不是俗称「汇东新区」——它会原样作为
    // sendManDistrict 传给运力方（见 services/delivery/kd100.ts 的 _buildOrderParam）。
    province: '四川省', city: '自贡市', district: '自流井区', address: '丹桂街道丹桂40栋底楼',
    // 店主 2026-09-04 现场用微信「经纬度查询」小程序取得，腾讯与高德返回一致 = GCJ-02
    // （百度那组是 BD-09、谷歌/GPS 那组是 WGS-84，都不能直接用）。
    // 已用 batchPrice 交叉验证：正北 1998m 的点，四家运力返回 3057–3400m，坐标被正确解读。
    latE6: 29341126, lngE6: 104779018,
  },
  // 半径按**道路距离**判，不是直线（见 billableDistanceM 与 §配送报价）。
  // 5 km 而不是 7-8：5 km 骑手成本已 ¥14.5（实测），7-8 km 约 ¥20，
  // 对一单五六十块的凉菜吃不消；凉菜夏天也有食安顾虑，送太远不合适。
  radiusKm: 5,
  // ⚠ 1.35 是拍脑袋的初值，店主 2026-09-04 用免费 batchPrice 打了 8 个方向实测，证明它系统性低估：
  //   正北2km 1.67 / 正南2km 1.53 / 正东2km 1.88 / 正西2km 2.12
  //   东北3km 1.30 / 西南3km 1.54 / 正北5km 1.74 / 正东5km 1.58
  //   均值 1.67、中位 1.67、范围 1.30–2.12 —— 1.35 平均低估 19%，最差方向低估 36%。
  // 但**结论不是改成 1.67**：方向间差 63%（正西 2.12 vs 东北 1.30），自贡是山城又夹着釜溪河，
  // 任何固定系数在某些方向都必然错得离谱。正解是用 batchPrice 返回的真实道路距离算运费，
  // 这个系数只在查价失败时兜底——所以取 1.7 而不是 1.67：高估只是少赚，低估是每单倒贴。
  detourFactor: 1.7,
  // 店主 2026-09-04 按实测骑手成本定：2km ¥7.15–8.58 / 3km ¥7.98–9.19 / 5km ¥13.75–15.35。
  // 账（顾客付 / 骑手成本 / 店家担）：
  //   3km ¥40 单 → ¥6 / ¥8.5 / 担 ¥2.5
  //   5km ¥40 单 → ¥11 / ¥14.5 / 担 ¥3.5
  //   5km ¥99 单 → 免运费 / ¥14.5 / 担 ¥14.5
  // 每单补贴占订单 6-9%，毛利扛得住。免运门槛特意设在 ¥99——5 km 成本 ¥14.5，
  // 只有把客单价推上去才摊得平。先跑一个月看单量与距离分布再调。
  fee: { baseFee: 600, baseKm: 3, perKmFee: 250, freeThreshold: 9900, minOrderAmount: 4000 },
  businessHours: [{ start: '09:00', end: '20:00' }],
  prepMinutes: 15,
  riderSpeedKmh: 15,
  acceptGraceMin: 5,
  autoCallDelayMin: 0,
  // 日常主力是第三方骑手；店内自送是常规备选（高峰无人接单、近距离单自己走两步就到、
  // 余额用尽、骑手取消或改派失败），店员在看板上一键可切，不是降级兜底。
  defaultProvider: 'KD100',
  kd100: {
    providers: [...KD100_PROVIDERS], goodsType: '食品', defaultItemWeightG: 300,
    insurance: false, autoDowngradeToSelfOnNoBalance: false, soloProvider: null,
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
    defaultProvider: o.defaultProvider === 'SELF' ? 'SELF' : D.defaultProvider,
    kd100: {
      providers, goodsType: str(kd.goodsType, D.kd100.goodsType, 16),
      defaultItemWeightG: int(kd.defaultItemWeightG, D.kd100.defaultItemWeightG, 50, 20_000),
      insurance: bool(kd.insurance, false), autoDowngradeToSelfOnNoBalance: bool(kd.autoDowngradeToSelfOnNoBalance, false),
      // 只认已知运力编码，别的（含空串）一律归 null——留着的槽也不该能被写进垃圾值
      soloProvider: typeof kd.soloProvider === 'string' && (KD100_PROVIDERS as readonly string[]).includes(kd.soloProvider) ? kd.soloProvider : null,
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

/**
 * 仅供测试/脚本按需清缓存。**线上没有调用方，也不需要有**：`ecosystem.config.js` 是单进程 fork，
 * `setLocalSettings` 写库后立刻刷本进程的 `cached`，陈旧窗口实际为 0 而不是 CACHE_TTL_MS。
 * 保留它是为了将来真起多进程时有个现成的手柄，不代表现在存在一套「失效机制」。
 */
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

/**
 * **兜底**计费距离 = 直线 × 绕路系数；门店未设坐标返回 null（调用方按 42226 处理）。
 *
 * 正常路径已经不走这里了：`POST /local/quote` 调运力方 batchPrice 拿真实道路距离
 * （见 services/delivery/quote.ts 的 measureRoadDistanceM），下单再信任 token 里签过名的那个值。
 * 这个函数只在「查价超时/失败」与「下单时没有可信 token」两种情况下顶上——所以 detourFactor
 * 取的是偏高的 1.7 而不是实测均值 1.67：高估只是少赚，低估是每单倒贴。
 */
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
/**
 * ── 凭证里签什么、为什么恰好是这些 ──
 *
 * 核心不变量：**token 里唯一不可在下单时重算的量是 `distanceM`**。它是运力方按「门店坐标 → 收货
 * 坐标」算出来的真实道路距离，下单端点信任它而不再自己重算（见 routes/orders.ts 的「token 信任
 * 边界」注释）。它只依赖两对坐标，所以两对坐标都必须签进去、下单时逐字段比对：
 *
 *  - 收货坐标（la/ln）：不签就有一条真实的薅价路径——顾客先对近处报价拿 token，再
 *    `PUT /addresses/:id` 把坐标改到 30 km 外，然后拿旧 token 下单，距离/范围/运费全按近处算。
 *  - 门店坐标（sla/sln）：概念上就是 geoVersion。店主改门店坐标（搬家、一键定位纠偏）之后，
 *    旧 token 里那段距离量的是另一条路，必须整张作废。用「把坐标签进去比对」而不是加一个计数器
 *    字段，是因为前者由结构保证、后者要靠「有人记得 +1」，且与收货坐标的做法对称。
 *
 * 其余每一个设置字段（运费阶梯、半径、起送门槛、免运门槛……）在下单路径上都用**当前**设置重新
 * 求值，所以这里**不签 `settings.version`**：那条粗粒度作废是纯冗余，删掉不丢任何保护，却会让
 * 店主改一次营业时间就把正在结算页的顾客全踢下来。
 *
 * 于是这个结构本身就是规格：**签进去的每一个字段都会在下单时被比对**，一个都不多。
 */
interface QuotePayload {
  fee: number; distanceM: number; addressId: number
  latE6: number; lngE6: number
  storeLatE6: number; storeLngE6: number
}
const b64u = (s: string) => Buffer.from(s, 'utf8').toString('base64url')
const hmac = (s: string) => crypto.createHmac('sha256', `quote:${config.jwt.userSecret}`).update(s).digest('hex').slice(0, 32)

export function signQuote(p: QuotePayload, now: Date = new Date()): string {
  const body = b64u(JSON.stringify({
    f: p.fee, d: p.distanceM, a: p.addressId,
    la: p.latE6, ln: p.lngE6, sla: p.storeLatE6, sln: p.storeLngE6,
    e: now.getTime() + QUOTE_TTL_MS,
  }))
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
    // 坐标四项（la/ln 收货、sla/sln 门店）都是后加的字段：老格式 token 缺其中任何一个一律判无效，
    // 而不是当成 0——0 会与「点在赤道本初子午线」这种理论坐标相等，等于让老 token 永久绕过坐标比对。
    // 缺字段判无效在下单侧就是 42239（没有可信凭证），顾客重报一次价即可，不存在兼容包袱。
    const fields = [o.f, o.d, o.a, o.la, o.ln, o.sla, o.sln]
    if (fields.some((n) => typeof n !== 'number' || !Number.isFinite(n))) return null
    return {
      fee: o.f, distanceM: o.d, addressId: o.a,
      latE6: o.la, lngE6: o.ln, storeLatE6: o.sla, storeLngE6: o.sln,
    }
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
