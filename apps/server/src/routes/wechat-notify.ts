import { Request, Response } from 'express'
import prisma from '../utils/prisma'
import { decryptNotifyResource } from '../services/wechat-pay'
import { verifyWechatNotify, hasVerifyMaterial } from '../services/wechat-pay-verify'
import { notifyOrderPaid } from '../services/order-notify'
import { notifySystemAlert } from '../services/notify'
import { finalizeRefundSuccess, initiateRefund, markRefundAbnormal, markRefundClosed } from '../services/refund'
import { config } from '../config'
import { sendPaidSubscribeMessage } from '../services/subscribe-message'

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

      if (wasCancelled) {
        // 库存已在取消时回滚，这里只把订单转入退款流程，由下面自动发起全额退款
        await tx.order.update({
          where: { id: orderId },
          data: { status: 'REFUNDING', paidAt, cancelReason: '订单取消后仍付款成功，系统自动退款' },
        })
        lateCancelled = { orderNo: order.orderNo, actualAmount: order.actualAmount }
        return
      }
      await tx.order.update({
        where: { id: orderId },
        data: { status: 'PAID', paidAt },
      })
    })

    if (lateCancelled) {
      const info = lateCancelled as { orderNo: string; actualAmount: number }
      try {
        await initiateRefund({ orderId, amount: info.actualAmount, reason: '订单已取消，自动退款', operator: 'system' })
        notifySystemAlert('取消订单收到付款，已自动退款', [`订单 ${info.orderNo}`, `金额 ¥${(info.actualAmount / 100).toFixed(2)}`], {
          key: `late-pay:${orderId}`,
        })
      } catch (err) {
        notifySystemAlert('取消订单收到付款，自动退款失败（请到后台退款 Tab 重试）', [`订单 ${info.orderNo}`, (err as Error).message], {
          key: `late-pay-fail:${orderId}`,
        })
      }
      replyOk(res)
      return
    }

    // 事务成功后推送新订单通知（fire-and-forget）
    prisma.order
      .findUnique({
        where: { id: orderId },
        include: { items: { select: { productName: true, specText: true, quantity: true } }, user: { select: { openid: true } } },
      })
      .then((paid) => {
        if (paid && paid.status === 'PAID') {
          sendPaidSubscribeMessage(paid.user.openid, paid, paid.items[0]?.productName)
          notifyOrderPaid(
            {
              orderNo: paid.orderNo,
              actualAmount: paid.actualAmount,
              receiverName: paid.receiverName,
              receiverPhone: paid.receiverPhone,
              paidAt: paid.paidAt ?? new Date(),
            },
            paid.items
          )
        }
      })
      .catch(() => undefined)
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
