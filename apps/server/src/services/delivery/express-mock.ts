/**
 * 邮寄查价 mock（EXPRESS_PROVIDER_MOCK=true）。零 setTimeout，靠指令队列驱动；不排指令时按固定表回价。
 * 固定表 = 2026-09-08 实测自贡→成都 1.5 kg 折后首重价；续重每公斤一律 +¥1.30，让「重量影响报价」可断言。
 */
import { ProviderError } from './types'
import { CourierQuote } from '../express-quote'
import type { ExpressPriceProvider, ExpressBatchPriceInput } from './kd100-express'

export type ExpressMockDirective =
  | { kind: 'ok'; quotes?: CourierQuote[] }
  | { kind: 'timeout' }
  | { kind: 'error'; code: string; message?: string }

const FIRST_FEN: Record<string, number | null> = {
  jtexpress: 660, yuantong: 690, shentong: 705, yunda: 710, zhongtong: 830, debangkuaidi: 1110, jd: 1130, ems: 1710, shunfeng: null,
}
const OVER_PER_KG_FEN = 130
const SERVICE: Record<string, string> = { jd: '特惠送' }

const queue: ExpressMockDirective[] = []
const calls: { input: ExpressBatchPriceInput; at: string }[] = []

export function queueExpressDirective(d: ExpressMockDirective): void { queue.push(d) }
export function getExpressCalls() { return [...calls] }
export function resetExpressMock(): void { queue.length = 0; calls.length = 0 }

function defaultQuotes(i: ExpressBatchPriceInput): CourierQuote[] {
  const over = Math.max(0, Math.ceil(i.weightKg) - 1) * OVER_PER_KG_FEN
  return i.couriers.map((c) => {
    const first = FIRST_FEN[c] ?? null
    return { kuaidicom: c, serviceType: first === null ? null : (SERVICE[c] ?? '标准快递'), priceFen: first === null ? null : first + over, defPriceFen: first === null ? null : first + over + 300 }
  })
}

export const expressMockProvider: ExpressPriceProvider = {
  name: 'MOCK',
  async batchPrice(input) {
    calls.push({ input, at: new Date().toISOString() })
    const d = queue.shift() ?? { kind: 'ok' as const }
    if (d.kind === 'timeout') throw new ProviderError('TIMEOUT', 'TIMEOUT', 'mock 超时')
    if (d.kind === 'error') throw new ProviderError(d.code === '503' || d.code === '600' || d.code === '601' ? 'CONFIG' : /余额/.test(d.message ?? '') ? 'BALANCE' : 'BUSINESS', d.code, d.message ?? 'mock 错误')
    return d.quotes ?? defaultQuotes(input)
  },
}
