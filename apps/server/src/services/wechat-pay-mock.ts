/**
 * 微信支付退款查询/发起 mock（WECHAT_PAY_MOCK=true）。零 setTimeout，靠指令队列驱动；
 * 不排指令时默认返回「处理中」——这个默认值本身是安全的：调用方（reconcileRefund）
 * 对 PROCESSING 不做任何状态改动，所以「忘了排指令」不会误伤真实数据。
 * 按 outRefundNo 键分别排队，`'*'` 是通配兜底（不区分具体单号时用）；`calls[]` 记录全部调用
 * 供 e2e 断言「查了几次」。范式与 services/delivery/express-mock.ts 一致。
 *
 * createRefund（发起退款）指令改按 orderId 键排队（'*' 通配）：e2e 在 POST /refund 之前就
 * 知道 orderId，而 outRefundNo 要到事务 A 之后才有——这是与 queryRefund 指令排队方式不同的
 * 唯一原因（T1，2026-09-23）。
 */
import { WechatRefundError } from './wechat-pay'
import type { RefundQueryResult, RefundQueryFound } from './wechat-pay'

export type RefundQueryDirective =
  | { kind: 'ok'; status: 'SUCCESS' | 'CLOSED' | 'PROCESSING' | 'ABNORMAL'; amount?: number; refundId?: string; successTime?: string }
  | { kind: 'not_found' }
  | { kind: 'error'; code: string; message?: string; httpStatus?: number }
  | { kind: 'timeout' }

/**
 * createRefund 指令。`preemptNotify`：在 mock 的「同步返回」之前，先模拟一次「微信回调已抢先
 * 到达」（P2 场景，见 mockCreateRefund/applyMockRefundNotify）。
 */
export type RefundCreateDirective =
  | {
      kind: 'ok'
      status: 'SUCCESS' | 'CLOSED' | 'PROCESSING' | 'ABNORMAL'
      amount?: number
      refundId?: string
      successTime?: string
      preemptNotify?: { status: 'SUCCESS' | 'CLOSED' | 'ABNORMAL' }
    }
  | { kind: 'error'; code: string; message?: string; httpStatus?: number }
  | { kind: 'timeout' }

const queues = new Map<string, RefundQueryDirective[]>()
const createQueues = new Map<string, RefundCreateDirective[]>()
const calls: { op: 'queryRefund' | 'createRefund'; outRefundNo: string; at: string }[] = []

/** 排一条查询单笔退款的指令。outRefundNo 缺省或传 '*' 表示对任意单号通配（优先级低于具体单号的队列）。 */
export function queueRefundQueryDirective(d: RefundQueryDirective, outRefundNo = '*'): void {
  if (!queues.has(outRefundNo)) queues.set(outRefundNo, [])
  queues.get(outRefundNo)!.push(d)
}

/** 排一条发起退款（createRefund）指令，按 orderId 键（'*' 通配）。 */
export function queueRefundCreateDirective(d: RefundCreateDirective, orderId: number | '*' = '*'): void {
  const key = String(orderId)
  if (!createQueues.has(key)) createQueues.set(key, [])
  createQueues.get(key)!.push(d)
}

/** 该 orderId（或通配队列）是否排着 createRefund 指令——只看不取，供 initiateRefund 判断走不走模拟微信路径 */
export function hasRefundCreateDirective(orderId: number): boolean {
  const key = String(orderId)
  return (createQueues.get(key)?.length ?? 0) > 0 || (createQueues.get('*')?.length ?? 0) > 0
}

export function getPayMockCalls(op: 'queryRefund' | 'createRefund' = 'queryRefund') {
  return calls.filter((c) => c.op === op)
}

export function resetPayMock(): void {
  queues.clear()
  createQueues.clear()
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

function takeCreate(orderId: number): RefundCreateDirective | undefined {
  const key = String(orderId)
  const specific = createQueues.get(key)
  if (specific && specific.length > 0) return specific.shift()!
  const wildcard = createQueues.get('*')
  if (wildcard && wildcard.length > 0) return wildcard.shift()!
  return undefined
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

/**
 * 模拟「微信回调已抢先到达」：在 mockCreateRefund 同步返回之前调用，与
 * routes/wechat-notify.ts 的 wechatRefundNotifyHandler dispatch 完全同形，只是跳过验签/解密。
 * 用函数内 `await import('./refund')` 避免与 refund.ts 之间的模块级循环引用
 * （refund.ts 引入本文件的 mockCreateRefund/hasRefundCreateDirective）。
 */
export async function applyMockRefundNotify(outRefundNo: string, status: 'SUCCESS' | 'CLOSED' | 'ABNORMAL'): Promise<void> {
  const refundMod = await import('./refund')
  const prisma = (await import('../utils/prisma')).default
  const row = await prisma.refund.findUnique({ where: { outRefundNo } })
  if (!row) return
  if (status === 'SUCCESS') {
    await refundMod.finalizeRefundSuccess({
      refundId: row.id,
      wxRefundId: `mock_notify_${outRefundNo}`,
      rawData: JSON.stringify({ source: 'mock-notify' }),
      rawField: 'wxNotifyData',
    })
  } else if (status === 'CLOSED') {
    await refundMod.markRefundClosed(row.id, JSON.stringify({ source: 'mock-notify' }))
  } else {
    await refundMod.markRefundAbnormal(row.id, JSON.stringify({ source: 'mock-notify' }))
  }
}

/**
 * 模拟 createRefund（发起退款）。initiateRefund 只在 hasRefundCreateDirective(orderId) 为真时
 * 才会调用本函数——无指令时逐字节走原来的 MOCK 秒成功分支（:249-252），行为与改动前完全一致。
 */
export async function mockCreateRefund(
  orderId: number,
  params: { outTradeNo: string; outRefundNo: string; amount: number; total: number; reason?: string; notifyUrl: string }
): Promise<{
  refund_id: string
  out_refund_no: string
  status: 'SUCCESS' | 'CLOSED' | 'PROCESSING' | 'ABNORMAL'
  success_time?: string
  amount: { refund: number; total: number }
}> {
  calls.push({ op: 'createRefund', outRefundNo: params.outRefundNo, at: new Date().toISOString() })
  const d = takeCreate(orderId)
  if (!d) {
    // 理论上不会走到这里（调用方已用 hasRefundCreateDirective 短路），留一个安全默认防御。
    return { refund_id: `mock_refund_${params.outRefundNo}`, out_refund_no: params.outRefundNo, status: 'SUCCESS', amount: { refund: params.amount, total: params.total } }
  }
  if (d.kind === 'timeout') throw new Error('微信支付请求超时（mock）')
  if (d.kind === 'error') throw new WechatRefundError(d.code, d.message ?? 'mock 发起退款错误', d.httpStatus ?? 500)
  if (d.preemptNotify) {
    await applyMockRefundNotify(params.outRefundNo, d.preemptNotify.status)
  }
  return {
    refund_id: d.refundId ?? `mock_refund_${params.outRefundNo}`,
    out_refund_no: params.outRefundNo,
    status: d.status,
    success_time: d.successTime,
    amount: { refund: d.amount ?? params.amount, total: params.total },
  }
}
