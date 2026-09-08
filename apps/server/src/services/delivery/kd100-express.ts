/**
 * 快递100「上门取件 API（线上支付）」协议实现。批次一只有 batchPrice；下单/取消/查单在批次二加。
 * 事实来源 docs/research/2026-09-08-kuaidi100-merchant-shipping-api.md：
 *  - POST https://poll.kuaidi100.com/order/borderapi.do，form；sign 与同城同公式
 *  - batchPrice：{ kuaidiComList, sendManPrintAddr, recManPrintAddr, weight }，响应 data 是数组，
 *    每项 { kuaidiCom, price, defPrice, serviceType, firstPrice, overPrice, ... }，没价的家 price=null
 *  - 错误码 400 参数 / 503 签名 / 600 非法用户 / 601 key 过期；业务失败走 500 + message 原话
 */
import { config, validateKd100ExpressConfig } from '../../config'
import { postKd100 } from './kd100-client'
import { ProviderErrorKind } from './types'
import { CourierQuote } from '../express-quote'
import { expressMockProvider } from './express-mock'
import { verifyAndParseExpressCallback, _parseCallbackParam, ExpressCallbackPayload, str, numOrNull } from './express-callback-sign'

export type { ExpressCallbackPayload }
export { _parseCallbackParam }

export interface ExpressBatchPriceInput {
  couriers: string[]
  senderAddr: string
  receiverAddr: string
  weightKg: number
  timeoutMs?: number
}
export interface ExpressParty { name: string; mobile: string; addr: string }
export interface ExpressBookInput {
  bookingNo: string; kuaidicom: string; serviceType?: string | null
  sender: ExpressParty; receiver: ExpressParty
  cargo: string; weightKg: number; remark?: string | null
  dayType?: string | null; pickupStart?: string | null; pickupEnd?: string | null
  callbackUrl: string; salt: string; timeoutMs?: number
}
export interface ExpressBookResult { taskId: string | null; kdOrderId: string | null; kuaidinum: string | null; pollToken: string | null }
export interface ExpressDetailResult {
  found: boolean; status: number | null; taskId: string | null; kdOrderId: string | null; kuaidinum: string | null
  courierName: string | null; courierMobile: string | null; freightFen: number | null; raw: unknown
}
export interface ExpressPriceProvider {
  name: 'KD100' | 'MOCK'
  batchPrice(input: ExpressBatchPriceInput): Promise<CourierQuote[]>
  book(input: ExpressBookInput): Promise<ExpressBookResult>
  cancel(input: { taskId: string | null; kdOrderId: string | null; reason: string; timeoutMs?: number }): Promise<void>
  modify(input: { taskId: string | null; kdOrderId: string | null; dayType: string; pickupStart: string | null; pickupEnd: string | null }): Promise<void>
  detail(input: { taskId: string | null; thirdOrderId: string }): Promise<ExpressDetailResult>
  synPay(input: { kdOrderId: string }): Promise<void>
  verifyAndParseCallback(body: Record<string, string>, salt: string): { ok: true; payload: ExpressCallbackPayload } | { ok: false; reason: 'BAD_PARAM' | 'SIGN_MISMATCH' }
}

const DEFAULT_TIMEOUT_MS = 8000

export function _mapExpressReturnCode(code: number | string, message = ''): ProviderErrorKind {
  const c = String(code)
  if (c === '503' || c === '600' || c === '601') return 'CONFIG'
  if (/余额/.test(message)) return 'BALANCE'
  return 'BUSINESS'
}

export function _buildBatchPriceParam(i: ExpressBatchPriceInput): Record<string, unknown> {
  return { kuaidiComList: i.couriers, sendManPrintAddr: i.senderAddr, recManPrintAddr: i.receiverAddr, weight: i.weightKg.toFixed(1) }
}

const yuanToFen = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  // 非正价格（0 / 负数 / 脏数据）不是一个可用报价——留在这里会被当成"最低价"抢进中位数，
  // 把顾客运费直接算成 0 附近。统一在这里挡掉，calcExpressFee 的池过滤不用再重复这条判断。
  if (!Number.isFinite(n) || n <= 0) return null
  return Math.round(n * 100)
}

export function _parseBatchPrice(data: unknown): CourierQuote[] {
  if (!Array.isArray(data)) return []
  const out: CourierQuote[] = []
  for (const row of data) {
    const r = (row ?? {}) as Record<string, unknown>
    const code = String(r.kuaidiCom ?? r.kuaidicom ?? '').trim()
    if (!code) continue
    out.push({
      kuaidicom: code,
      serviceType: typeof r.serviceType === 'string' && r.serviceType ? r.serviceType : null,
      priceFen: yuanToFen(r.price),
      defPriceFen: yuanToFen(r.defPrice),
    })
  }
  return out
}

/** bOrder 参数（docs/research §3.1）。时段/业务类型只在给了才传：顺丰必填，其它家留空表示「随时」 */
export function _buildBookParam(i: ExpressBookInput): Record<string, unknown> {
  const p: Record<string, unknown> = {
    kuaidicom: i.kuaidicom,
    recManName: i.receiver.name, recManMobile: i.receiver.mobile, recManPrintAddr: i.receiver.addr,
    sendManName: i.sender.name, sendManMobile: i.sender.mobile, sendManPrintAddr: i.sender.addr,
    callBackUrl: i.callbackUrl, salt: i.salt, thirdOrderId: i.bookingNo,
    cargo: i.cargo, weight: i.weightKg.toFixed(1), payment: 'SHIPPER',
  }
  if (i.serviceType) p.serviceType = i.serviceType
  if (i.remark) p.remark = i.remark
  if (i.dayType) p.dayType = i.dayType
  if (i.pickupStart) p.pickupStartTime = i.pickupStart
  if (i.pickupEnd) p.pickupEndTime = i.pickupEnd
  return p
}
export function _parseBook(data: unknown): ExpressBookResult {
  const d = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>
  return { taskId: str(d.taskId), kdOrderId: str(d.orderId), kuaidinum: str(d.kuaidinum ?? d.kuaidiNum), pollToken: str(d.pollToken) }
}
export function _parseDetail(data: unknown): ExpressDetailResult {
  const d = (data && typeof data === 'object' && !Array.isArray(data) ? data : {}) as Record<string, unknown>
  const status = numOrNull(d.status)
  if (status === null && !str(d.taskId) && !str(d.orderId)) return { found: false, status: null, taskId: null, kdOrderId: null, kuaidinum: null, courierName: null, courierMobile: null, freightFen: null, raw: data }
  const fr = numOrNull(d.freight)
  return { found: true, status, taskId: str(d.taskId), kdOrderId: str(d.orderId), kuaidinum: str(d.kuaidiNum ?? d.kuaidinum), courierName: str(d.courierName), courierMobile: str(d.courierMobile), freightFen: fr === null ? null : Math.round(fr * 100), raw: data }
}

async function call(method: string, param: Record<string, unknown>, timeoutMs = DEFAULT_TIMEOUT_MS) {
  validateKd100ExpressConfig()
  return postKd100({ url: config.kd100Express.apiUrl, method, param, key: config.kd100Express.key, secret: config.kd100Express.secret, timeoutMs, mapReturnCode: (code, message) => _mapExpressReturnCode(code, message) })
}

export const kd100ExpressProvider: ExpressPriceProvider = {
  name: 'KD100',
  async batchPrice(input) {
    validateKd100ExpressConfig()
    const data = await postKd100({
      url: config.kd100Express.apiUrl, method: 'batchPrice', param: _buildBatchPriceParam(input),
      key: config.kd100Express.key, secret: config.kd100Express.secret,
      timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      mapReturnCode: (code, message) => _mapExpressReturnCode(code, message),
    })
    return _parseBatchPrice(data.data)
  },
  async book(input) { const r = await call('bOrder', _buildBookParam(input), input.timeoutMs ?? 15000); return _parseBook(r.data) },
  async cancel(input) { await call('cancel', { taskId: input.taskId ?? '', orderId: input.kdOrderId ?? '', cancelMsg: input.reason.slice(0, 30) }, input.timeoutMs ?? DEFAULT_TIMEOUT_MS) },
  async modify(input) {
    const p: Record<string, unknown> = { taskId: input.taskId ?? '', orderId: input.kdOrderId ?? '', dayType: input.dayType }
    if (input.pickupStart) p.pickupStartTime = input.pickupStart
    if (input.pickupEnd) p.pickupEndTime = input.pickupEnd
    await call('modifyOrder', p)
  },
  async detail(input) {
    const p: Record<string, unknown> = { thirdOrderId: input.thirdOrderId }
    if (input.taskId) p.taskId = input.taskId
    const r = await call('detail', p)
    return _parseDetail(r.data)
  },
  async synPay(input) { await call('synPay', { orderId: input.kdOrderId }) },
  verifyAndParseCallback(body, salt) { return verifyAndParseExpressCallback(body, salt) },
}

export function getExpressProvider(): ExpressPriceProvider {
  return config.mock.express ? expressMockProvider : kd100ExpressProvider
}
