/**
 * 微信支付回调验签（APIv3）——同时支持两种平台侧密钥模式：
 *
 * 1. 微信支付公钥（2024 年起新商户默认）：回调头 Wechatpay-Serial 以 PUB_KEY_ID_ 开头，
 *    用商户平台下载的 pub_key.pem（WECHAT_PAY_PUBLIC_KEY_PATH）验签
 * 2. 平台证书：Wechatpay-Serial 为证书序列号，用 WECHAT_PAY_PLATFORM_CERT_PATH 指向的证书验签；
 *    序列号不匹配（证书轮换）时自动调 GET /v3/certificates 拉取并缓存 12 小时
 *
 * 只做「解析头 + 选密钥 + 验签 + 防重放」，不碰业务。
 */
import crypto from 'crypto'
import fs from 'fs'
import type { IncomingHttpHeaders } from 'http'
import {
  generateWxPayAuthorization,
  verifyNotifySignature,
  decryptNotifyResource,
} from './wechat-pay'

export type VerifyMode = 'public-key' | 'platform-cert'

const PUBLIC_KEY_PREFIX = 'PUB_KEY_ID_'
const CERT_CACHE_TTL_MS = 12 * 60 * 60 * 1000
const MAX_CLOCK_SKEW_SEC = 5 * 60
// A9：证书下载裸 fetch 之前没有超时，对端不响应会一直挂着 resolvePlatformCert（进而挂住
// verifyWechatNotify——支付/退款回调的验签路径）。15s 与 wechat-pay.ts 的出站请求超时对齐。
const CERT_DOWNLOAD_TIMEOUT_MS = 15000

type VerifyResult = { ok: true; mode: VerifyMode } | { ok: false; reason: string }

let cachedPublicKey: { path: string; pem: string } | null = null
const platformCerts = new Map<string, string>() // serial(upper) -> PEM
let platformCertsLoadedAt = 0
let downloadInFlight: Promise<void> | null = null

export function detectMode(serial: string): VerifyMode {
  return serial.startsWith(PUBLIC_KEY_PREFIX) ? 'public-key' : 'platform-cert'
}

function isSet(v: string | undefined): v is string {
  return !!v && v.trim() !== ''
}

function normalizeSerial(s: string): string {
  return s.trim().toUpperCase()
}

function readPublicKey(): string | null {
  const p = process.env.WECHAT_PAY_PUBLIC_KEY_PATH
  if (!isSet(p)) return null
  if (cachedPublicKey && cachedPublicKey.path === p) return cachedPublicKey.pem
  const pem = fs.readFileSync(p, 'utf-8')
  cachedPublicKey = { path: p, pem }
  return pem
}

function registerCert(pem: string): string {
  const serial = normalizeSerial(new crypto.X509Certificate(pem).serialNumber)
  platformCerts.set(serial, pem)
  return serial
}

function loadLocalPlatformCert(): void {
  const p = process.env.WECHAT_PAY_PLATFORM_CERT_PATH
  if (!isSet(p) || !fs.existsSync(p)) return
  try {
    registerCert(fs.readFileSync(p, 'utf-8'))
  } catch (e) {
    console.error('[wechat-verify] 平台证书文件解析失败:', (e as Error).message)
  }
}

interface CertificatesResponse {
  data?: Array<{
    serial_no: string
    encrypt_certificate: { algorithm: string; nonce: string; associated_data: string; ciphertext: string }
  }>
  code?: string
  message?: string
}

/** GET /v3/certificates：用商户私钥签名请求，APIv3 密钥解密证书内容。 */
async function downloadPlatformCerts(): Promise<void> {
  if (downloadInFlight) return downloadInFlight
  downloadInFlight = (async () => {
    const apiV3Key = process.env.WECHAT_PAY_API_V3_KEY
    if (!isSet(apiV3Key)) throw new Error('WECHAT_PAY_API_V3_KEY not configured')
    const url = 'https://api.mch.weixin.qq.com/v3/certificates'
    const authorization = generateWxPayAuthorization('GET', url, '')
    let resp: Response
    try {
      resp = await fetch(url, {
        headers: { Accept: 'application/json', Authorization: authorization },
        signal: AbortSignal.timeout(CERT_DOWNLOAD_TIMEOUT_MS),
      })
    } catch (e) {
      const err = e as Error
      if (err.name === 'TimeoutError' || err.name === 'AbortError') {
        throw new Error(`平台证书下载请求超时（${CERT_DOWNLOAD_TIMEOUT_MS}ms）: ${err.message}`)
      }
      throw err
    }
    const data = (await resp.json()) as CertificatesResponse
    if (!resp.ok || !data.data) {
      throw new Error(`certificates download failed: ${data.code} - ${data.message}`)
    }
    for (const item of data.data) {
      const enc = item.encrypt_certificate
      const pem = decryptNotifyResource(enc.ciphertext, enc.associated_data, enc.nonce, apiV3Key)
      const serial = registerCert(pem)
      if (serial !== normalizeSerial(item.serial_no)) {
        console.warn('[wechat-verify] 证书序列号与响应不一致:', serial, item.serial_no)
      }
    }
    platformCertsLoadedAt = Date.now()
    console.log(`[wechat-verify] 已拉取平台证书 ${data.data.length} 张`)
  })().finally(() => {
    downloadInFlight = null
  })
  return downloadInFlight
}

function autoDownloadEnabled(): boolean {
  return process.env.WECHAT_PAY_CERT_AUTO_DOWNLOAD !== 'false'
}

async function resolvePlatformCert(serial: string): Promise<string | null> {
  if (platformCerts.size === 0) loadLocalPlatformCert()
  let pem = platformCerts.get(serial)
  if (pem) return pem
  const stale = Date.now() - platformCertsLoadedAt > CERT_CACHE_TTL_MS
  if (autoDownloadEnabled() && stale && isSet(process.env.WECHAT_PAY_PRIVATE_KEY_PATH)) {
    try {
      await downloadPlatformCerts()
    } catch (e) {
      console.error('[wechat-verify] 平台证书自动拉取失败:', (e as Error).message)
    }
    pem = platformCerts.get(serial)
  }
  return pem ?? null
}

/** 供 GET /admin/system/status 展示，只返回布尔/枚举。 */
export function getVerifyStatus(): {
  publicKeySet: boolean
  publicKeyIdSet: boolean
  platformCertSet: boolean
  certAutoDownload: boolean
  mode: VerifyMode | 'both' | 'none'
} {
  const pk = process.env.WECHAT_PAY_PUBLIC_KEY_PATH
  const cert = process.env.WECHAT_PAY_PLATFORM_CERT_PATH
  const publicKeySet = isSet(pk) && fs.existsSync(pk)
  const platformCertSet = isSet(cert) && fs.existsSync(cert)
  const mode =
    publicKeySet && platformCertSet
      ? 'both'
      : publicKeySet
        ? 'public-key'
        : platformCertSet
          ? 'platform-cert'
          : 'none'
  return {
    publicKeySet,
    publicKeyIdSet: isSet(process.env.WECHAT_PAY_PUBLIC_KEY_ID),
    platformCertSet,
    certAutoDownload: autoDownloadEnabled(),
    mode,
  }
}

/** 是否配置了任一验签材料（未配置时开发环境允许跳过验签）。 */
export function hasVerifyMaterial(): boolean {
  return isSet(process.env.WECHAT_PAY_PUBLIC_KEY_PATH) || isSet(process.env.WECHAT_PAY_PLATFORM_CERT_PATH)
}

/**
 * 校验回调请求：头完整性 → 时间戳偏差 ≤5 分钟 → 按 serial 选密钥 → RSA-SHA256 验签。
 * 不 throw；调用方按 ok 决定 replyFail。
 */
export async function verifyWechatNotify(headers: IncomingHttpHeaders, rawBody: string): Promise<VerifyResult> {
  const timestamp = headers['wechatpay-timestamp']
  const nonce = headers['wechatpay-nonce']
  const signature = headers['wechatpay-signature']
  const serialRaw = headers['wechatpay-serial']
  if (
    typeof timestamp !== 'string' ||
    typeof nonce !== 'string' ||
    typeof signature !== 'string' ||
    typeof serialRaw !== 'string'
  ) {
    return { ok: false, reason: '缺少签名头' }
  }

  const ts = Number(timestamp)
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > MAX_CLOCK_SKEW_SEC) {
    return { ok: false, reason: '时间戳超出允许范围' }
  }

  const mode = detectMode(serialRaw)
  let pem: string | null = null
  try {
    if (mode === 'public-key') {
      const expectedId = process.env.WECHAT_PAY_PUBLIC_KEY_ID
      if (isSet(expectedId) && expectedId.trim() !== serialRaw.trim()) {
        return { ok: false, reason: '公钥 ID 不匹配' }
      }
      pem = readPublicKey()
      if (!pem) return { ok: false, reason: '未配置微信支付公钥' }
    } else {
      pem = await resolvePlatformCert(normalizeSerial(serialRaw))
      if (!pem) return { ok: false, reason: '未找到对应序列号的平台证书' }
    }
  } catch (e) {
    console.error('[wechat-verify] 密钥加载失败:', (e as Error).message)
    return { ok: false, reason: '密钥加载失败' }
  }

  let valid = false
  try {
    valid = verifyNotifySignature({ timestamp, nonce, signature }, rawBody, pem)
  } catch (e) {
    console.error('[wechat-verify] 验签异常:', (e as Error).message)
    return { ok: false, reason: '验签异常' }
  }
  return valid ? { ok: true, mode } : { ok: false, reason: '签名验证失败' }
}

/** 仅测试用：清空缓存。 */
export function _resetVerifyCache(): void {
  cachedPublicKey = null
  platformCerts.clear()
  platformCertsLoadedAt = 0
}
