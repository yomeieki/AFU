/**
 * 库存预警（2026-09-24）：按「库存单位」（有规格商品的每个规格；无规格商品就是商品本身）判定
 * 紧张/售罄，去重后即时推送 + 每日汇总。取代旧的 scheduler.ts:pushLowStock（商品总库存 ≤5、
 * 12 小时最多一次）。
 *
 * 去重状态：Setting(key='low_stock_alert_state')，结构照 services/member/cron-state.ts
 * 的 key/value JSON 写法。
 *
 * R1-3（2026-09-24 修订 1）：扫描时查**所有未删商品**（不限 status），带 onShelf 标记——
 * 这样下架不再清空该规格已推的状态，只有补货到 ≥pushBelow 才重置；商品被软删/规格被删时
 * 才真正丢弃状态（listStockUnits 的查询范围本身就把它们裁掉了）。
 * 页面/角标/pending-count 口径不变：只统计 `onShelf` 的单位。
 */
import prisma from '../utils/prisma'
import { getLowStockSettings, type LowStockSettings } from './low-stock-settings'
import { notifyLowStockChange, notifyLowStockDaily } from './order-notify'
import { isHolidayNow, shanghaiDateStr, getLocalSettings, type LocalDeliverySettings, type BusinessHour } from './local-settings'

export type Channel = 'EXPRESS' | 'LOCAL'
export type AlertLevel = 'OUT' | 'LOW'
export type StockLevel = 'OUT' | 'LOW' | 'OK'

const CHANNEL_LABEL: Record<Channel, string> = { LOCAL: '同城', EXPRESS: '邮寄' }

/** 一个「库存单位」：sku:<id> 或 product:<id>（无规格商品） */
export interface StockUnit {
  key: string
  productId: number
  productName: string
  channel: Channel
  coverImage: string | null
  skuId: number | null
  specText: string | null
  stock: number
  /** status === 'ON_SHELF' */
  onShelf: boolean
  sortOrder: number
}

export interface AlertState {
  levels: Record<string, AlertLevel>
  dailySentOn: string | null
}

export interface StockUnitView {
  key: string
  skuId: number | null
  specText: string | null
  stock: number
  level: AlertLevel
}

export interface LowStockGroup {
  productId: number
  productName: string
  channel: Channel
  coverImage: string | null
  hasSkus: boolean
  out: number
  low: number
  units: StockUnitView[]
}

export interface LowStockOverview {
  settings: LowStockSettings
  counts: {
    total: number
    out: number
    low: number
    byChannel: Record<Channel, { out: number; low: number }>
  }
  groups: LowStockGroup[]
}

// ── 纯函数：档位判定 ────────────────────────────────────────
export function classifyStock(stock: number, s: LowStockSettings): StockLevel {
  if (stock <= 0) return 'OUT'
  if (stock <= s.lowThreshold) return 'LOW'
  return 'OK'
}

/** 即时推送档位：`stock ≤ 0` → 'OUT'；`0 < stock < pushBelow` → 'LOW'；否则不推 */
export function pushLevelOf(stock: number, s: LowStockSettings): AlertLevel | null {
  if (stock <= 0) return 'OUT'
  if (stock < s.pushBelow) return 'LOW'
  return null
}

function sameLevels(a: Record<string, AlertLevel>, b: Record<string, AlertLevel>): boolean {
  const ak = Object.keys(a)
  const bk = Object.keys(b)
  if (ak.length !== bk.length) return false
  return ak.every((k) => a[k] === b[k])
}

/**
 * 去重转移（R1-3 的核心规则，见方案 §0.3 + 修订 1）：
 *  1. `stock ≥ pushBelow` → 删状态（唯一的重置条件，不看在架与否）；
 *  2. `!onShelf` 且 `stock < pushBelow` → 不推、状态原样保留（有就留着，没有也不新建）；
 *  3. `onShelf` 且 `stock < pushBelow`：OUT/LOW 按「当前档位 vs 已记档位」转移——
 *     newLevel=OUT 且 prev≠OUT → 推 OUT；newLevel=LOW 且 prev 无 → 推 LOW；
 *     其余（已是同档、或从 OUT 回落到 LOW）不推，状态保持「已记的那个」不降级；
 *  4. `prev` 里有、`units` 里已经没有的 key（sku 被删、商品软删）→ 自然不出现在 nextLevels，
 *     即被丢弃（不需要单独判断——本函数只从 `units` 构建 `nextLevels`）。
 */
export function diffAlertTransitions(
  prev: AlertState,
  units: StockUnit[],
  s: LowStockSettings
): { pushes: { unit: StockUnit; level: AlertLevel }[]; nextLevels: Record<string, AlertLevel>; changed: boolean } {
  const pushes: { unit: StockUnit; level: AlertLevel }[] = []
  const nextLevels: Record<string, AlertLevel> = {}

  for (const unit of units) {
    const prevLevel = prev.levels[unit.key]

    if (unit.stock >= s.pushBelow) {
      // 重置：不写入 nextLevels = 删除状态
      continue
    }

    if (!unit.onShelf) {
      // 不在架且未达重置线：状态原样保留
      if (prevLevel) nextLevels[unit.key] = prevLevel
      continue
    }

    // 在架且 stock < pushBelow：newLevel 必为 OUT 或 LOW
    const newLevel: AlertLevel = unit.stock <= 0 ? 'OUT' : 'LOW'
    if (newLevel === 'OUT') {
      nextLevels[unit.key] = 'OUT'
      if (prevLevel !== 'OUT') pushes.push({ unit, level: 'OUT' })
    } else if (!prevLevel) {
      nextLevels[unit.key] = 'LOW'
      pushes.push({ unit, level: 'LOW' })
    } else {
      // 已是 LOW 或 OUT：不推，状态保持不变（0→1 这种回升不算补货，不把 OUT 降级成 LOW）
      nextLevels[unit.key] = prevLevel
    }
  }

  return { pushes, nextLevels, changed: !sameLevels(prev.levels, nextLevels) }
}

const toMin = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5))

/**
 * 每日汇总的「应发时刻」：当天营业时段里最早的 start，减 30 分钟。
 * `due = new Date(now)` 只借用 now 的年月日，再用 `setHours(0, dueMin, 0, 0)` 直接把分钟数
 * （可能为负）设进去——Date 会自动借位到前一天，跨零点减法不用手写分支。
 */
export function dailySummaryDueAt(businessHours: BusinessHour[], now: Date = new Date()): Date | null {
  if (businessHours.length === 0) return null
  const earliestMin = Math.min(...businessHours.map((h) => toMin(h.start)))
  const dueMin = earliestMin - 30
  const due = new Date(now)
  due.setHours(0, dueMin, 0, 0)
  return due
}

/**
 * 每日汇总是否该发（R1-2：休业日不推，且不消耗 dailySentOn；`force` 由调用方在
 * pushDailyLowStockSummary 里单独处理，这里只判「正常流程」）。
 */
export function shouldSendDaily(state: AlertState, s: LocalDeliverySettings, now: Date = new Date()): boolean {
  if (isHolidayNow(s, now)) return false
  const today = shanghaiDateStr(now)
  if (state.dailySentOn === today) return false
  const due = dailySummaryDueAt(s.businessHours, now)
  if (!due) return false
  return now.getTime() >= due.getTime()
}

/** 展平商品+SKU 为库存单位；无规格商品用 product 本身，key=`product:<id>` */
export function unitsOfProducts(
  products: {
    id: number
    name: string
    channel: string
    status: string
    stock: number
    coverImage: string | null
    skus: { id: number; specText: string; stock: number; sortOrder: number }[]
  }[]
): StockUnit[] {
  const units: StockUnit[] = []
  for (const p of products) {
    const onShelf = p.status === 'ON_SHELF'
    const channel = (p.channel === 'LOCAL' ? 'LOCAL' : 'EXPRESS') as Channel
    if (p.skus.length > 0) {
      for (const sku of p.skus) {
        units.push({
          key: `sku:${sku.id}`,
          productId: p.id,
          productName: p.name,
          channel,
          coverImage: p.coverImage,
          skuId: sku.id,
          specText: sku.specText,
          stock: sku.stock,
          onShelf,
          sortOrder: sku.sortOrder,
        })
      }
    } else {
      units.push({
        key: `product:${p.id}`,
        productId: p.id,
        productName: p.name,
        channel,
        coverImage: p.coverImage,
        skuId: null,
        specText: null,
        stock: p.stock,
        onShelf,
        sortOrder: 0,
      })
    }
  }
  return units
}

/** 页面结构：只留 onShelf 且档位非 OK 的单位，按商品归组 */
export function groupUnits(units: StockUnit[], s: LowStockSettings): LowStockGroup[] {
  const byProduct = new Map<number, StockUnit[]>()
  for (const u of units) {
    if (!u.onShelf) continue
    if (classifyStock(u.stock, s) === 'OK') continue
    const arr = byProduct.get(u.productId) ?? []
    arr.push(u)
    byProduct.set(u.productId, arr)
  }
  const groups: LowStockGroup[] = []
  for (const [productId, us] of byProduct) {
    const sorted = [...us].sort((a, b) => a.sortOrder - b.sortOrder)
    const views: StockUnitView[] = sorted.map((u) => ({
      key: u.key,
      skuId: u.skuId,
      specText: u.specText,
      stock: u.stock,
      level: classifyStock(u.stock, s) as AlertLevel,
    }))
    const out = views.filter((v) => v.level === 'OUT').length
    const low = views.length - out
    groups.push({
      productId,
      productName: sorted[0].productName,
      channel: sorted[0].channel,
      coverImage: sorted[0].coverImage,
      hasSkus: sorted[0].skuId !== null,
      out,
      low,
      units: views,
    })
  }
  // 先含售罄的组，再按最小库存升序，再 productId 升序
  groups.sort((a, b) => {
    const aOut = a.out > 0 ? 0 : 1
    const bOut = b.out > 0 ? 0 : 1
    if (aOut !== bOut) return aOut - bOut
    const aMin = Math.min(...a.units.map((u) => u.stock))
    const bMin = Math.min(...b.units.map((u) => u.stock))
    if (aMin !== bMin) return aMin - bMin
    return a.productId - b.productId
  })
  return groups
}

/** GET /admin/products 用：单个商品的售罄/紧张规格数；下架商品恒 {0,0} */
export function productAlertSummary(
  product: { status: string; stock: number; skus?: { stock: number }[] },
  s: LowStockSettings
): { out: number; low: number } {
  if (product.status !== 'ON_SHELF') return { out: 0, low: 0 }
  const skus = product.skus ?? []
  if (skus.length === 0) {
    const level = classifyStock(product.stock, s)
    if (level === 'OUT') return { out: 1, low: 0 }
    if (level === 'LOW') return { out: 0, low: 1 }
    return { out: 0, low: 0 }
  }
  let out = 0
  let low = 0
  for (const sku of skus) {
    const level = classifyStock(sku.stock, s)
    if (level === 'OUT') out++
    else if (level === 'LOW') low++
  }
  return { out, low }
}

// ── 文案纯函数（order-notify.ts 只负责投递）────────────────────
function unitLine(u: StockUnit): string {
  const spec = u.specText ? ` ${u.specText}` : ''
  return `${u.productName}${spec}（${CHANNEL_LABEL[u.channel]}）`
}

function truncateLines(lines: string[], max = 30): string[] {
  if (lines.length <= max) return lines
  return [...lines.slice(0, max), `…其余 ${lines.length - max} 项`]
}

export function buildLowStockChangeContent(pushes: { unit: StockUnit; level: AlertLevel }[], s: LowStockSettings): string {
  const outs = pushes.filter((p) => p.level === 'OUT').map((p) => p.unit)
  const lows = pushes.filter((p) => p.level === 'LOW').map((p) => p.unit)
  const body: string[] = []
  if (outs.length) {
    body.push(`已售罄 ${outs.length} 项：`)
    body.push(...outs.map((u) => `- ${unitLine(u)}：已售罄`))
  }
  if (lows.length) {
    body.push(`低于 ${s.pushBelow} 份 ${lows.length} 项：`)
    body.push(...lows.map((u) => `- ${unitLine(u)}：剩 ${u.stock}`))
  }
  return [`**📉 库存告急（${pushes.length} 项）**`, ...truncateLines(body, 30)].join('\n')
}

export function buildLowStockDailyContent(overview: LowStockOverview, s: LowStockSettings): string {
  const { counts, groups } = overview
  const head = [`**🗓 今日库存清单（≤${s.lowThreshold}）**`, `售罄 ${counts.out} 项 · 紧张 ${counts.low} 项`]
  const body = groups.map((g) => {
    const specs = g.units.map((u) => `${u.specText ?? ''}${u.level === 'OUT' ? '售罄' : `剩${u.stock}`}`).join('/')
    return `- ${g.productName}（${CHANNEL_LABEL[g.channel]}）：${specs}`
  })
  return [...head, ...truncateLines(body, 30)].join('\n')
}

// ── DB：状态读写 ────────────────────────────────────────────
const STATE_KEY = 'low_stock_alert_state'
const DEFAULT_STATE: AlertState = { levels: {}, dailySentOn: null }

export async function getAlertState(): Promise<AlertState> {
  try {
    const row = await prisma.setting.findUnique({ where: { key: STATE_KEY } })
    if (!row) return DEFAULT_STATE
    const parsed = JSON.parse(row.value) as Partial<AlertState>
    const levels: Record<string, AlertLevel> = {}
    if (parsed.levels && typeof parsed.levels === 'object') {
      for (const [k, v] of Object.entries(parsed.levels as Record<string, unknown>)) {
        if (v === 'OUT' || v === 'LOW') levels[k] = v
      }
    }
    return { levels, dailySentOn: typeof parsed.dailySentOn === 'string' ? parsed.dailySentOn : null }
  } catch {
    return DEFAULT_STATE
  }
}

export async function saveAlertState(state: AlertState): Promise<void> {
  const json = JSON.stringify(state)
  await prisma.setting.upsert({ where: { key: STATE_KEY }, create: { key: STATE_KEY, value: json }, update: { value: json } })
}

// ── DB：查询单位 ────────────────────────────────────────────
/**
 * 查**所有未删商品**（不限 status）是为了按现存单位裁剪状态——下架商品仍要留着它的
 * 状态（R1-3），只有商品被软删或规格被删除，才应该让状态一并消失；这两种情况下该
 * 商品/规格本来就不会出现在这次查询结果里，diffAlertTransitions 只从 units 构建
 * nextLevels，天然完成裁剪。
 */
export async function listStockUnits(): Promise<StockUnit[]> {
  const products = await prisma.product.findMany({
    where: { deletedAt: null },
    select: {
      id: true,
      name: true,
      channel: true,
      status: true,
      stock: true,
      coverImage: true,
      skus: { select: { id: true, specText: true, stock: true, sortOrder: true }, orderBy: { sortOrder: 'asc' } },
    },
  })
  return unitsOfProducts(products)
}

export async function lowStockOverview(s?: LowStockSettings): Promise<LowStockOverview> {
  const settings = s ?? (await getLowStockSettings())
  const units = await listStockUnits()
  const groups = groupUnits(units, settings)
  const byChannel: Record<Channel, { out: number; low: number }> = {
    EXPRESS: { out: 0, low: 0 },
    LOCAL: { out: 0, low: 0 },
  }
  let out = 0
  let low = 0
  for (const g of groups) {
    out += g.out
    low += g.low
    byChannel[g.channel].out += g.out
    byChannel[g.channel].low += g.low
  }
  return { settings, counts: { total: out + low, out, low, byChannel }, groups }
}

/** pending-count 用：在架规格里售罄+紧张的数量 */
export async function countLowStockUnits(s?: LowStockSettings): Promise<number> {
  const settings = s ?? (await getLowStockSettings())
  const units = await listStockUnits()
  let count = 0
  for (const u of units) {
    if (!u.onShelf) continue
    if (classifyStock(u.stock, settings) !== 'OK') count++
  }
  return count
}

// ── 定时任务入口 ────────────────────────────────────────────
/** 即时推送：低于 pushBelow / 卖到 0，去重后按需推送；通道未配置也照常计数与写状态 */
export async function scanLowStockAlerts(): Promise<number> {
  const s = await getLowStockSettings()
  const state = await getAlertState()
  const units = await listStockUnits()
  const { pushes, nextLevels, changed } = diffAlertTransitions(state, units, s)
  if (pushes.length > 0) notifyLowStockChange(pushes, s)
  if (changed) await saveAlertState({ ...state, levels: nextLevels })
  return pushes.length
}

/**
 * 每日汇总：休业门任何情况下都不绕过（R1-2）；`force` 只绕过 dailySentOn 与应发时刻两道门。
 * 返回本次汇总里的售罄+紧张单位数；不发（含被休业/日切挡住）返回 0。
 */
export async function pushDailyLowStockSummary(now: Date = new Date(), force = false): Promise<number> {
  const localSettings = await getLocalSettings()
  if (isHolidayNow(localSettings, now)) return 0
  const state = await getAlertState()
  if (!force && !shouldSendDaily(state, localSettings, now)) return 0
  const s = await getLowStockSettings()
  const overview = await lowStockOverview(s)
  const total = overview.counts.out + overview.counts.low
  if (total > 0) notifyLowStockDaily(overview, s)
  await saveAlertState({ ...state, dailySentOn: shanghaiDateStr(now) })
  return total
}
