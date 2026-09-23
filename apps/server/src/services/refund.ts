/**
 * 退款业务公共逻辑：发起退款（admin 一键退款 / 售后审核 / 迟到支付自动退款共用）
 * 与 退款结果落库（同步返回 / 微信回调共用）。
 *
 * 金额规则：
 *  - 可退余额 remaining = order.actualAmount - order.refundedAmount
 *  - 0 < amount <= remaining；amount === remaining 视为「全额」（订单取消/退款流程），否则为「部分」（订单状态不变）
 *  - 同一订单同一时刻只能有一笔在途退款（Refund.activeOrderId 唯一索引），成功后释放，可再发起部分退款
 */
import crypto from 'crypto'
import { Prisma, Order, Refund } from '@prisma/client'
import prisma from '../utils/prisma'
import { AppError } from '../middlewares/error'
import { config } from '../config'
import { rollbackOrderStock } from '../utils/order-stock'
import { createRefund, getRefundNotifyUrl, validatePayConfig, WechatRefundError, RefundResult } from './wechat-pay'
import { hasRefundCreateDirective, mockCreateRefund } from './wechat-pay-mock'
import { notifyRefundResult } from './order-notify'
import { notifySystemAlert } from './notify'
import { sendRefundSubscribeMessage } from './subscribe-message'
import { DELIVERY_STATUS_LABEL } from './delivery/state'
import { BOOKING_STATUS_LABEL, BOOKING_ACTIVE } from './delivery/express-booking-state'
import { deductPointsOnRefund } from './member/points'
import { enqueueOrderTicket } from './ticket'

/** 在途态：占用 activeOrderId，阻止同一订单并发发起 */
export const ACTIVE_REFUND_STATUSES = ['PENDING', 'PROCESSING', 'ABNORMAL'] as const

/**
 * P3（2026-09-23）：只有微信「明确拒绝」才能标 FAILED，其余（超时、网络错误、5xx、
 * HTTP 2xx 但无 refund_id 之外的非 4xx 错误）都是「结果未知」——微信那边可能已经受理，
 * 本地却不知道，若直接标 FAILED，店员重试会生成新 outRefundNo，真的再退一次钱。
 * 判据：createRefund 只在「非 2xx 或响应体没有 refund_id」时才抛 WechatRefundError，
 * 4xx 是微信业务层面明确拒绝（参数错误/余额不足/频率限制等），5xx 是微信自身故障，
 * 与「请求都没发出去」的普通 Error 一样都算「不确定」。
 */
export function isDefiniteRefundRejection(e: unknown): e is WechatRefundError {
  return e instanceof WechatRefundError && e.httpStatus >= 400 && e.httpStatus < 500
}

/** R6：终态后又收到 SUCCESS 信号（疑似重复退款）的告警限频窗口，与补查告警同一个 6 小时口径 */
const LATE_SUCCESS_ALERT_WINDOW_MS = 6 * 60 * 60 * 1000

/** 不带幂等键：随机派生，行为与改动前完全一致 */
export function buildOutRefundNo(orderId: number): string {
  return `refund_${orderId}_${Date.now()}`
}

/**
 * 带幂等键：确定性派生，同一 (订单, 金额, 幂等键) 永远得到同一个 outRefundNo。
 * 落到 Refund.outRefundNo 唯一索引上，重试自然撞索引——复用的是微信侧同一笔退款，
 * 而不只是本进程内的一个 Promise（那道防线一旦换成多实例/进程重启就会失效）。
 * 金额进派生：改了金额提交就是另一笔退款，不该被上一次的结果顶掉。
 */
function buildIdempotentOutRefundNo(orderId: number, amount: number, idempotencyKey: string): string {
  const hash = crypto.createHash('sha256').update(`${orderId}:${amount}:${idempotencyKey}`).digest('hex').slice(0, 32)
  return `refidem_${orderId}_${hash}`
}

export function remainingRefundable(order: { actualAmount: number; refundedAmount: number }): number {
  return Math.max(0, order.actualAmount - order.refundedAmount)
}

/** 未出库态：全额退款时要把库存加回去 */
const STOCK_HELD_STATUSES = ['PAID', 'PREPARING'] as const
/** 已出库态：全额退款不回滚库存（货已交快递/已签收） */
const STOCK_RELEASED_STATUSES = ['SHIPPED', 'COMPLETED'] as const
/** 全额退款可进入的订单状态（REFUNDING 仅允许全额重试） */
const REFUNDABLE_STATUSES = [...STOCK_HELD_STATUSES, ...STOCK_RELEASED_STATUSES] as const

export interface InitiateRefundInput {
  orderId: number
  /** 本次退款金额（分） */
  amount: number
  reason?: string
  /** 记录到 Refund.operator：后台账号名 / 'system' */
  operator?: string
  afterSaleId?: number
  /**
   * 幂等键：同一 (orderId, amount, idempotencyKey) 派生同一个 outRefundNo。
   * 撞上 Refund.outRefundNo 唯一索引时直接复用已存在的那笔退款现状返回，不再二次调用微信。
   * 不传：outRefundNo 走原随机派生，行为与改动前完全一致。
   */
  idempotencyKey?: string
}

export interface InitiateRefundResult {
  order: Order
  refund: Refund
  mode: 'mock' | 'wechat'
  isFull: boolean
}

/**
 * 发起退款。抛 AppError（校验失败）或在微信发起失败时抛 AppError(50201)（明确拒绝，退款单已标
 * FAILED，可重试）/ AppError(50202)（结果未知，退款单保留 PENDING 占位，交自动补查核对，不可
 * 立即重试——见 isDefiniteRefundRejection）。
 */
export async function initiateRefund(input: InitiateRefundInput): Promise<InitiateRefundResult> {
  const { orderId, amount, reason, operator, afterSaleId, idempotencyKey } = input
  if (!Number.isInteger(amount) || amount <= 0) throw new AppError(42206, '退款金额必须为正整数（分）')

  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { items: true, payment: true, refunds: true },
  })
  if (!order) throw new AppError(40401, '订单不存在', 404)

  const remaining = remainingRefundable(order)
  if (remaining <= 0) throw new AppError(42206, '该订单已全额退款')
  if (amount > remaining) {
    throw new AppError(42206, `退款金额超过可退余额 ¥${(remaining / 100).toFixed(2)}`)
  }
  const isFull = amount === remaining

  const fromRefunding = order.status === 'REFUNDING'
  if (fromRefunding && !isFull) throw new AppError(42204, '退款中的订单只能全额退款')
  if (!fromRefunding && !(REFUNDABLE_STATUSES as readonly string[]).includes(order.status)) {
    throw new AppError(42204, `订单状态为 ${order.status}，不可退款`)
  }
  if (order.refunds.some((r) => (ACTIVE_REFUND_STATUSES as readonly string[]).includes(r.status))) {
    throw new AppError(42205, '该订单已有退款处理中')
  }
  // 42221：同城单有在途配送单先取消配送再退款（骑手在路上把钱退了 = 白送一单）。
  // 一处拦截覆盖全部 4 个 initiateRefund 调用点（admin 退款/顾客取消/售后同意/拒单）。
  if (order.deliveryType === 'LOCAL' && !['COMPLETED', 'REFUNDED'].includes(order.status)) {
    const activeDelivery = await prisma.delivery.findFirst({ where: { activeOrderId: orderId }, select: { status: true } })
    if (activeDelivery) {
      throw new AppError(42221, `该订单有在途配送单（${DELIVERY_STATUS_LABEL[activeDelivery.status] ?? activeDelivery.status}），请先取消配送再退款`)
    }
  }
  // 42263：邮寄单有活跃取件预约（快递员可能已在路上）先取消预约再退款——同 42221 的理由。
  // 只拦全额：部分退款不碰货、不动订单状态，放行。
  // status 必须限定活跃态（PENDING/BOOKED/ACCEPTED/UNKNOWN）——activeOrderId 在 PICKED 之后仍不清空
  // （只作双单防御用），不限定会把「已取件」的订单也拦住，导致 cancelBooking 救不回来
  // （cancelBooking 只接受 BOOKED/ACCEPTED，见 42267）。取件后走 §4.3「只走现有申请售后」。
  // PENDING 也要拦：bOrder 正在路上，此刻退款可能与一张即将成立的预约撞车；超 2 分钟可由店员作废后再退。
  if (isFull && order.deliveryType === 'EXPRESS' && !['COMPLETED', 'REFUNDED'].includes(order.status)) {
    const active = await prisma.expressBooking.findFirst({
      where: { activeOrderId: orderId, status: { in: [...BOOKING_ACTIVE, 'PENDING'] } },
      select: { status: true },
    })
    if (active) throw new AppError(42263, `该订单有取件预约（${BOOKING_STATUS_LABEL[active.status] ?? active.status}），请先取消预约再退款`)
  }
  if (!order.payment || order.payment.status !== 'SUCCESS') {
    throw new AppError(42207, '订单无成功支付记录，无法退款')
  }
  const mode = config.mock.pay ? 'MOCK' : 'WECHAT'
  if (mode === 'WECHAT' && (order.payment.paymentType === 'MOCK' || !order.payment.outTradeNo)) {
    throw new AppError(42207, '模拟支付订单无法发起微信退款')
  }

  const outRefundNo = idempotencyKey ? buildIdempotentOutRefundNo(orderId, amount, idempotencyKey) : buildOutRefundNo(orderId)

  // 事务 A：（全额）状态流转 + 库存回滚 + 创建退款记录（不含外呼）
  // 返回 isIdempotentHit=true 表示这不是新建的记录，而是命中了 outRefundNo 唯一索引复用回来的已有退款——
  // 调用方（下面）据此跳过「再发起一次微信退款/再跑一次 finalize」，直接把现状返回给上层。
  // R10：只在这次事务内真正把订单从「未在退款中」翻转成 REFUNDING 时才需要出 CANCEL 票——
  // 见下面 :127 分支末尾赋值为 true；命中幂等重放（isIdempotentHit）或订单本来就已经在
  // REFUNDING（fromRefunding，如「已 ABNORMAL/CLOSED 后重试」）都不重复出票。
  let cancelTicketDue = false
  const { refund, isIdempotentHit } = await prisma.$transaction(async (tx) => {
    if (isFull && !fromRefunding) {
      // where 里加 deliveries:{none:{activeOrderId:{not:null}}}：这是 callRider 那侧原子复核的另一半。
      // :82-87 的 42221 检查只是这段事务之外的快照，几毫秒内可能被 callRider 的 delivery.create 抢先——
      // 那笔创建会立刻占住 activeOrderId，让这里的 updateMany 天然匹配不上，两侧不可能同时得手。
      const guard = { id: orderId, deliveries: { none: { activeOrderId: { not: null } } } }
      const toRefunding: Prisma.OrderUpdateManyMutationInput = {
        status: 'REFUNDING',
        cancelledAt: new Date(),
        cancelReason: reason || '商家退款',
      }
      // 「要不要回滚库存」的判据必须来自这次 updateMany 真正命中的状态，而不是 :59 事务外读到的
      // order.status——那只是快照，另一位店员在这几十毫秒里点了发货，SHIPPED 照样落在白名单里被改成
      // REFUNDING，拿旧快照判断就会把已经交给快递的货再加回库存，后面按虚增库存接单就是超卖。
      // 所以分两步条件写：先按未出库态试，命中才回滚；没命中再按已出库态试，命中就不回滚。
      //
      // ⚠️ **已支付后的退款不释放任何会员权益**（masterplan P7）。这里刻意只回滚库存，
      // 一条不对称但是有意的边界，把它写下来是为了挡住将来「顺手补齐」的改动：
      //
      //   库存      回滚   ← 货还在货架上（含赠品行，order.items 天然含它们）
      //   销量      回滚   ← 同上，rollbackOrderStock 一并处理
      //   优惠券    不退   ← 一次核销就是用掉了。退了等于开出「用券下单再退单」的白嫖通道
      //   赠品积分  不退   ← 同上
      //   赠品名额  不回落 ← PO 2026-09-05 裁决（D3）：一次兑换永久占一个名额。
      //                     后台文案要写明「限量 N 份」是**发放**上限不是**送达**上限
      //
      // 「为什么库存都回了名额不回」是个会被反复问的问题，答案是二者防的不是同一件事：
      // 库存防的是超卖（货是实物，退了就该能再卖），名额防的是薅（下单即退就能占掉限量）。
      //
      // 释放只发生在 `PENDING_PAYMENT → CANCELLED`（spec §5.5），入口是
      // `services/member/checkout.ts` 的 `releaseOrderBenefits`，四条取消路径各自调用。
      // **退款路径一处都不该调它。**
      let moved = await tx.order.updateMany({ where: { ...guard, status: { in: [...STOCK_HELD_STATUSES] } }, data: toRefunding })
      if (moved.count === 1) {
        await rollbackOrderStock(tx, order.items)
      } else {
        moved = await tx.order.updateMany({ where: { ...guard, status: { in: [...STOCK_RELEASED_STATUSES] } }, data: toRefunding })
      }
      if (moved.count === 0) {
        // count 为 0 有两种原因，对店员的下一步动作完全不同，必须分辨清楚：
        // 状态已经变了（正常并发），或者有在途配送单刚刚抢先落库（呼叫骑手/自己送）。
        // 后一种情况文案要照抄 :85 的 42221 语义——引导店员先去取消配送，而不是简单地「刷新重试」。
        const activeDelivery = await tx.delivery.findFirst({ where: { activeOrderId: orderId }, select: { status: true } })
        if (activeDelivery) {
          throw new AppError(42221, `该订单有在途配送单（${DELIVERY_STATUS_LABEL[activeDelivery.status] ?? activeDelivery.status}），请先取消配送再退款`)
        }
        throw new AppError(42204, '订单状态已变化，请刷新后重试')
      }
      cancelTicketDue = true
    }
    try {
      const created = await tx.refund.create({
        data: {
          orderId,
          orderNo: order.orderNo,
          outTradeNo: order.payment!.outTradeNo,
          outRefundNo,
          amount,
          totalAmount: order.actualAmount,
          status: 'PENDING',
          mode,
          reason: reason ? reason.slice(0, 80) : null,
          operator: operator ?? null,
          afterSaleId: afterSaleId ?? null,
          activeOrderId: orderId,
        },
      })
      return { refund: created, isIdempotentHit: false }
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        // 带幂等键时 outRefundNo 是确定性派生的：撞索引大概率是同一 (订单, 金额, 幂等键) 的重试，
        // 命中的是 outRefundNo 唯一索引而非 activeOrderId 唯一索引——查一下就能分清，不必去猜
        // Prisma P2002 的 meta.target 长什么样（不同数据库/驱动版本格式并不稳定）。
        // 查到了：直接复用已有那笔的现状，调用方拿到「已经在处理/已完成」的语义，不再二次发起微信退款。
        // 查不到：说明真正撞的是 activeOrderId（同一订单另一笔不同幂等键/不带幂等键的退款并发在途），
        // 维持原有报错语义。
        if (idempotencyKey) {
          const existing = await tx.refund.findUnique({ where: { outRefundNo } })
          if (existing) return { refund: existing, isIdempotentHit: true }
        }
        throw new AppError(42205, '该订单已有退款处理中')
      }
      throw e
    }
  })

  // R10：CANCEL 出票挂在「决定退款」这一刻（订单事务内翻转成 REFUNDING 成功提交），而不是
  // 挂在「钱真的退到」（finalizeRefundSuccess 里 flippedToRefunded 那次）——后面走 WECHAT
  // 分支若同步返回 ABNORMAL（用户账户异常，需商户平台人工处理，可能拖几天）或 CLOSED（退款关闭），
  // 订单会停在 REFUNDING 但 finalizeRefundSuccess 永远不会被调用，那条路径下 CANCEL 票一辈子不出、
  // 厨房继续照做。这里出的这次与 finalizeRefundSuccess 出的那次共用 dedupeKey(seq=0)，
  // 天然去重：MOCK 模式或 WECHAT 同步 SUCCESS 时两次都会尝试入队，只落一条。
  // 必须在事务外、fire-and-forget：enqueueOrderTicket 用全局 prisma 且有外呼（飞鹅），
  // 不能让打印异常影响/回滚退款事务，也不能抱着 order 行锁打印。
  if (cancelTicketDue) {
    enqueueOrderTicket(orderId, 'CANCEL').catch((err) => {
      console.error('[refund] enqueueOrderTicket 失败（initiateRefund 转 REFUNDING）:', (err as Error).message)
    })
  }

  if (isIdempotentHit) {
    const reloaded = await reload(orderId, refund.id)
    return { ...reloaded, mode: refund.mode === 'MOCK' ? 'mock' : 'wechat', isFull }
  }

  // T1：mock 模式下若排了 createRefund 指令，走「模拟微信」路径（同步返回/异常都可控），
  // 用于覆盖 P2/P3 的 e2e 场景；没排指令时 simulateWechat 恒为 false，下面这块与改动前逐字节一致。
  const simulateWechat = mode === 'MOCK' && hasRefundCreateDirective(orderId)
  if (mode === 'MOCK' && !simulateWechat) {
    await finalizeRefundSuccess({ refundId: refund.id, operator })
    return { ...(await reload(orderId, refund.id)), mode: 'mock', isFull }
  }

  if (!simulateWechat) validatePayConfig()
  const create = simulateWechat
    ? (p: Parameters<typeof createRefund>[0]) => mockCreateRefund(orderId, p)
    : createRefund

  // P3：try 只包这一句外呼。抛错时先分类：微信明确拒绝（4xx 业务错误）才标 FAILED 可重试；
  // 其余（超时/网络错误/5xx/mock 的 error 指令）一律「结果未知」，行留在 PENDING 交补查，
  // 绝不能标 FAILED——那会让店员重试生成新 outRefundNo，而微信那边可能已经把钱退出去了。
  let result: RefundResult
  try {
    result = await create({
      outTradeNo: order.payment.outTradeNo!,
      outRefundNo: refund.outRefundNo,
      amount,
      total: order.actualAmount,
      reason: reason || undefined,
      notifyUrl: getRefundNotifyUrl(),
    })
  } catch (e) {
    if (isDefiniteRefundRejection(e)) {
      const code = e.code
      const message = e.message || '微信退款请求失败'
      await markRefundFailed(refund.id, code, message)
      // 全额：订单保持 REFUNDING（库存已回滚、商家已决定退），后台可重试；部分：订单未变，可重新发起
      throw new AppError(50201, `微信退款发起失败：${message}`, 502)
    }
    const code = e instanceof WechatRefundError ? e.code : 'REQUEST_ERROR'
    const message = (e as Error).message || '微信退款请求失败'
    // 不改 status（行仍是 PENDING，占位保留），只记录错误信息供补查/人工核对参考。
    await prisma.refund.updateMany({
      where: { id: refund.id, status: 'PENDING' },
      data: { errorCode: `UNCERTAIN_${code}`.slice(0, 64), errorMessage: message.slice(0, 255) },
    })
    notifySystemAlert(
      '微信退款结果未知，系统将自动核对',
      [`订单 ${order.orderNo}`, `金额 ¥${(amount / 100).toFixed(2)}`, `${code}: ${message}`, '5 分钟后开始每 5 分钟向微信查询；查无此单会自动释放并可重试，请勿在商户平台重复退款'],
      { key: `refund-uncertain:${refund.id}` }
    )
    throw new AppError(50202, `微信退款结果未知：${message}。退款单已保留，系统将自动向微信核对，请勿重复发起`, 502)
  }

  // P2：条件写（status 必须仍是 PENDING 才落 PROCESSING）。输掉的一方（回调已抢先把行推进到
  // 别的状态）只补写 wxResponseData，绝不再 dispatch 下面的 finalize/mark*——那会把已经翻过去
  // 的行错误地拽回来（详见文件头状态写者表 / plan.md §3）。
  try {
    const moved = await prisma.refund.updateMany({
      where: { id: refund.id, status: 'PENDING' },
      data: {
        wxRefundId: result.refund_id,
        status: 'PROCESSING',
        channel: result.channel ?? null,
        wxResponseData: JSON.stringify(result),
      },
    })
    if (moved.count === 0) {
      await prisma.refund.update({ where: { id: refund.id }, data: { wxResponseData: JSON.stringify(result) } })
      console.info(`[refund] 同步回写落空（refund ${refund.id}）：回调已抢先推进状态，跳过 dispatch`)
    } else if (result.status === 'SUCCESS') {
      await finalizeRefundSuccess({
        refundId: refund.id,
        wxRefundId: result.refund_id,
        successTime: result.success_time ? new Date(result.success_time) : new Date(),
        channel: result.channel,
      })
    } else if (result.status === 'ABNORMAL') {
      await markRefundAbnormal(refund.id)
    } else if (result.status === 'CLOSED') {
      await markRefundClosed(refund.id)
    }
  } catch (e) {
    // 微信已受理退款（result 已拿到），但本地落库/后续处理抛错：行留在 PENDING/PROCESSING 交补查，
    // 不能标 FAILED（钱可能已经退出去了）。
    const message = (e as Error).message || String(e)
    notifySystemAlert('微信已受理退款，本地记录失败', [`订单 ${order.orderNo}`, `退款单 ${refund.outRefundNo}`, message], {
      key: `refund-local-fail:${refund.id}`,
    })
    throw new AppError(50202, `微信已受理退款，但本地记录失败：${message}，系统将自动核对`, 502)
  }

  return { ...(await reload(orderId, refund.id)), mode: mode === 'MOCK' ? 'mock' : 'wechat', isFull }
}

async function reload(orderId: number, refundId: number): Promise<{ order: Order; refund: Refund }> {
  const [order, refund] = await Promise.all([
    prisma.order.findUniqueOrThrow({ where: { id: orderId } }),
    prisma.refund.findUniqueOrThrow({ where: { id: refundId } }),
  ])
  return { order, refund }
}

interface FinalizeInput {
  refundId: number
  wxRefundId?: string | null
  successTime?: Date | null
  channel?: string | null
  rawData?: string | null
  rawField?: 'wxResponseData' | 'wxNotifyData'
  operator?: string
  /**
   * P1 人工出口专用：只允许从这个状态翻到 SUCCESS（而不是默认的「非 SUCCESS 皆可」）。
   * 目前只传 'ABNORMAL'——人工核实只对「退款异常」行开放，条件写的守卫即接口层权限之外的
   * 第二道防线（谁先拿到锁谁赢，与回调/补查完全同一套互斥）。
   */
  expectStatus?: 'ABNORMAL'
  /**
   * P1+D2 人工出口专用：微信实际退款金额与本地记录不同时，按此金额落账（0 < amountOverride <=
   * 可退余额，由调用方——resolve-abnormal 路由——校验后传入）。不传则用 refund.amount。
   */
  amountOverride?: number
  /** P1 人工出口留痕：操作人 / 说明 / 时间，写入 manualResolvedBy/manualResolveNote/manualResolvedAt 三列 */
  manual?: { by: string; note: string; at: Date }
}

/**
 * 退款成功落库：refund→SUCCESS（释放 activeOrderId）、order.refundedAmount 累加；
 * 累计退完全款时 order REFUNDING→REFUNDED、payment→REFUNDED；关联售后单→DONE。
 * 幂等：非 SUCCESS→SUCCESS 用条件写 + count 判定，只有翻转成功的那一次才做后续副作用。
 * 成功后 fire-and-forget 通知员工 + 顾客订阅消息。
 * 返回 {applied}：人工出口（resolve-abnormal 路由）据此把「输了」诚实地报成 42204，而不是 200。
 */
export async function finalizeRefundSuccess(input: FinalizeInput): Promise<{ applied: boolean }> {
  const result = await prisma.$transaction(async (tx) => {
    // R3：两条锁定读（FOR UPDATE）必须是事务的第一、二句，不能让普通读（如下面注释掉的
    // `tx.refund.findUnique`）打头。InnoDB RR 隔离下，一个事务里第一条访问该行的语句——
    // 不论是普通 SELECT 还是 FOR UPDATE——就会创建这个事务的 read view；普通读创建的
    // read view 看不到「创建之后才提交」的数据，而 FOR UPDATE 是锁定读，不创建 read view，
    // 之后同一事务里的普通读会自动读到「拿锁那一刻」之后的最新已提交数据。
    // H1 只在 settlePoints 那侧把 `SELECT ... FOR UPDATE` 放到了第一句，这里（退款侧）当时仍是
    // `tx.refund.findUnique` 打头——普通读固化了 read view，事务走到几十行之后才靠
    // `UPDATE orders SET refunded_amount=LEAST(...)` 隐式拿到 orders 行锁，但这时 read view
    // 已经定格在锁之前。deductPointsOnRefund 里 `tx.user.findUniqueOrThrow` 读到的
    // pointsBalance 就可能是并发 settlePoints 提交之前的旧快照（典型：settlePoints 前脚发了分
    // 还没提交，本事务后脚发起），calcRefundDeduct 拿旧余额封顶，算出 0——退款全额退掉、
    // 积分一分没扣，永久留账；deductFromEarnRows 同理会因为看不到新建的 EARN 行而扣错行。
    // 修法：把 refunds→orders 两条锁定读提到最前面，加锁顺序与 initiateRefund 里
    // order（updateMany，隐式行锁）→ refund（create，新建行不持有已有行的锁）不构成反向环，
    // 不会死锁；也与 settlePoints 的 orders→points_ledgers→users 顺序一致。
    const locked = await tx.$queryRaw<{ order_id: number }[]>`SELECT order_id FROM refunds WHERE id = ${input.refundId} FOR UPDATE`
    if (locked.length === 0) return null
    await tx.$queryRaw`SELECT id FROM orders WHERE id = ${locked[0].order_id} FOR UPDATE`

    const refund = await tx.refund.findUnique({ where: { id: input.refundId } })
    if (!refund) return null

    // P1+D2：人工核实成功、微信实退金额与本地记录不同时，按 amountOverride 落账（校验放在
    // 这里而不是路由层：必须在拿到锁之后用最新的 order 快照算 remaining，路由层校验的是
    // 请求发起那一刻的快照，事务外校验通过后行可能已被别的路径推进）。
    const effectiveAmount = input.amountOverride ?? refund.amount
    if (input.amountOverride !== undefined) {
      const orderBefore = await tx.order.findUniqueOrThrow({ where: { id: refund.orderId } })
      const remaining = remainingRefundable(orderBefore)
      if (effectiveAmount <= 0 || effectiveAmount > remaining) {
        throw new AppError(42206, `实退金额超过可退余额 ¥${(remaining / 100).toFixed(2)}`)
      }
      // R4（裁决 plan.md §8，2026-09-23）：订单不在 REFUNDING 时，实退金额必须严格小于可退余额，
      // 不能把余额一次退空——initiateRefund:96 把「amount === remaining」定义为「全额」并先把订单
      // 翻成 REFUNDING，部分退款行的 amount 恒 < remaining；D2 的人工 override 是第一个能让「部分
      // 退款行」累加到 actual_amount 上限的写者。一次退空会让 refundedAmount=actualAmount、
      // payment 翻 REFUNDED，但订单仍停在 PAID/SHIPPED（finalize 只把 REFUNDING 翻成
      // REFUNDED）——可接单发货、库存不回滚、无 CANCEL 票、不进「退款待处理」，是一个隐蔽的
      // 状态不一致。真要把这类单的余额退空，需要走完整的「转 REFUNDED + 未出库回滚库存」流程
      // （超出本批，见 plan.md §7「D2 补充」）。
      if (orderBefore.status !== 'REFUNDING' && effectiveAmount >= remaining) {
        throw new AppError(
          42206,
          `实退金额等于全部可退余额，但订单不在退款中（当前 ${orderBefore.status}）；部分退款行不能把余额一次退空`
        )
      }
    }

    const successTime = input.successTime ?? new Date()
    const data: Prisma.RefundUpdateManyMutationInput = {
      status: 'SUCCESS',
      successTime,
      activeOrderId: null,
    }
    if (input.wxRefundId) data.wxRefundId = input.wxRefundId
    if (input.channel) data.channel = input.channel
    if (input.rawData) data[input.rawField ?? 'wxNotifyData'] = input.rawData
    if (input.operator) data.operator = input.operator
    if (input.amountOverride !== undefined) data.amount = input.amountOverride
    if (input.manual) {
      data.manualResolvedBy = input.manual.by
      data.manualResolvedAt = input.manual.at
      data.manualResolveNote = input.manual.note.slice(0, 120)
    }
    // 上面那次 findUnique 在 MySQL RR 下是快照读、不加锁，不能拿它做幂等依据：
    // 微信回调重推 / 回调与人工标记撞车时两边都会读到「未成功」，各自 increment 一次 refundedAmount。
    // 改成条件写：同一行只有一个调用能把 status 翻成 SUCCESS，输掉的那个 count=0 直接退出。
    // 人工出口（input.expectStatus='ABNORMAL'）收窄守卫：只允许从 ABNORMAL 翻；回调/补查的默认
    // 守卫是「仍在途」（R6，2026-09-23 裁决收紧：原先是「非 SUCCESS 皆可」，会把 CLOSED/FAILED
    // 两个终态也当成可翻转——见下方 count=0 分支的「疑似重复退款」处理）。
    const moved = await tx.refund.updateMany({
      where: { id: refund.id, status: input.expectStatus ?? { in: [...ACTIVE_REFUND_STATUSES] } },
      data,
    })
    if (moved.count === 0) {
      // R6：CLOSED/FAILED 都是终态，同一 out_refund_no 不会再变 SUCCESS——本地终态后又收到微信
      // SUCCESS 信号（回调晚到、或人工 D1 转 CLOSED 后重新发起了新一笔，原笔的回调才追上来），
      // 是「疑似重复退款」的信号，不能像「已是 SUCCESS」（真正的幂等重推）那样完全静默：留痕 +
      // 告警，但仍不触碰 refundedAmount / 积分 / 出票（那些只属于「真正翻转成功」的这一次）。
      // 只在「非人工路径」（expectStatus 未传）时判断——人工路径的 count=0 就是「行已不是
      // ABNORMAL」，那是 P1 一开始就要覆盖的正常「输了」场景，不是这里说的重复退款信号。
      let lateSuccess = false
      if (!input.expectStatus && (refund.status === 'CLOSED' || refund.status === 'FAILED')) {
        const lateData: Prisma.RefundUpdateManyMutationInput = { reconcileLastError: '终态后收到微信 SUCCESS 信号，疑似重复退款' }
        if (input.rawData) lateData[input.rawField ?? 'wxNotifyData'] = input.rawData
        await tx.refund.updateMany({ where: { id: refund.id, status: { in: ['CLOSED', 'FAILED'] } }, data: lateData })
        lateSuccess = true
      }
      return { refund, alreadyDone: true, lateSuccess }
    }
    const updated = await tx.refund.findUniqueOrThrow({ where: { id: refund.id } })

    // increment 但以 actualAmount 封顶：事前校验（initiateRefund）本应保证不会超，但这里不依赖它单独兜底——
    // LEAST(...) 是一条原子语句，比「事务内重读 + CAS + 写绝对值」更简单，也没有那套方案在
    // increment 语义下会引入的重试循环（人工补记路径写的是绝对值，语义不同，不能照抄）。
    // 用 tx.$executeRaw 而非 prisma.$executeRaw，否则会脱离当前事务。用 effectiveAmount（而非
    // refund.amount）累加，覆盖人工出口按实退金额落账（≠原记录）的情形。
    await tx.$executeRaw`UPDATE orders SET refunded_amount = LEAST(refunded_amount + ${effectiveAmount}, actual_amount) WHERE id = ${refund.orderId}`
    const order = await tx.order.findUniqueOrThrow({ where: { id: refund.orderId } })
    // B1：CANCEL 出票下沉到这里——「翻转成 REFUNDED」这一刻覆盖后台一键退款/售后同意/顾客自助取消/
    // 拒单等全部入口，不再依赖各调用点各自记得补一次。flippedToRefunded 只在本次 updateMany 真正
    // 命中时为 true（并发/已经翻转过不算），事务提交后才会真的出票，见函数末尾。
    let flippedToRefunded = false
    if (order.refundedAmount >= order.actualAmount) {
      const moved = await tx.order.updateMany({
        where: { id: refund.orderId, status: 'REFUNDING' },
        data: { status: 'REFUNDED', refundedAt: successTime },
      })
      flippedToRefunded = moved.count === 1
      await tx.payment.updateMany({
        where: { orderId: refund.orderId },
        data: { status: 'REFUNDED' },
      })
    }
    if (refund.afterSaleId) {
      await tx.afterSale.updateMany({
        where: { id: refund.afterSaleId, status: { in: ['PENDING', 'APPROVED'] } },
        data: { status: 'DONE', refundId: refund.id, handledAt: new Date() },
      })
    } else {
      // D3（2026-09-23 A）：这笔退款不是从售后面板发起（没带 afterSaleId），但订单上若有
      // APPROVED 的售后单，一并置 DONE——否则店员从订单页「再退款」把这单收口后，售后单永远
      // 挂在 APPROVED、订单永远占着「退款待处理」、顾客永远 42208 不能再申请售后。
      await tx.afterSale.updateMany({
        where: { orderId: refund.orderId, status: 'APPROVED' },
        data: { status: 'DONE', refundId: refund.id, handledAt: new Date() },
      })
    }
    // 积分扣回必须在同一事务内：退款成功但扣回失败会留下「钱退了、分没扣」的不一致，
    // 且这里没有第二次机会重跑（不像 settlePoints 有兜底任务）。用 order（上面刚查出的最新快照，
    // 已含本次累加后的 refundedAmount）而不是函数入参之外读到的旧订单对象。
    await deductPointsOnRefund(
      tx,
      {
        id: order.id, userId: order.userId, orderNo: order.orderNo, pointsEarned: order.pointsEarned,
        pointsBase: order.pointsBase, actualAmount: order.actualAmount, refundedAmount: order.refundedAmount,
      },
      { id: refund.id, amount: effectiveAmount }
    )
    return { refund: updated, alreadyDone: false, flippedToRefunded }
  })

  if (!result || result.alreadyDone) {
    if (result?.lateSuccess) {
      notifySystemAlert(
        '退款终态后收到成功信号（疑似重复退款）',
        [`订单 ${result.refund.orderNo}`, `退款单 ${result.refund.outRefundNo}`, `本地状态 ${result.refund.status}`, '请到微信商户平台核对该单是否被退了两次'],
        { key: `refund-late-success:${result.refund.id}`, windowMs: LATE_SUCCESS_ALERT_WINDOW_MS }
      )
    }
    return { applied: false }
  }
  prisma.order
    .findUnique({
      where: { id: result.refund.orderId },
      include: { user: { select: { openid: true } }, items: { select: { productName: true }, take: 1 } },
    })
    .then((order) => {
      if (!order) return
      notifyRefundResult(order, result.refund, 'SUCCESS')
      sendRefundSubscribeMessage(order.user.openid, order, result.refund, order.items[0]?.productName)
    })
    .catch(() => undefined)

  // B1：出票必须在事务外——enqueueOrderTicket 用全局 prisma 且会做最长 10s 的外呼（飞鹅），
  // 放事务内等于抱着 order 行锁打飞鹅，会把 finalizeRefundSuccess 的其它并发调用方（包括
  // settlePoints 的 SELECT ... FOR UPDATE）一起拖住。fire-and-forget，不影响退款结果——
  // 钱已经在微信那边退出去了，出票失败只是少一张纸，不该让退款流程感知。
  // 只在这次真正把订单翻转成 REFUNDED 时出票：部分退款不出（B1-3），已经翻转过的重复调用不再出
  // （dedupeKey seq=0 天然幂等兜底，这里提前判断只是少发一次无意义的调用）。
  if (result.flippedToRefunded) {
    enqueueOrderTicket(result.refund.orderId, 'CANCEL').catch((err) => {
      console.error('[refund] enqueueOrderTicket 失败（finalizeRefundSuccess 转 REFUNDED）:', (err as Error).message)
    })
  }
  return { applied: true }
}

/**
 * 微信返回 ABNORMAL：退款异常（如用户账户异常），需商户平台手动处理；保留在途占位防重复发起。
 * 守卫理由：补查/回调/initiateRefund 同步分支可能与另一路径同时到——若这一刻该行已被推进到
 * SUCCESS（钱已经退成功、activeOrderId 已释放、refundedAmount 已累加），无条件写会把它错误地
 * 改回 ABNORMAL，界面显示未成功但账其实已经对平。条件写只允许从「在途未 ABNORMAL」翻到
 * ABNORMAL；count=0（已是 ABNORMAL，或已被别的路径推到终态）直接返回，不通知不告警——
 * 回调重推 ABNORMAL（同一封回调网络重试/微信侧重投）时这里与改动前不同：改动前会在 5 分钟
 * 告警窗口外重复告警，改动后 count=0 时完全不告警（守卫挡在告警之前），因为「已经是 ABNORMAL」
 * 不是新信息。initiateRefund 的同步 ABNORMAL 分支调用本函数时该行必然是 PROCESSING
 * （统筹裁定：那里已改成只预写 PROCESSING，不再直接写终态，见 :268-276 与其注释），守卫必中。
 */
export async function markRefundAbnormal(refundId: number, rawData?: string): Promise<void> {
  const moved = await prisma.refund.updateMany({
    where: { id: refundId, status: { in: ['PENDING', 'PROCESSING'] } },
    data: { status: 'ABNORMAL', ...(rawData ? { wxNotifyData: rawData } : {}) },
  })
  if (moved.count === 0) return
  const refund = await prisma.refund.findUniqueOrThrow({ where: { id: refundId } })
  const order = await prisma.order.findUnique({ where: { id: refund.orderId } })
  if (order) notifyRefundResult(order, refund, 'ABNORMAL')
  notifySystemAlert('微信退款异常', [`订单 ${refund.orderNo}`, `退款单 ${refund.outRefundNo}`, '需到微信商户平台手动处理'], {
    key: `refund-abnormal:${refund.id}`,
  })
}

/**
 * 微信返回 CLOSED：退款关闭（未退成功），释放在途占位供重试。
 * 守卫理由同 markRefundAbnormal：已到 SUCCESS 的行不得被改回 CLOSED。条件写覆盖全部在途态
 * （PENDING/PROCESSING/ABNORMAL——ABNORMAL 行商户平台人工处理后微信可能推 CLOSED）。
 * initiateRefund 的同步 CLOSED 分支调用本函数时该行必然是 PROCESSING，守卫必中（同上）。
 */
export async function markRefundClosed(
  refundId: number,
  rawData?: string,
  opts?: { expectStatus?: 'ABNORMAL'; manual?: { by: string; note: string; at: Date } }
): Promise<{ applied: boolean }> {
  const moved = await prisma.refund.updateMany({
    where: { id: refundId, status: opts?.expectStatus ?? { in: ACTIVE_REFUND_STATUSES as unknown as string[] } },
    data: {
      status: 'CLOSED',
      activeOrderId: null,
      ...(rawData ? { wxNotifyData: rawData } : {}),
      ...(opts?.manual
        ? { manualResolvedBy: opts.manual.by, manualResolvedAt: opts.manual.at, manualResolveNote: opts.manual.note.slice(0, 120) }
        : {}),
    },
  })
  if (moved.count === 0) return { applied: false }
  const refund = await prisma.refund.findUniqueOrThrow({ where: { id: refundId } })
  const order = await prisma.order.findUnique({ where: { id: refund.orderId } })
  if (order) notifyRefundResult(order, refund, 'CLOSED')
  notifySystemAlert('微信退款已关闭', [`订单 ${refund.orderNo}`, `退款单 ${refund.outRefundNo}`, '可在后台重试退款'], {
    key: `refund-closed:${refund.id}`,
  })
  return { applied: true }
}

/**
 * 发起阶段失败：释放在途占位，记录错误。
 * 守卫收窄为仅 PENDING（P3，2026-09-23）：PROCESSING 说明已经拿到 refund_id（微信已受理），
 * 结局只能是 SUCCESS/CLOSED/ABNORMAL，不该再被标 FAILED——那意味着「钱可能已经退了，
 * 但本地却说发起失败可以重试」，店员重试会生成新 outRefundNo 真的再退一次。
 * 补查的「PENDING 查无此单 → FAILED」路径本就只对 PENDING 生效；initiateRefund 的
 * isDefiniteRefundRejection 分支调用本函数时行必然是 PENDING（createRefund 已抛错，
 * 那句之后的条件写从未执行到），守卫必中。
 */
export async function markRefundFailed(refundId: number, errorCode: string, errorMessage: string): Promise<void> {
  const moved = await prisma.refund.updateMany({
    where: { id: refundId, status: 'PENDING' },
    data: {
      status: 'FAILED',
      activeOrderId: null,
      errorCode: errorCode.slice(0, 64),
      errorMessage: errorMessage.slice(0, 255),
    },
  })
  if (moved.count === 0) return
  const refund = await prisma.refund.findUniqueOrThrow({ where: { id: refundId } })
  notifySystemAlert('微信退款发起失败', [`订单 ${refund.orderNo}`, `金额 ¥${(refund.amount / 100).toFixed(2)}`, `${errorCode}: ${errorMessage}`], {
    key: `refund-failed:${refund.orderId}`,
  })
}
