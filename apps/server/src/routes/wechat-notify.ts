import { Request, Response } from 'express'
import prisma from '../utils/prisma'
import { decryptNotifyResource } from '../services/wechat-pay'
import { verifyWechatNotify, hasVerifyMaterial } from '../services/wechat-pay-verify'
import { notifyOrderPaid } from '../services/order-notify'
import { notifySystemAlert } from '../services/notify'
import { finalizeRefundSuccess, initiateRefund, markRefundAbnormal, markRefundClosed } from '../services/refund'
import { AppError } from '../middlewares/error'
import { config } from '../config'
import { sendPaidSubscribeMessage } from '../services/subscribe-message'
import { enqueueOrderTicket } from '../services/ticket'
import { getLocalSettings } from '../services/local-settings'
import { pickupSlotLabel } from '../services/pickup'
// 别名避免与下方本地变量 slotLabel（自取时段文案）同名冲突
import { slotLabel as computeScheduleSlotLabel } from '../services/slots'

interface NotifyBody {
  event_type?: string
  resource?: {
    algorithm?: string
    ciphertext?: string
    associated_data?: string
    nonce?: string
  }
}

interface TransactionResult {
  out_trade_no: string
  transaction_id: string
  trade_state: string
  amount?: { total: number }
  success_time?: string
}

interface RefundNotifyResult {
  out_trade_no: string
  transaction_id?: string
  out_refund_no: string
  refund_id: string
  refund_status: 'SUCCESS' | 'CLOSED' | 'ABNORMAL'
  success_time?: string
  user_received_account?: string
  amount?: { total: number; refund: number; payer_total?: number; payer_refund?: number }
}

// 金额不一致属于严重异常（串单/篡改），单独标识以便返回 FAIL 并人工介入
class AmountMismatchError extends Error {}

function replyOk(res: Response) {
  res.json({ code: 'SUCCESS', message: '成功' })
}

function replyFail(res: Response, message: string) {
  res.status(400).json({ code: 'FAIL', message })
}

/**
 * 回调公共解析：验签 → JSON → 事件过滤 → 解密 resource → JSON。
 * 返回 null 表示已向微信作答（ack 或 fail），调用方直接 return。
 */
async function parseNotify<T>(
  req: Request,
  res: Response,
  expectedEvents: string[],
  label: string
): Promise<{ event: string; data: T; rawBody: string } | null> {
  const rawBody: string = req.body as string

  if (hasVerifyMaterial() || config.isProduction) {
    const verified = await verifyWechatNotify(req.headers, rawBody)
    if (!verified.ok) {
      console.error(`[${label}] 验签失败: ${verified.reason}`)
      replyFail(res, verified.reason)
      return null
    }
  } else {
    console.warn(`[${label}] 未配置验签材料，跳过验签（仅开发环境）`)
  }

  let body: NotifyBody
  try {
    body = JSON.parse(rawBody) as NotifyBody
  } catch {
    replyFail(res, '请求体解析失败')
    return null
  }

  const event = body.event_type ?? ''
  if (!expectedEvents.includes(event)) {
    // 非关注事件 — ack 并忽略
    replyOk(res)
    return null
  }

  const resource = body.resource
  if (!resource?.ciphertext || !resource.nonce) {
    replyFail(res, '缺少加密资源')
    return null
  }

  const apiV3Key = process.env.WECHAT_PAY_API_V3_KEY
  if (!apiV3Key) {
    console.error(`[${label}] WECHAT_PAY_API_V3_KEY not set`)
    replyFail(res, '服务配置错误')
    return null
  }

  try {
    const plaintext = decryptNotifyResource(
      resource.ciphertext,
      resource.associated_data ?? '',
      resource.nonce,
      apiV3Key
    )
    return { event, data: JSON.parse(plaintext) as T, rawBody }
  } catch (err) {
    console.error(`[${label}] decrypt error:`, err)
    replyFail(res, '解密失败')
    return null
  }
}

// POST /api/wechat/pay/notify
// Mounted in app.ts BEFORE express.json() with express.text({ type: '*/*' })
export async function wechatPayNotifyHandler(req: Request, res: Response): Promise<void> {
  const parsed = await parseNotify<TransactionResult>(req, res, ['TRANSACTION.SUCCESS'], 'wechat-notify')
  if (!parsed) return
  const { data: transaction, rawBody } = parsed

  if (transaction.trade_state !== 'SUCCESS') {
    replyOk(res)
    return
  }

  // out_trade_no format: order_${orderId}_${timestamp}
  const match = transaction.out_trade_no.match(/^order_(\d+)_\d+$/)
  if (!match) {
    console.error('[wechat-notify] unrecognised out_trade_no:', transaction.out_trade_no)
    replyOk(res)
    return
  }
  const orderId = Number(match[1])

  // 订单已取消（超时/用户取消）却收到付款成功：钱已扣，必须记账并自动原路退回，绝不静默吞掉
  let lateCancelled: { orderNo: string; actualAmount: number } | null = null
  try {
    await prisma.$transaction(async (tx) => {
      const order = await tx.order.findUnique({
        where: { id: orderId },
        include: { payment: true },
      })
      if (!order) return

      // Idempotent: already paid (or moved on)
      if (order.status !== 'PENDING_PAYMENT' && order.status !== 'CANCELLED') return

      // 金额比对：回调金额必须与订单实付金额（分）一致，否则拒绝处理
      if (!transaction.amount || transaction.amount.total !== order.actualAmount) {
        throw new AmountMismatchError(
          `orderNo=${order.orderNo} 回调金额=${transaction.amount?.total ?? 'N/A'} 订单实付=${order.actualAmount}`
        )
      }

      const paidAt = transaction.success_time ? new Date(transaction.success_time) : new Date()
      const wasCancelled = order.status === 'CANCELLED'

      await tx.payment.upsert({
        where: { orderId },
        update: {
          outTradeNo: transaction.out_trade_no,
          status: 'SUCCESS',
          wxTransactionId: transaction.transaction_id,
          wxNotifyData: rawBody,
          paidAt,
        },
        create: {
          orderId,
          orderNo: order.orderNo,
          outTradeNo: transaction.out_trade_no,
          paymentType: 'WECHAT',
          amount: order.actualAmount,
          status: 'SUCCESS',
          wxTransactionId: transaction.transaction_id,
          wxNotifyData: rawBody,
          paidAt,
        },
      })

      // ⚠️ 下面两处必须是**条件写 + 判 count**，不能用 `update({ where: { id } })`。
      //
      // 上面那次 findUnique 在 MySQL RR 下是快照读、不加锁（与 refund.ts:344 同一条规则，
      // 仓库里其余七处订单状态流转都遵守它，这里曾是唯一的例外）。
      // 无守卫写会踩这条竞态：
      //
      //   ① 回调事务在 :143 读到 PENDING_PAYMENT，算出 wasCancelled=false
      //   ② 在 payment.upsert 与下面这次写之间，另一条取消路径提交
      //      （顾客自助取消 / cancelExpiredOrders / 管理员取消 / 拒单待付款分支）：
      //      status→CANCELLED，并且**已经执行了 releaseOrderBenefits**
      //      ——券翻回 UNUSED 且 orderId 置空、赠品积分以 GIFT_REVERT 退回余额、
      //        赠品名额 issuedCount 减回、库存加回
      //   ③ 无守卫的 update 拿到行锁后把 CANCELLED 直接改写成 PAID
      //
      // 结果：订单变成一张正常的已付款单，会被接单、出票、发货，而顾客手里那张券
      // 已经变回可用（能再花一次）、积分已经退回、赠品名额已经还回、库存也已加回（可超卖）。
      // 而 `wasCancelled` 是按过期快照判的，下面「取消后仍付款成功→自动全额退款」那一支
      // **不会触发**，也没有任何告警或日志——是一条静默的资损路径。
      //
      // 改成条件写之后：输掉的一方 count=0，回落到 lateCancelled 分支走自动退款，
      // 语义与「回调晚到、单子已被取消」完全一致，这本来就是那一支存在的理由。
      if (wasCancelled) {
        // 库存已在取消时回滚，这里只把订单转入退款流程，由下面自动发起全额退款
        const moved = await tx.order.updateMany({
          where: { id: orderId, status: 'CANCELLED' },
          data: { status: 'REFUNDING', paidAt, cancelReason: '订单取消后仍付款成功，系统自动退款' },
        })
        // count=0 说明这一瞬间状态又变了（极少见：取消后立刻被别处推进）。
        // 不硬写，让本次回调按「已处理」返回；微信重推时会用新状态重新判一遍。
        if (moved.count === 0) return
        lateCancelled = { orderNo: order.orderNo, actualAmount: order.actualAmount }
        return
      }
      const moved = await tx.order.updateMany({
        where: { id: orderId, status: 'PENDING_PAYMENT' },
        data: { status: 'PAID', paidAt },
      })
      if (moved.count === 0) {
        // 抢输了：并发的取消已经提交并释放了券与赠品积分。此时**绝不能**把状态写成 PAID
        // ——那会让「已释放的权益」与「一张要履约的 PAID 单」共存。
        // 按 lateCancelled 走自动全额退款，与「回调晚到」同一套处理。
        const now = await tx.order.findUnique({ where: { id: orderId }, select: { status: true } })
        if (now?.status === 'CANCELLED') {
          const back = await tx.order.updateMany({
            where: { id: orderId, status: 'CANCELLED' },
            data: { status: 'REFUNDING', paidAt, cancelReason: '订单取消后仍付款成功，系统自动退款（与取消并发）' },
          })
          if (back.count > 0) lateCancelled = { orderNo: order.orderNo, actualAmount: order.actualAmount }
        }
        return
      }
    })

    if (lateCancelled) {
      const info = lateCancelled as { orderNo: string; actualAmount: number }
      try {
        await initiateRefund({ orderId, amount: info.actualAmount, reason: '订单已取消，自动退款', operator: 'system' })
        notifySystemAlert('取消订单收到付款，已自动退款', [`订单 ${info.orderNo}`, `金额 ¥${(info.actualAmount / 100).toFixed(2)}`], {
          key: `late-pay:${orderId}`,
        })
      } catch (err) {
        // P3：50202（结果未知，行已保留交补查）与其它失败（明确拒绝/校验错误）文案不同——
        // 前者不该让店员误以为「需要去后台重试」，那反而可能造成重复退款。
        const uncertain = err instanceof AppError && err.code === 50202
        notifySystemAlert(
          uncertain ? '取消订单收到付款，自动退款结果未知（系统将自动核对）' : '取消订单收到付款，自动退款失败（请到后台退款 Tab 重试）',
          [`订单 ${info.orderNo}`, (err as Error).message],
          { key: `late-pay-fail:${orderId}` }
        )
      }
      replyOk(res)
      return
    }

    // 事务成功后推送新订单通知（fire-and-forget）。sendPaidSubscribeMessage 与 notifyOrderPaid
    // 都是同步 void 函数，任一处同步抛出（模板字段配错、user 为空、items[0] 解构异常）都只能各自
    // try/catch 兜住——不能让其中一个的异常连累另一个，更不能让它们连累下面独立起的出票链路（H3）。
    prisma.order
      .findUnique({
        where: { id: orderId },
        include: { items: { select: { productName: true, specText: true, quantity: true, isGift: true } }, user: { select: { openid: true } } },
      })
      .then(async (paid) => {
        if (paid && paid.status === 'PAID') {
          try {
            sendPaidSubscribeMessage(paid.user.openid, paid, paid.items[0]?.productName)
          } catch (err) {
            console.error('[wechat-notify] sendPaidSubscribeMessage 失败:', (err as Error).message)
          }
          // F3：来单推送要带取餐时段文案，与 orders.ts mock 支付路径同一口径。
          // 失败不影响支付回调主流程——外层 .catch 兜住，这里再单独 try/catch 是为了让
          // getLocalSettings/pickupSlotLabel 出错时仍能发一条不带取餐时间的推送。
          let slotLabel: string | undefined
          if (paid.deliveryType === 'PICKUP' && paid.pickupAt) {
            try {
              slotLabel = pickupSlotLabel(paid.pickupAt, (await getLocalSettings()).pickup.slotMinutes)
            } catch (err) {
              console.error('[wechat-notify] 计算取餐时段文案失败:', (err as Error).message)
            }
          }
          // Task 8：预约单来单推送标题带送达时段，与 orders.ts mock 支付路径同一口径。
          // 失败不影响支付回调主流程，也不影响上面已经算好的 pickupSlotLabel。
          let scheduleSlotLabel: string | undefined
          if (paid.deliveryType === 'LOCAL' && paid.scheduledAt) {
            try {
              scheduleSlotLabel = computeScheduleSlotLabel(paid.scheduledAt, (await getLocalSettings()).schedule.slotMinutes)
            } catch (err) {
              console.error('[wechat-notify] 计算预约时段文案失败:', (err as Error).message)
            }
          }
          try {
            notifyOrderPaid(
              {
                orderNo: paid.orderNo,
                actualAmount: paid.actualAmount,
                receiverName: paid.receiverName,
                receiverPhone: paid.receiverPhone,
                paidAt: paid.paidAt ?? new Date(),
                // M2：券抵扣额。这里是**真实微信支付回调**的推送路径，与 orders.ts 的 mock 支付
                // 路径并列——两条都要带，只改一条的话生产环境的打包员永远看不到「已用券」。
                discountAmount: paid.discountAmount,
                // 2026-09-11：推送标题按渠道分（自取/同城/邮寄）。mock 支付路径传的是整行 order 自带此列，
                // 这条真实回调路径是手拼字面量，漏了它生产上自取单的推送标题就永远是「新订单待发货」。
                deliveryType: paid.deliveryType,
                pickupSlotLabel: slotLabel,
                scheduleSlotLabel,
              },
              paid.items
            )
          } catch (err) {
            console.error('[wechat-notify] notifyOrderPaid 失败:', (err as Error).message)
          }
        }
      })
      .catch((err) => console.error('[wechat-notify] 付款后通知失败:', (err as Error).message))

    // 出票（规格 §8b）：真实微信支付回调的付款成功触发点。照 orders.ts:754 mock 支付路径的写法，
    // 单独起一条 promise 链，而不是塞进上面那条——上面那条的两个同步 void 函数（哪怕已经各自
    // try/catch）与这条查询本身都不该成为出票执行与否的前提；enqueueOrderTicket 内部会自己
    // 按 orderId 重新查订单与商品，不依赖上面 findUnique 的结果。事务已经把订单推到 PAID
    // （本函数上面的 tx.order.update），走到这里意味着没有 lateCancelled 早退，可以直接出票。
    // 打印异常绝不能冒泡到这条回调的应答——微信回调失败会重推，但整个 wechatPayNotifyHandler
    // 早已决定要对本次回调回 SUCCESS（见函数尾 replyOk），出票是回调应答之外的旁路副作用。
    enqueueOrderTicket(orderId, 'NEW_ORDER').catch((err) => {
      console.error('[wechat-notify] enqueueOrderTicket 失败:', (err as Error).message)
    })
  } catch (err) {
    if (err instanceof AmountMismatchError) {
      // 金额不一致：不更新订单，记录日志并返回 FAIL（微信会重试，需人工介入排查）
      console.error('[wechat-notify] AMOUNT MISMATCH:', err.message)
      notifySystemAlert('支付回调金额不一致', [err.message], { key: `pay-mismatch:${orderId}` })
      replyFail(res, '金额校验失败')
      return
    }
    console.error('[wechat-notify] db error:', err)
    replyFail(res, '数据库更新失败')
    return
  }

  replyOk(res)
}

// POST /api/wechat/pay/refund-notify
// 退款结果通知：REFUND.SUCCESS / REFUND.ABNORMAL / REFUND.CLOSED
export async function wechatRefundNotifyHandler(req: Request, res: Response): Promise<void> {
  const parsed = await parseNotify<RefundNotifyResult>(
    req,
    res,
    ['REFUND.SUCCESS', 'REFUND.ABNORMAL', 'REFUND.CLOSED'],
    'wechat-refund-notify'
  )
  if (!parsed) return
  const { event, data, rawBody } = parsed

  const refund = await prisma.refund.findUnique({ where: { outRefundNo: data.out_refund_no } })
  if (!refund) {
    // 不是本系统发起的退款单：记录并 ack，避免微信无限重试
    console.error('[wechat-refund-notify] unknown out_refund_no:', data.out_refund_no)
    replyOk(res)
    return
  }

  // 幂等：已成功的不再处理
  if (refund.status === 'SUCCESS') {
    replyOk(res)
    return
  }

  // 金额比对：回调退款金额必须等于本系统记录的退款金额
  if (data.amount && data.amount.refund !== refund.amount) {
    const msg = `outRefundNo=${refund.outRefundNo} 回调退款金额=${data.amount.refund} 记录金额=${refund.amount}`
    console.error('[wechat-refund-notify] AMOUNT MISMATCH:', msg)
    notifySystemAlert('退款回调金额不一致', [msg], { key: `refund-mismatch:${refund.id}` })
    replyFail(res, '金额校验失败')
    return
  }

  try {
    if (event === 'REFUND.SUCCESS' && data.refund_status === 'SUCCESS') {
      await finalizeRefundSuccess({
        refundId: refund.id,
        wxRefundId: data.refund_id,
        successTime: data.success_time ? new Date(data.success_time) : new Date(),
        rawData: rawBody,
        rawField: 'wxNotifyData',
      })
      // CANCEL 出票不在这里做：B1 已把它下沉进 finalizeRefundSuccess 本体（翻转成 REFUNDED 的
      // 那一次事务提交后），覆盖所有退款入口（后台一键退款/售后同意/顾客自助取消/拒单），
      // 包括走这条真实微信退款异步回调的场景。这里再调一次纯属重复出票，已删除。
    } else if (event === 'REFUND.ABNORMAL') {
      await markRefundAbnormal(refund.id, rawBody)
    } else if (event === 'REFUND.CLOSED') {
      await markRefundClosed(refund.id, rawBody)
    }
  } catch (err) {
    console.error('[wechat-refund-notify] db error:', err)
    replyFail(res, '数据库更新失败')
    return
  }

  replyOk(res)
}
