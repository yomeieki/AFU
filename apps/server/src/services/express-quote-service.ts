/**
 * 邮寄报价编排：地址 → 分组 → 清单/重量 → 查价（缓存）→ 运费 → 凭证。
 * 顾客侧 /express/quote 与下单端点（老客户端不带凭证时）都走这里，保证同一套口径。
 */
import prisma from '../utils/prisma'
import { AppError } from '../middlewares/error'
import { getExpressSettings, findRegionGroup, ExpressSettings, EXPRESS_COURIERS } from './express-settings'
import {
  CourierQuote, calcPackageWeightKg, calcExpressFee, itemsHash, addressHash, signExpressQuote, expressQuoteExpiresAt, EXPRESS_QUOTE_TTL_MS,
} from './express-quote'
import { getExpressProvider } from './delivery/kd100-express'
import { loadOrderLines, assertLinesSellable, DirectItemInput } from './order-lines'
import { loadGiftLines } from './member/checkout'
import { getLocalSettings } from './local-settings'
import { notifySystemAlert } from './notify'

/** 顾客在结算页等报价的上限，与同城顾客侧一致 */
export const CUSTOMER_QUOTE_TIMEOUT_MS = 5000
/** 收件地址字节上限（快递100 recManPrintAddr 限 300 字节） */
export const MAX_ADDRESS_BYTES = 300

const cache = new Map<string, { quotes: CourierQuote[]; at: number }>()
const CACHE_MAX = 500
export const _quoteCache = cache
export function clearExpressQuoteCache(): void { cache.clear() }

function senderAddress(): Promise<string> {
  return getLocalSettings().then((s) => `${s.store.province}${s.store.city}${s.store.district}${s.store.address}`)
}

/**
 * 向快递100 查 9 家报价（全部家，不只定价名单——快照给店员端看）。
 * 同一 (addressId, 地址内容, weightKg) 15 分钟内复用；查价失败返回 null（调用方退兜底表），**失败不写缓存**。
 * key 里带地址内容指纹：`PUT /api/addresses/:id` 是原地改（同 id 换省市区/详细地址），
 * 光用 addressId 会在地址改动后 15 分钟内继续吐改动前那份地址的缓存报价。
 */
export async function fetchCourierQuotes(s: ExpressSettings, addressId: number, receiverFullAddress: string, weightKg: number): Promise<CourierQuote[] | null> {
  if (s.fee.mode !== 'QUOTE') return null
  const key = `${addressId}:${addressHash(receiverFullAddress)}:${weightKg}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < EXPRESS_QUOTE_TTL_MS) return hit.quotes
  // 读设置（发件地址）挪到 try 外面：settings 读失败是配置问题，不该跟「查价失败」共用
  // 同一条兜底表降级路径而被悄悄吞掉。
  const senderAddr = await senderAddress()
  try {
    const quotes = await getExpressProvider().batchPrice({
      couriers: [...EXPRESS_COURIERS], senderAddr, receiverAddr: receiverFullAddress, weightKg, timeoutMs: CUSTOMER_QUOTE_TIMEOUT_MS,
    })
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string)
    cache.set(key, { quotes, at: Date.now() })
    return quotes
  } catch (e) {
    console.warn('[express-quote] 查价失败，退回兜底表:', (e as Error).message)
    notifySystemAlert('邮寄查价失败，已退回兜底表', [`地址 #${addressId} ${weightKg}kg`, (e as Error).message], {
      key: 'express:quote-fallback',
    })
    return null
  }
}

export interface QuoteRequest {
  userId: number
  addressId: number
  cartItemIds?: number[]
  directItem?: DirectItemInput
  gifts?: { pointsGoodId: number; quantity: number }[]
}
export interface QuoteResult {
  feeFen: number; quotedFeeFen: number; feeSource: 'QUOTE' | 'TABLE'; weightKg: number; groupName: string
  freeShipMinFen: number; freeShip: boolean; belowMin: boolean; minOrderAmountFen: number; subtotalFen: number
  /** 回价家数（含无价的家）；各家成本价不下发顾客，只签进凭证 */
  quoteCount: number; quoteToken: string; quoteExpiresAt: string
}

export async function quoteExpress(req: QuoteRequest, now: Date = new Date()): Promise<QuoteResult> {
  const s = await getExpressSettings()
  const address = await prisma.address.findFirst({ where: { id: req.addressId, userId: req.userId, deletedAt: null } })
  if (!address) throw new AppError(40401, '收货地址不存在', 404)
  const group = findRegionGroup(s, address.province)
  if (group.blocked) throw new AppError(42260, '该地区暂不支持邮寄')
  if (Buffer.byteLength(address.fullAddress, 'utf8') > MAX_ADDRESS_BYTES) throw new AppError(42262, '收货地址过长，请精简后再试')

  const lines = await loadOrderLines(req.userId, { cartItemIds: req.cartItemIds, directItem: req.directItem })
  assertLinesSellable(lines, 'EXPRESS')
  const gifts = req.gifts ?? []
  const giftLines = (await loadGiftLines(req.userId, 'EXPRESS', gifts)).lines
  const subtotalFen = lines.reduce((sum, l) => sum + (l.sku?.price ?? l.product.price) * l.quantity, 0)
  const weightKg = calcPackageWeightKg(
    [...lines.map((l) => ({ netWeightG: l.product.netWeightG, quantity: l.quantity })), ...giftLines.map((g) => ({ netWeightG: g.netWeightG, quantity: g.quantity }))],
    s.weight,
  )
  const quotes = await fetchCourierQuotes(s, address.id, address.fullAddress, weightKg)
  const fee = calcExpressFee(s, group, weightKg, quotes, subtotalFen)
  const snapshot = (quotes ?? []).map((q) => ({ kuaidicom: q.kuaidicom, serviceType: q.serviceType, priceFen: q.priceFen }))
  const quoteToken = signExpressQuote({
    addressId: address.id, addressHash: addressHash(address.fullAddress), itemsHash: itemsHash(lines, gifts), weightKg,
    feeFen: fee.feeFen, quotedFeeFen: fee.quotedFeeFen, feeSource: fee.feeSource, groupName: group.name, quotes: snapshot,
  }, now)
  return {
    feeFen: fee.feeFen, quotedFeeFen: fee.quotedFeeFen, feeSource: fee.feeSource, weightKg, groupName: group.name,
    freeShipMinFen: group.freeShipMinFen, freeShip: fee.freeShip, belowMin: fee.belowMin, minOrderAmountFen: s.minOrderAmountFen, subtotalFen,
    quoteCount: (quotes ?? []).length, quoteToken, quoteExpiresAt: expressQuoteExpiresAt(now).toISOString(),
  }
}
