/**
 * 退款状态自动补查（2026-09-21）：微信退款回调丢失时，定时去问微信这笔退款到底成没成，
 * 按结果走既有的状态流转（成功→已退款；关闭→释放在途位可重试；异常→标异常并告警；
 * 仍处理中→下轮再查；查询失败→记日志下轮再试）。
 *
 * ── 为什么按行记状态（reconcileCheckedAt/reconcileCount），不用 member/cron-state.ts ──────
 * cron-state 是「全局每日一次」的日切状态（expirePoints/expireCoupons 那一类）。补查是
 * 「每一笔退款各自节流」，天然需要挂在 Refund 行上，不是一个全局开关能表达的。
 *
 * ── 为什么不设「停止轮询」封顶（不像 express-booking-tasks 的 UNKNOWN/STALE 有 tries 上限）──
 * 5 分钟一次的单笔查询代价可忽略（对比同城/邮寄对账那类要真调用第三方计价/预约接口）；
 * 而一旦设了封顶，最终会到账的那一单会在封顶之后永远卡死、连告警都不会再更新——
 * 停止轮询防的是"打爆第三方"，这里没有这个顾虑，代价与收益不对称，所以不设。
 *
 * ── 与回调路径的幂等与互斥依据（引用 services/refund.ts 行号）────────────────────────────
 * SUCCESS：finalizeRefundSuccess 头两句 FOR UPDATE（refund.ts:346-348）把回调与补查串行化；
 *   条件写 status≠SUCCESS（refund.ts:366）保证只有一方真正累加 refundedAmount；金额用一条
 *   原子 SQL LEAST(refunded_amount+amount, actual_amount) 封顶。回调后到时若已被补查推成
 *   SUCCESS，wechat-notify.ts 的「已 SUCCESS 直接 ack」分支会先短路；即便绕过，也会在
 *   finalizeRefundSuccess 的条件写这一步 count=0 退出，不会重复记账。
 * CLOSED/ABNORMAL/FAILED：markRefundClosed/markRefundAbnormal/markRefundFailed 三个函数本批
 *   都改成了条件 updateMany（见 refund.ts 各自函数头注释），只有「行仍在各自守卫集合内」时才
 *   真正转移状态并发通知；已被推进到别的终态的行，重复调用这三个函数 count=0 直接返回，
 *   不改状态、不重复通知。
 * 并发 tick：本文件 reconcileRefund 自己的 CAS 占坑（见下方），与
 *   services/delivery/express-booking-tasks.ts 的 reconcileExpressStale 同一范式——
 *   先 updateMany 把 reconcileCheckedAt 从旧值改成 now，count=0 说明另一次 tick / 手工触发
 *   已经抢先，直接 SKIPPED，不重复调用微信。
 */
import prisma from '../utils/prisma'
import { config } from '../config'
import { ACTIVE_REFUND_STATUSES, finalizeRefundSuccess, markRefundAbnormal, markRefundClosed, markRefundFailed } from './refund'
import { queryRefund, RefundQueryResult } from './wechat-pay'
import { mockQueryRefund } from './wechat-pay-mock'
import { notifySystemAlert } from './notify'

export type ReconcileOutcome =
  | 'SUCCESS'
  | 'CLOSED'
  | 'ABNORMAL'
  | 'FAILED'
  | 'NOT_FOUND'
  | 'PROCESSING'
  | 'AMOUNT_MISMATCH'
  | 'QUERY_FAILED'
  | 'SKIPPED'

export type RefundQuery = (outRefundNo: string) => Promise<RefundQueryResult>

/**
 * F3（修补轮）：finalizeRefundSuccess/markRefundAbnormal/markRefundClosed/markRefundFailed
 * 四个函数都是条件 updateMany，命中 0 行时静默返回（不改状态、不通知）——例如 ABNORMAL 行
 * 被再次查到仍是 ABNORMAL 时，markRefundAbnormal 的守卫（status in PENDING/PROCESSING）必不中。
 * 若 reconcileRefund 在这种「mark* 其实什么也没做」的情况下仍返回 SUCCESS/CLOSED/ABNORMAL/FAILED，
 * 调用方 reconcileStuckRefunds 会把它错记进 `advanced`（本轮状态推进条数）。
 * 这里在每次调用 mark* / finalize 之后重读一次 status：与函数开头读到的 refund.status 相同，
 * 说明没有真正推进，改报 'SKIPPED'。
 */
async function outcomeAfterMark(refundId: number, priorStatus: string, outcome: ReconcileOutcome): Promise<ReconcileOutcome> {
  const after = await prisma.refund.findUnique({ where: { id: refundId }, select: { status: true } })
  if (after && after.status === priorStatus) return 'SKIPPED'
  return outcome
}

/** ABNORMAL 行的复查间隔（分钟）：低频轮询兜住「店主在商户平台人工处理后微信回调也丢了」，不进 env */
const ABNORMAL_INTERVAL_MIN = 60
const ALERT_WINDOW_MS = 6 * 60 * 60 * 1000

export function defaultRefundQuery(): RefundQuery {
  return config.mock.pay ? mockQueryRefund : queryRefund
}

/**
 * 单笔补查。返回值语义见 ReconcileOutcome：调用方（reconcileStuckRefunds）按
 * SUCCESS/CLOSED/ABNORMAL/FAILED 之和统计「本轮状态推进条数」——但这四个结果只在
 * mark* / finalize 真正命中行（count>0）时才返回，命中 0 行（行早已是目标状态、
 * mark* 的守卫没通过，例如 ABNORMAL 行重查仍是 ABNORMAL）时改报 'SKIPPED'，
 * 不计入「本轮推进条数」（见 outcomeAfterMark）。
 */
export async function reconcileRefund(refundId: number, query: RefundQuery = defaultRefundQuery()): Promise<ReconcileOutcome> {
  const refund = await prisma.refund.findUnique({ where: { id: refundId } })
  if (!refund) return 'SKIPPED'
  if (!(ACTIVE_REFUND_STATUSES as readonly string[]).includes(refund.status)) return 'SKIPPED'

  // CAS 占坑：并发 tick / 手工触发撞心跳时只有一个能真正往下查，输的一方直接 SKIPPED
  const claimed = await prisma.refund.updateMany({
    where: { id: refundId, reconcileCheckedAt: refund.reconcileCheckedAt },
    data: { reconcileCheckedAt: new Date(), reconcileCount: { increment: 1 } },
  })
  if (claimed.count === 0) return 'SKIPPED'

  let result: RefundQueryResult
  try {
    result = await query(refund.outRefundNo)
  } catch (e) {
    const msg = (e as Error).message || String(e)
    await prisma.refund.update({ where: { id: refundId }, data: { reconcileLastError: msg.slice(0, 255) } })
    console.warn(`[refund-reconcile] 查询退款 ${refund.outRefundNo} 失败:`, msg)
    return 'QUERY_FAILED'
  }

  if (result.kind === 'not_found') {
    if (refund.status === 'PENDING') {
      // PENDING 且微信查无此单：发起阶段进程中断，微信侧根本没建单——唯一能释放 activeOrderId 的信号
      await markRefundFailed(refundId, 'RECONCILE_NOT_FOUND', '微信侧查无此退款单（发起阶段中断）')
      return outcomeAfterMark(refundId, refund.status, 'FAILED')
    }
    // PROCESSING 查无此单不合理（当初拿到过 refund_id）。2026-09-22 前只记录 + 告警、不改状态，
    // 结果这笔永远停在 PROCESSING：自动补查每 5 分钟查到同样结果，「退款待处理」按定义又不收它
    // （有在途退款），三处页面也不画重试按钮，而人工兜底接口已删——钱没退、单卡死、后台零入口。
    // 现在改成标 ABNORMAL：进「退款待处理」Tab 带「退款异常」提示、每 60 分钟低频复查、
    // markRefundAbnormal 自带告警与顾客通知；ABNORMAL 行再查到查无 → markRefundAbnormal 守卫不中，
    // 只更新 reconcileLastError，outcomeAfterMark 报 SKIPPED。
    await prisma.refund.update({ where: { id: refundId }, data: { reconcileLastError: '微信侧查无此退款单' } })
    notifySystemAlert(
      '退款补查：微信查无此单',
      [`订单 ${refund.orderNo}`, `退款单 ${refund.outRefundNo}`, '已标退款异常，请到微信商户平台核对退款记录'],
      { key: `refund-reconcile-notfound:${refundId}`, windowMs: ALERT_WINDOW_MS }
    )
    await markRefundAbnormal(refundId)
    return outcomeAfterMark(refundId, refund.status, 'ABNORMAL')
  }

  const r = result.refund
  if (r.amount && r.amount.refund !== refund.amount) {
    // 金额比对口径与 wechat-notify.ts 的回调金额校验一致：与本地记录的退款金额不符。
    // 同上（查无此单）：不再只记录，标 ABNORMAL 让它进「退款待处理」；金额不符是数据不一致，
    // 无论如何都得人去商户平台核对，自动落账反而危险。
    const msg = `金额不一致：微信侧 ${r.amount.refund} 本地 ${refund.amount}`
    await prisma.refund.update({ where: { id: refundId }, data: { reconcileLastError: msg } })
    notifySystemAlert('退款补查金额不一致', [`订单 ${refund.orderNo}`, `退款单 ${refund.outRefundNo}`, msg, '已标退款异常'], {
      key: `refund-reconcile-mismatch:${refundId}`,
      windowMs: ALERT_WINDOW_MS,
    })
    await markRefundAbnormal(refundId)
    return outcomeAfterMark(refundId, refund.status, 'ABNORMAL')
  }

  const rawData = JSON.stringify({ source: 'reconcile-query', ...r })
  switch (r.status) {
    case 'SUCCESS':
      // 不传 operator：会覆盖发起人；finalizeRefundSuccess 已具备幂等与互斥（见文件头注释）
      await finalizeRefundSuccess({
        refundId,
        wxRefundId: r.refund_id,
        successTime: r.success_time ? new Date(r.success_time) : new Date(),
        channel: r.channel,
        rawData,
        rawField: 'wxNotifyData',
      })
      return outcomeAfterMark(refundId, refund.status, 'SUCCESS')
    case 'CLOSED':
      await markRefundClosed(refundId, rawData)
      return outcomeAfterMark(refundId, refund.status, 'CLOSED')
    case 'ABNORMAL':
      await markRefundAbnormal(refundId, rawData)
      return outcomeAfterMark(refundId, refund.status, 'ABNORMAL')
    case 'PROCESSING':
    default:
      return 'PROCESSING'
  }
}

export interface ReconcileStuckOptions {
  afterMin?: number
  intervalMin?: number
  abnormalIntervalMin?: number
  alertAfter?: number
  batch?: number
  query?: RefundQuery
}

/**
 * 扫描范围：
 *  - PENDING/PROCESSING 且 createdAt < now-afterMin 且（从未查过 或 上次查过去 >= intervalMin）
 *  - ABNORMAL 且（从未查过 或 上次查过去 >= abnormalIntervalMin，默认 60 分钟）——
 *    ABNORMAL 占着 activeOrderId，店主在商户平台人工处理后微信会推 SUCCESS/CLOSED 回调，
 *    回调丢了同样卡死，低频轮询兜住。
 * 不按 mode 过滤：MOCK 退款从不停在 PROCESSING（见 refund.ts initiateRefund 的 MOCK 分支），
 * e2e/mock 场景下直插的行 mode 写 WECHAT，本函数只看 status。
 */
export async function reconcileStuckRefunds(opts: ReconcileStuckOptions = {}): Promise<number> {
  const afterMin = opts.afterMin ?? config.refundReconcile.afterMin
  const intervalMin = opts.intervalMin ?? config.refundReconcile.afterMin
  const abnormalIntervalMin = opts.abnormalIntervalMin ?? ABNORMAL_INTERVAL_MIN
  const alertAfter = opts.alertAfter ?? config.refundReconcile.alertAfter
  const batch = opts.batch ?? config.refundReconcile.batch
  const query = opts.query ?? defaultRefundQuery()

  const now = Date.now()
  const afterCutoff = new Date(now - afterMin * 60 * 1000)
  const intervalCutoff = new Date(now - intervalMin * 60 * 1000)
  const abnormalCutoff = new Date(now - abnormalIntervalMin * 60 * 1000)

  const rows = await prisma.refund.findMany({
    where: {
      OR: [
        {
          status: { in: ['PENDING', 'PROCESSING'] },
          createdAt: { lt: afterCutoff },
          OR: [{ reconcileCheckedAt: null }, { reconcileCheckedAt: { lt: intervalCutoff } }],
        },
        {
          status: 'ABNORMAL',
          OR: [{ reconcileCheckedAt: null }, { reconcileCheckedAt: { lt: abnormalCutoff } }],
        },
      ],
    },
    orderBy: { createdAt: 'asc' },
    take: batch,
    select: { id: true },
  })

  let advanced = 0
  for (const row of rows) {
    let outcome: ReconcileOutcome
    try {
      outcome = await reconcileRefund(row.id, query)
    } catch (e) {
      console.error(`[refund-reconcile] refund ${row.id} 处理失败:`, e)
      continue
    }
    if (outcome === 'SUCCESS' || outcome === 'CLOSED' || outcome === 'ABNORMAL' || outcome === 'FAILED') {
      advanced++
      continue
    }
    if (outcome !== 'PROCESSING' && outcome !== 'QUERY_FAILED') continue

    // 连续多轮没结果：告警。ABNORMAL 行不发（markRefundAbnormal 已经告警过，且本就要人工处理）。
    const fresh = await prisma.refund.findUnique({
      where: { id: row.id },
      select: { status: true, reconcileCount: true, outRefundNo: true, orderNo: true, amount: true, reconcileLastError: true },
    })
    if (!fresh || fresh.reconcileCount < alertAfter || !['PENDING', 'PROCESSING'].includes(fresh.status)) continue
    // 走到这里的 outcome 只可能是 'PROCESSING'（微信侧仍在处理）或 'QUERY_FAILED'（查询本身失败）；
    // 按本轮 outcome 判——而不是按 fresh.status（并发场景下行可能已被别的路径推成 SUCCESS 等
    // 终态，此时 fresh.status 已不是 'PROCESSING'，若仍按它判会把「查询失败」误报成「未到账」）。
    const detail = outcome === 'PROCESSING' ? '微信侧仍处理中' : `查询失败: ${fresh.reconcileLastError ?? ''}`
    notifySystemAlert(
      '退款长时间未到账',
      [
        `订单 ${fresh.orderNo}`,
        `退款单 ${fresh.outRefundNo} · ¥${(fresh.amount / 100).toFixed(2)}`,
        `已自动核对 ${fresh.reconcileCount} 次仍未成功（最近：${detail}）`,
        '可到微信商户平台查退款记录；系统会继续每 5 分钟核对，到账后自动变已退款',
      ],
      { key: `refund-reconcile-stuck:${row.id}`, windowMs: ALERT_WINDOW_MS }
    )
  }
  return advanced
}
