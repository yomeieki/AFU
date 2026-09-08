/**
 * 邮寄查价 + 上门取件全流程 mock（EXPRESS_PROVIDER_MOCK=true）。零 setTimeout，靠指令队列驱动；
 * 不排指令时 batchPrice 按固定表回价，book/cancel/modify/detail/synPay 按默认成功处理。
 * 固定表 = 2026-09-08 实测自贡→成都 1.5 kg 折后首重价；续重每公斤一律 +¥1.30，让「重量影响报价」可断言。
 * 六个 op 各自一条指令队列（`queues`），互不干扰；`calls` 记录全部调用供按 op 过滤查询。
 */
import { ProviderError } from './types'
import { CourierQuote } from '../express-quote'
import type { ExpressPriceProvider, ExpressBatchPriceInput } from './kd100-express'
import { verifyAndParseExpressCallback } from './express-callback-sign'

export type ExpressMockOp = 'batchPrice' | 'book' | 'cancel' | 'modify' | 'detail' | 'synPay'
export type ExpressMockDirective =
  | { kind: 'ok'; quotes?: CourierQuote[]; taskId?: string; kdOrderId?: string; kuaidinum?: string | null; found?: boolean; status?: number; courierName?: string; courierMobile?: string }
  | { kind: 'timeout' }
  | { kind: 'error'; code: string; message?: string }

const FIRST_FEN: Record<string, number | null> = {
  jtexpress: 660, yuantong: 690, shentong: 705, yunda: 710, zhongtong: 830, debangkuaidi: 1110, jd: 1130, ems: 1710, shunfeng: null,
}
const OVER_PER_KG_FEN = 130
const SERVICE: Record<string, string> = { jd: '特惠送' }

const queues = new Map<ExpressMockOp, ExpressMockDirective[]>()
const calls: { op: ExpressMockOp; input: unknown; at: string }[] = []
let seq = 0
const procTag = Date.now().toString(36)

export function queueExpressDirective(d: ExpressMockDirective, op: ExpressMockOp = 'batchPrice'): void {
  if (!queues.has(op)) queues.set(op, [])
  queues.get(op)!.push(d)
}
export function getExpressCalls(op?: ExpressMockOp) { return op ? calls.filter((c) => c.op === op) : [...calls] }
export function resetExpressMock(): void { queues.clear(); calls.length = 0 }

function take(op: ExpressMockOp, input: unknown): ExpressMockDirective {
  calls.push({ op, input, at: new Date().toISOString() })
  const d = queues.get(op)?.shift() ?? { kind: 'ok' as const }
  if (d.kind === 'timeout') throw new ProviderError('TIMEOUT', 'TIMEOUT', `mock ${op} 超时`)
  if (d.kind === 'error') throw new ProviderError(d.code === '503' || d.code === '600' || d.code === '601' ? 'CONFIG' : /余额/.test(d.message ?? '') ? 'BALANCE' : 'BUSINESS', d.code, d.message ?? `mock ${op} 错误`)
  return d
}

function defaultQuotes(i: ExpressBatchPriceInput): CourierQuote[] {
  const over = Math.max(0, Math.ceil(i.weightKg) - 1) * OVER_PER_KG_FEN
  return i.couriers.map((c) => {
    const first = FIRST_FEN[c] ?? null
    return { kuaidicom: c, serviceType: first === null ? null : (SERVICE[c] ?? '标准快递'), priceFen: first === null ? null : first + over, defPriceFen: first === null ? null : first + over + 300 }
  })
}

export const expressMockProvider: ExpressPriceProvider = {
  name: 'MOCK',
  async batchPrice(input) { const d = take('batchPrice', input); return d.kind === 'ok' && d.quotes ? d.quotes : defaultQuotes(input) },
  async book(input) {
    const d = take('book', input) as Extract<ExpressMockDirective, { kind: 'ok' }>
    seq++
    const n = `${procTag}-${seq}`
    // 韵达异步出单：默认不返单号，等回调 0 再给——让「单号异步」这条路径可测
    const kuaidinum = d.kuaidinum !== undefined ? d.kuaidinum : input.kuaidicom === 'yunda' ? null : `${input.kuaidicom.toUpperCase()}${n}`
    return { taskId: d.taskId ?? `MOCKX-${n}`, kdOrderId: d.kdOrderId ?? `KDX-${n}`, kuaidinum, pollToken: `pt-${n}` }
  },
  async cancel(input) { take('cancel', input) },
  async modify(input) { take('modify', input) },
  async detail(input) {
    const d = take('detail', input) as Extract<ExpressMockDirective, { kind: 'ok' }>
    if (!d.found) return { found: false, status: null, taskId: null, kdOrderId: null, kuaidinum: null, courierName: null, courierMobile: null, freightFen: null, raw: null }
    return { found: true, status: d.status ?? 0, taskId: d.taskId ?? null, kdOrderId: d.kdOrderId ?? null, kuaidinum: d.kuaidinum ?? null, courierName: d.courierName ?? null, courierMobile: d.courierMobile ?? null, freightFen: null, raw: d }
  },
  async synPay(input) { take('synPay', input) },
  verifyAndParseCallback(body, salt) { return verifyAndParseExpressCallback(body, salt) },
}
