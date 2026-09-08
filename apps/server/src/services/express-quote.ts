/**
 * 邮寄运费的全部纯计算（不碰 DB、不外呼）。小程序只展示 /express/quote 的结果，不复刻。
 * 设计：spec §3。中位数只对 settings.pricingPool 里的家算；快照可以带全部 9 家。
 */
import crypto from 'crypto'
import { config } from '../config'
import { ExpressSettings, RegionGroup } from './express-settings'

export const EXPRESS_QUOTE_TTL_MS = 15 * 60 * 1000

export interface CourierQuote {
  kuaidicom: string
  serviceType: string | null
  /** 折后总价（分）；null = 该家这条线路没报价 */
  priceFen: number | null
  /** 标准价（分） */
  defPriceFen: number | null
}

/** 重量 = Σ(净重 ?? 默认净重) × 数量 + 每单包装；向上取到 0.1 kg，最小 0.1 */
export function calcPackageWeightKg(items: { netWeightG: number | null; quantity: number }[], w: { packagingG: number; defaultItemG: number }): number {
  const grams = items.reduce((sum, i) => sum + (i.netWeightG ?? w.defaultItemG) * i.quantity, 0) + w.packagingG
  return Math.max(0.1, Math.ceil(grams / 100) / 10)
}

export function medianFen(values: number[]): number {
  const a = [...values].sort((x, y) => x - y)
  const n = a.length
  if (n === 0) return 0
  return n % 2 === 1 ? a[(n - 1) / 2] : Math.round((a[n / 2 - 1] + a[n / 2]) / 2)
}

export function roundUpTo(fen: number, step: number): number {
  if (step <= 0) return fen
  return Math.ceil(fen / step) * step
}

/** 兜底表：首重 1 kg + 续重按整公斤向上取整 */
export function tableFee(g: RegionGroup, weightKg: number): number {
  return g.tableFirstFen + g.tableOverPerKgFen * Math.max(0, Math.ceil(weightKg) - 1)
}

export interface FeeCalc {
  /** 实收（包邮则 0） */
  feeFen: number
  /** 未包邮时的报价（成本展示与凭证锁价用） */
  quotedFeeFen: number
  feeSource: 'QUOTE' | 'TABLE'
  freeShip: boolean
  belowMin: boolean
  /** 该分组是否不寄送；路由层本应在算价前就拒绝，这里透传出来是为了不让这个检查被忘掉 */
  blocked: boolean
}

/**
 * 算运费。`locked` 传了就是「信凭证里签的报价」（QUOTE 锁价 15 分钟，与同城一致），
 * 此时 quotes 被忽略；包邮/起送永远按**当前**设置与**真实**小计判。
 */
export function calcExpressFee(
  s: ExpressSettings, group: RegionGroup, weightKg: number, quotes: CourierQuote[] | null, subtotalFen: number,
  locked?: { quotedFeeFen: number } | null,
): FeeCalc {
  let quotedFeeFen: number
  let feeSource: 'QUOTE' | 'TABLE'
  if (locked) {
    quotedFeeFen = locked.quotedFeeFen; feeSource = 'QUOTE'
  } else {
    const pool = new Set(s.pricingPool)
    // 一家一票：快递100 同一家可能回多个产品档，取最低那条
    const lowestByKuaidicom = new Map<string, number>()
    for (const q of quotes ?? []) {
      if (!pool.has(q.kuaidicom) || q.priceFen === null) continue
      const prev = lowestByKuaidicom.get(q.kuaidicom)
      if (prev === undefined || q.priceFen < prev) lowestByKuaidicom.set(q.kuaidicom, q.priceFen)
    }
    const valid = [...lowestByKuaidicom.values()]
    if (s.fee.mode === 'QUOTE' && valid.length >= s.fee.minQuoteCount) {
      quotedFeeFen = roundUpTo(medianFen(valid) + s.fee.markupFen, s.fee.roundToFen); feeSource = 'QUOTE'
    } else {
      quotedFeeFen = tableFee(group, weightKg); feeSource = 'TABLE'
    }
  }
  const freeShip = group.freeShipMinFen > 0 && subtotalFen >= group.freeShipMinFen
  const belowMin = s.minOrderAmountFen > 0 && subtotalFen < s.minOrderAmountFen
  return { feeFen: freeShip ? 0 : quotedFeeFen, quotedFeeFen, feeSource, freeShip, belowMin, blocked: group.blocked }
}

/** 商品清单指纹：凭证只能用在它报价时的那一份清单上（数量、规格、赠品任一变都作废） */
export function itemsHash(lines: { productId: number; skuId: number | null; quantity: number }[], gifts: { pointsGoodId: number; quantity: number }[]): string {
  const parts = [
    ...lines.map((l) => `p${l.productId}:${l.skuId ?? 0}:${l.quantity}`),
    ...gifts.map((g) => `g${g.pointsGoodId}:${g.quantity}`),
  ].sort()
  return crypto.createHash('sha256').update(parts.join('|'), 'utf8').digest('hex').slice(0, 16)
}

export interface ExpressQuotePayload {
  addressId: number
  itemsHash: string
  weightKg: number
  feeFen: number
  quotedFeeFen: number
  feeSource: 'QUOTE' | 'TABLE'
  groupName: string
  quotes: { kuaidicom: string; serviceType: string | null; priceFen: number | null }[]
}

export function expressQuoteExpiresAt(now: Date = new Date()): Date {
  return new Date(now.getTime() + EXPRESS_QUOTE_TTL_MS)
}
const b64u = (s: string) => Buffer.from(s, 'utf8').toString('base64url')
const hmac = (s: string) => crypto.createHmac('sha256', `express-quote:${config.jwt.userSecret}`).update(s).digest('hex').slice(0, 32)

export function signExpressQuote(p: ExpressQuotePayload, now: Date = new Date()): string {
  const body = b64u(JSON.stringify({
    a: p.addressId, h: p.itemsHash, w: Math.round(p.weightKg * 10), f: p.feeFen, qf: p.quotedFeeFen, fs: p.feeSource, g: p.groupName,
    q: p.quotes.map((q) => [q.kuaidicom, q.serviceType, q.priceFen]),
    e: expressQuoteExpiresAt(now).getTime(),
  }))
  return `${body}.${hmac(body)}`
}

export function verifyExpressQuote(token: unknown, now: Date = new Date()): ExpressQuotePayload | null {
  if (typeof token !== 'string') return null
  const [body, sig] = token.split('.')
  // 与 local-settings.verifyQuote 同款：先用字符集卡死 sig 形状，timingSafeEqual 才不会因长度不等抛 RangeError
  if (!body || !sig || !/^[0-9a-f]{32}$/.test(sig)) return null
  try {
    if (!crypto.timingSafeEqual(Buffer.from(hmac(body)), Buffer.from(sig))) return null
  } catch { return null }
  try {
    const o = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
    if (typeof o.e !== 'number' || o.e < now.getTime()) return null
    if ([o.a, o.w, o.f, o.qf].some((n) => typeof n !== 'number' || !Number.isFinite(n))) return null
    if (typeof o.h !== 'string' || !/^[0-9a-f]{16}$/.test(o.h)) return null
    if (o.fs !== 'QUOTE' && o.fs !== 'TABLE') return null
    if (typeof o.g !== 'string' || !Array.isArray(o.q)) return null
    const quotes: ExpressQuotePayload['quotes'] = []
    for (const row of o.q) {
      if (!Array.isArray(row) || row.length !== 3 || typeof row[0] !== 'string') return null
      if (row[1] !== null && typeof row[1] !== 'string') return null
      if (row[2] !== null && (typeof row[2] !== 'number' || !Number.isFinite(row[2]))) return null
      quotes.push({ kuaidicom: row[0], serviceType: row[1], priceFen: row[2] })
    }
    return { addressId: o.a, itemsHash: o.h, weightKg: o.w / 10, feeFen: o.f, quotedFeeFen: o.qf, feeSource: o.fs, groupName: o.g, quotes }
  } catch {
    return null
  }
}
