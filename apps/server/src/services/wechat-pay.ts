import crypto from 'crypto'
import fs from 'fs'

function readPrivateKey(): string {
  const path = process.env.WECHAT_PAY_PRIVATE_KEY_PATH
  if (!path) throw new Error('WECHAT_PAY_PRIVATE_KEY_PATH not configured')
  return fs.readFileSync(path, 'utf-8')
}

function generateNonce(): string {
  return crypto.randomBytes(16).toString('hex')
}

function getTimestamp(): string {
  return String(Math.floor(Date.now() / 1000))
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
  })

  const authorization = generateWxPayAuthorization('POST', apiUrl, body)

  const resp = await fetch(apiUrl, {
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
