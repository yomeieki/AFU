import { Request, Response } from 'express'
import fs from 'fs'
import prisma from '../utils/prisma'
import {
  verifyNotifySignature,
  decryptNotifyResource,
} from '../services/wechat-pay'

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

function replyOk(res: Response) {
  res.json({ code: 'SUCCESS', message: '成功' })
}

function replyFail(res: Response, message: string) {
  res.status(400).json({ code: 'FAIL', message })
}

// POST /api/wechat/pay/notify
// Mounted in app.ts BEFORE express.json() with express.text({ type: '*/*' })
export async function wechatPayNotifyHandler(req: Request, res: Response): Promise<void> {
  const rawBody: string = req.body as string

  // Optional signature verification
  const certPath = process.env.WECHAT_PAY_PLATFORM_CERT_PATH
  if (certPath) {
    try {
      const platformCert = fs.readFileSync(certPath, 'utf-8')
      const timestamp = req.headers['wechatpay-timestamp'] as string
      const nonce = req.headers['wechatpay-nonce'] as string
      const signature = req.headers['wechatpay-signature'] as string
      if (!timestamp || !nonce || !signature) {
        replyFail(res, '缺少签名头')
        return
      }
      const valid = verifyNotifySignature({ timestamp, nonce, signature }, rawBody, platformCert)
      if (!valid) {
        replyFail(res, '签名验证失败')
        return
      }
    } catch (err) {
      console.error('[wechat-notify] cert verification error:', err)
      replyFail(res, '证书加载失败')
      return
    }
  } else if (process.env.NODE_ENV === 'production') {
    console.error('[wechat-notify] WECHAT_PAY_PLATFORM_CERT_PATH must be configured in production')
    replyFail(res, '服务配置错误')
    return
  } else {
    console.warn('[wechat-notify] WECHAT_PAY_PLATFORM_CERT_PATH not set, skipping signature verify (dev only)')
  }

  let body: NotifyBody
  try {
    body = JSON.parse(rawBody) as NotifyBody
  } catch {
    replyFail(res, '请求体解析失败')
    return
  }

  if (body.event_type !== 'TRANSACTION.SUCCESS') {
    // Not a success event — ack and ignore
    replyOk(res)
    return
  }

  const resource = body.resource
  if (!resource?.ciphertext || !resource.nonce) {
    replyFail(res, '缺少加密资源')
    return
  }

  const apiV3Key = process.env.WECHAT_PAY_API_V3_KEY
  if (!apiV3Key) {
    console.error('[wechat-notify] WECHAT_PAY_API_V3_KEY not set')
    replyFail(res, '服务配置错误')
    return
  }

  let transaction: TransactionResult
  try {
    const plaintext = decryptNotifyResource(
      resource.ciphertext,
      resource.associated_data ?? '',
      resource.nonce,
      apiV3Key
    )
    transaction = JSON.parse(plaintext) as TransactionResult
  } catch (err) {
    console.error('[wechat-notify] decrypt error:', err)
    replyFail(res, '解密失败')
    return
  }

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

  try {
    await prisma.$transaction(async (tx) => {
      const order = await tx.order.findUnique({
        where: { id: orderId },
        include: { payment: true },
      })
      if (!order) return

      // Idempotent: already paid
      if (order.status === 'PAID') return

      const paidAt = transaction.success_time ? new Date(transaction.success_time) : new Date()

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

      await tx.order.update({
        where: { id: orderId },
        data: { status: 'PAID', paidAt },
      })
    })
  } catch (err) {
    console.error('[wechat-notify] db error:', err)
    replyFail(res, '数据库更新失败')
    return
  }

  replyOk(res)
}
