import crypto from 'crypto'
import fs from 'fs'

// 商户私钥模块级缓存（路径变化时重新读取）
let cachedPrivateKey: { path: string; pem: string } | null = null

function readPrivateKey(): string {
  const path = process.env.WECHAT_PAY_PRIVATE_KEY_PATH
  if (!path) throw new Error('WECHAT_PAY_PRIVATE_KEY_PATH not configured')
  if (cachedPrivateKey && cachedPrivateKey.path === path) return cachedPrivateKey.pem
  const pem = fs.readFileSync(path, 'utf-8')
  cachedPrivateKey = { path, pem }
  return pem
}

function generateNonce(): string {
  return crypto.randomBytes(16).toString('hex')
}

function getTimestamp(): string {
  return String(Math.floor(Date.now() / 1000))
}

// A9：全仓出站 HTTP 里，之前只有 kd100.ts 加了超时（其注释自陈「全仓其它 fetch 都没有超时」）。
// 微信支付这三个接口（下单/关单/退款）裸 fetch，对端不响应时请求会一直挂着，把处理该请求的
// 那次事件循环 tick 占住，直到 Node/反向代理自己的默认超时（往往几分钟起）才released。
const WECHAT_PAY_TIMEOUT_MS = 15000

/**
 * 给微信支付出站请求统一加超时。超时/中止时 fetch 会 reject 一个 DOMException
 * （name: 'TimeoutError'/'AbortError'），虽然它本身也 instanceof Error，但换成
 * 普通 Error + 中文说明更贴合本文件其余分支「throw new Error(...)」的既有形状，
 * 调用方原有的 `(e as Error).message` / `instanceof WechatRefundError` 判断不用改。
 */
async function fetchWechatPay(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(WECHAT_PAY_TIMEOUT_MS) })
  } catch (e) {
    const err = e as Error
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      throw new Error(`微信支付请求超时（${WECHAT_PAY_TIMEOUT_MS}ms）: ${err.message}`)
    }
    throw err
  }
}

export function generateWxPayAuthorization(
  method: string,
  url: string,
  body: string
): string {
  const mchId = process.env.WECHAT_MCH_ID!
  const serialNo = process.env.WECHAT_PAY_SERIAL_NO!
  const privateKey = readPrivateKey()
  const nonce = generateNonce()
  const timestamp = getTimestamp()

  const urlObj = new URL(url)
  const urlPath = urlObj.pathname + urlObj.search

  const message = `${method}\n${urlPath}\n${timestamp}\n${nonce}\n${body}\n`
  const sign = crypto.createSign('RSA-SHA256')
  sign.update(message)
  const signature = sign.sign(privateKey, 'base64')

  return `WECHATPAY2-SHA256-RSA2048 mchid="${mchId}",nonce_str="${nonce}",timestamp="${timestamp}",serial_no="${serialNo}",signature="${signature}"`
}

export interface JsapiOrderParams {
  outTradeNo: string
  description: string
  amount: number
  openid: string
  notifyUrl: string
  /** 订单失效时间（与本系统超时自动取消对齐，微信侧过期后用户无法再付款） */
  timeExpire?: Date
}

/** 微信要求 RFC3339 且带东八区偏移：2026-09-02T18:30:00+08:00 */
export function formatWechatTime(d: Date): string {
  const cst = new Date(d.getTime() + 8 * 60 * 60 * 1000)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${cst.getUTCFullYear()}-${p(cst.getUTCMonth() + 1)}-${p(cst.getUTCDate())}T${p(cst.getUTCHours())}:${p(cst.getUTCMinutes())}:${p(cst.getUTCSeconds())}+08:00`
}

export async function createJsapiOrder(params: JsapiOrderParams): Promise<string> {
  const appId = process.env.WECHAT_APP_ID!
  const mchId = process.env.WECHAT_MCH_ID!
  const apiUrl = 'https://api.mch.weixin.qq.com/v3/pay/transactions/jsapi'

  const body = JSON.stringify({
    appid: appId,
    mchid: mchId,
    description: params.description,
    out_trade_no: params.outTradeNo,
    notify_url: params.notifyUrl,
    amount: { total: params.amount, currency: 'CNY' },
    payer: { openid: params.openid },
    ...(params.timeExpire ? { time_expire: formatWechatTime(params.timeExpire) } : {}),
  })

  const authorization = generateWxPayAuthorization('POST', apiUrl, body)

  const resp = await fetchWechatPay(apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: authorization,
    },
    body,
  })

  const data = (await resp.json()) as {
    prepay_id?: string
    code?: string
    message?: string
  }
  if (!resp.ok || !data.prepay_id) {
    throw new Error(`WeChat Pay order failed: ${data.code} - ${data.message}`)
  }
  return data.prepay_id
}

/**
 * 关闭未支付订单 POST /v3/pay/transactions/out-trade-no/{no}/close（204 成功）。
 * 用于超时取消 / 用户取消后防止其继续付款。best-effort：失败只 warn，不抛。
 */
export async function closeOrder(outTradeNo: string): Promise<boolean> {
  const mchId = process.env.WECHAT_MCH_ID
  if (!mchId) return false
  const apiUrl = `https://api.mch.weixin.qq.com/v3/pay/transactions/out-trade-no/${encodeURIComponent(outTradeNo)}/close`
  const body = JSON.stringify({ mchid: mchId })
  try {
    const authorization = generateWxPayAuthorization('POST', apiUrl, body)
    const resp = await fetchWechatPay(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: authorization },
      body,
    })
    if (resp.status === 204) return true
    const text = await resp.text().catch(() => '')
    console.warn(`[wechat-pay] closeOrder ${outTradeNo} HTTP ${resp.status}: ${text.slice(0, 200)}`)
    return false
  } catch (e) {
    console.warn(`[wechat-pay] closeOrder ${outTradeNo} 请求失败:`, (e as Error).message)
    return false
  }
}

export function generatePayParams(prepayId: string): {
  timeStamp: string
  nonceStr: string
  package: string
  signType: string
  paySign: string
} {
  const appId = process.env.WECHAT_APP_ID!
  const privateKey = readPrivateKey()
  const timeStamp = getTimestamp()
  const nonceStr = generateNonce()
  const pkg = `prepay_id=${prepayId}`

  const message = `${appId}\n${timeStamp}\n${nonceStr}\n${pkg}\n`
  const sign = crypto.createSign('RSA-SHA256')
  sign.update(message)
  const paySign = sign.sign(privateKey, 'base64')

  return { timeStamp, nonceStr, package: pkg, signType: 'RSA', paySign }
}

// ---------------- 退款 ----------------

export interface RefundParams {
  outTradeNo: string
  outRefundNo: string
  amount: number // 退款金额（分）
  total: number // 原订单金额（分）
  reason?: string
  notifyUrl: string
}

export interface RefundResult {
  refund_id: string
  out_refund_no: string
  transaction_id?: string
  out_trade_no?: string
  channel?: string
  status: 'SUCCESS' | 'CLOSED' | 'PROCESSING' | 'ABNORMAL'
  success_time?: string
  amount: { refund: number; total: number; payer_refund?: number }
}

/** 微信退款 API 返回业务错误（非 2xx），code 如 NOT_ENOUGH / PARAM_ERROR / FREQUENCY_LIMITED */
export class WechatRefundError extends Error {
  constructor(
    public code: string,
    message: string,
    public httpStatus: number
  ) {
    super(message)
    this.name = 'WechatRefundError'
  }
}

/** 退款回调地址：优先 WECHAT_PAY_REFUND_NOTIFY_URL，否则由支付回调地址把末尾 /notify 换成 /refund-notify */
export function getRefundNotifyUrl(): string {
  const explicit = process.env.WECHAT_PAY_REFUND_NOTIFY_URL
  if (explicit && explicit.trim()) return explicit.trim()
  const payNotify = process.env.WECHAT_PAY_NOTIFY_URL ?? ''
  return payNotify.replace(/\/notify\/?$/, '/refund-notify')
}

/** 申请退款 POST /v3/refund/domestic/refunds（全额或部分由调用方决定；amount 为本次退款额，total 为原订单实付）。 */
export async function createRefund(params: RefundParams): Promise<RefundResult> {
  const apiUrl = 'https://api.mch.weixin.qq.com/v3/refund/domestic/refunds'
  const body = JSON.stringify({
    out_trade_no: params.outTradeNo,
    out_refund_no: params.outRefundNo,
    reason: params.reason,
    notify_url: params.notifyUrl,
    amount: { refund: params.amount, total: params.total, currency: 'CNY' },
  })
  const authorization = generateWxPayAuthorization('POST', apiUrl, body)
  const resp = await fetchWechatPay(apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: authorization,
    },
    body,
  })
  const data = (await resp.json()) as Partial<RefundResult> & { code?: string; message?: string }
  if (!resp.ok || !data.refund_id) {
    throw new WechatRefundError(data.code ?? `HTTP_${resp.status}`, data.message ?? '微信退款请求失败', resp.status)
  }
  return data as RefundResult
}

export function verifyNotifySignature(
  headers: { timestamp: string; nonce: string; signature: string },
  rawBody: string,
  platformCert: string
): boolean {
  const message = `${headers.timestamp}\n${headers.nonce}\n${rawBody}\n`
  const verify = crypto.createVerify('RSA-SHA256')
  verify.update(message)
  return verify.verify(platformCert, headers.signature, 'base64')
}

export function decryptNotifyResource(
  ciphertext: string,
  associatedData: string,
  nonce: string,
  apiV3Key: string
): string {
  const key = Buffer.from(apiV3Key, 'utf-8')
  const ciphertextBuf = Buffer.from(ciphertext, 'base64')
  const authTag = ciphertextBuf.subarray(ciphertextBuf.length - 16)
  const encryptedData = ciphertextBuf.subarray(0, ciphertextBuf.length - 16)

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce)
  decipher.setAuthTag(authTag)
  decipher.setAAD(Buffer.from(associatedData, 'utf-8'))

  return Buffer.concat([decipher.update(encryptedData), decipher.final()]).toString('utf-8')
}

export function validatePayConfig(): void {
  const required = [
    'WECHAT_APP_ID',
    'WECHAT_MCH_ID',
    'WECHAT_PAY_SERIAL_NO',
    'WECHAT_PAY_PRIVATE_KEY_PATH',
    'WECHAT_PAY_API_V3_KEY',
    'WECHAT_PAY_NOTIFY_URL',
  ]
  for (const key of required) {
    if (!process.env[key]) throw new Error(`Missing required env var: ${key}`)
  }
  const keyPath = process.env.WECHAT_PAY_PRIVATE_KEY_PATH!
  if (!fs.existsSync(keyPath)) throw new Error(`Private key file not found: ${keyPath}`)
}
