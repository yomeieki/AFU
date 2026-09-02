/**
 * 腾讯云 COS 对象存储封装（图片上传）。
 * - 5 个 COS_* 环境变量全配置时启用；开发环境未配置回退本地 uploads/（见 routes/admin/upload.ts）
 * - 对象 key：uploads/YYYYMM/<ts>-<hex6>.<ext>；存量迁移沿用原文件名 uploads/<原名>
 * - 公网 URL：COS_BASE_URL（自定义域名/CDN）缺省为桶默认域名
 */
import COS from 'cos-nodejs-sdk-v5'
import crypto from 'crypto'
import { config } from '../config'

let client: COS | null = null

export function isCosEnabled(): boolean {
  return config.cos.enabled
}

function getClient(): COS {
  if (!client) {
    client = new COS({
      SecretId: config.cos.secretId,
      SecretKey: config.cos.secretKey,
      FileParallelLimit: 5,
    })
  }
  return client
}

export function getCosBaseUrl(): string {
  if (config.cos.baseUrl) return config.cos.baseUrl
  return `https://${config.cos.bucket}.cos.${config.cos.region}.myqcloud.com`
}

export function publicUrl(key: string): string {
  return `${getCosBaseUrl()}/${key.replace(/^\/+/, '')}`
}

export function buildObjectKey(prefix: 'uploads' | 'qrcodes', ext: string): string {
  const d = new Date()
  const ym = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`
  const normalizedExt = ext.startsWith('.') ? ext : `.${ext}`
  return `${prefix}/${ym}/${Date.now()}-${crypto.randomBytes(6).toString('hex')}${normalizedExt}`
}

export async function putObject(key: string, body: Buffer, contentType: string): Promise<string> {
  await getClient().putObject({
    Bucket: config.cos.bucket,
    Region: config.cos.region,
    Key: key,
    Body: body,
    ContentLength: body.length,
    ContentType: contentType,
    CacheControl: 'public, max-age=2592000',
  })
  return publicUrl(key)
}

/** 对象是否已存在（404 → false，其他错误抛出）。 */
export async function headObject(key: string): Promise<boolean> {
  try {
    await getClient().headObject({ Bucket: config.cos.bucket, Region: config.cos.region, Key: key })
    return true
  } catch (e) {
    const status = (e as { statusCode?: number }).statusCode
    if (status === 404) return false
    throw e
  }
}
