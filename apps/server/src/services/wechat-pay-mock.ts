/**
 * 微信支付退款查询 mock（WECHAT_PAY_MOCK=true）。零 setTimeout，靠指令队列驱动；
 * 不排指令时默认返回「处理中」——这个默认值本身是安全的：调用方（reconcileRefund）
 * 对 PROCESSING 不做任何状态改动，所以「忘了排指令」不会误伤真实数据。
 * 按 outRefundNo 键分别排队，`'*'` 是通配兜底（不区分具体单号时用）；`calls[]` 记录全部调用
 * 供 e2e 断言「查了几次」。范式与 services/delivery/express-mock.ts 一致。
 */
import { WechatRefundError } from './wechat-pay'
import type { RefundQueryResult, RefundQueryFound } from './wechat-pay'

export type RefundQueryDirective =
  | { kind: 'ok'; status: 'SUCCESS' | 'CLOSED' | 'PROCESSING' | 'ABNORMAL'; amount?: number; refundId?: string; successTime?: string }
  | { kind: 'not_found' }
  | { kind: 'error'; code: string; message?: string; httpStatus?: number }
  | { kind: 'timeout' }

const queues = new Map<string, RefundQueryDirective[]>()
const calls: { op: 'queryRefund'; outRefundNo: string; at: string }[] = []

/** 排一条查询单笔退款的指令。outRefundNo 缺省或传 '*' 表示对任意单号通配（优先级低于具体单号的队列）。 */
export function queueRefundQueryDirective(d: RefundQueryDirective, outRefundNo = '*'): void {
  if (!queues.has(outRefundNo)) queues.set(outRefundNo, [])
  queues.get(outRefundNo)!.push(d)
}

export function getPayMockCalls(op: 'queryRefund' = 'queryRefund') {
  return calls.filter((c) => c.op === op)
}

export function resetPayMock(): void {
  queues.clear()
  calls.length = 0
}

function take(outRefundNo: string): RefundQueryDirective {
  calls.push({ op: 'queryRefund', outRefundNo, at: new Date().toISOString() })
  const specific = queues.get(outRefundNo)
  if (specific && specific.length > 0) return specific.shift()!
  const wildcard = queues.get('*')
  if (wildcard && wildcard.length > 0) return wildcard.shift()!
  // 默认：安全值。reconcileRefund 对 PROCESSING 不做任何状态改动。
  return { kind: 'ok', status: 'PROCESSING' }
}

export async function mockQueryRefund(outRefundNo: string): Promise<RefundQueryResult> {
  const d = take(outRefundNo)
  if (d.kind === 'timeout') throw new Error('微信支付请求超时（mock）')
  if (d.kind === 'error') throw new WechatRefundError(d.code, d.message ?? 'mock 查询退款错误', d.httpStatus ?? 500)
  if (d.kind === 'not_found') return { kind: 'not_found' }
  const refund: RefundQueryFound = {
    refund_id: d.refundId ?? `mock_refund_${outRefundNo}`,
    out_refund_no: outRefundNo,
    status: d.status,
    success_time: d.successTime,
    // amount 只在指令显式给出时才带（与真实微信一致：补查只在 amount 存在时比对金额）
    ...(d.amount !== undefined ? { amount: { refund: d.amount, total: d.amount } } : {}),
  }
  return { kind: 'found', refund }
}
