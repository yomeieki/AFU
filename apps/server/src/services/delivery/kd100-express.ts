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

export interface ExpressBatchPriceInput {
  couriers: string[]
  senderAddr: string
  receiverAddr: string
  weightKg: number
  timeoutMs?: number
}
export interface ExpressPriceProvider {
  name: 'KD100' | 'MOCK'
  batchPrice(input: ExpressBatchPriceInput): Promise<CourierQuote[]>
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
}

export function getExpressProvider(): ExpressPriceProvider {
  return config.mock.express ? expressMockProvider : kd100ExpressProvider
}
