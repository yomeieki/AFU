/**
 * 商品小程序码（getwxacodeunlimit）。
 *
 * 码里带 scene=p_<商品id>，扫码后落在 pages/product/detail，
 * 由小程序解析出商品 id 并记一条 scan_log（后台「扫码统计」用的就是它）。
 *
 * 对象 key 用固定的 `qrcodes/p_<id>.<ext>` 而不是 buildObjectKey 的随机名：
 * 重新生成时覆盖同一个对象，不会在桶里堆孤儿文件。同一个 scene 生成出来的
 * 码内容本来就一样，所以即使 CDN 缓存了旧的也无所谓。
 */

import { getAccessToken, invalidateAccessToken, isWechatApiConfigured } from './wechat-access-token'
import { isCosEnabled, putObject } from './cos'

/** 微信返回的 token 失效码，遇到这些刷新后重试一次 */
const TOKEN_INVALID_CODES = new Set([40001, 40014, 42001])

interface WxErrorBody {
  errcode?: number
  errmsg?: string
}

/**
 * 码的尺寸（像素）。280 在屏幕上够用，但贴纸/海报打印会糊；
 * 1280 是微信允许的上限，实测单张约 300KB，存储成本可以忽略。
 */
const QR_WIDTH = 1280

/**
 * 生产环境固定用 release 版本的码。
 * 小程序尚未发布时可临时设为 trial（体验版）自测——注意体验版的码
 * 只有小程序的体验成员扫得开，不能印出去给顾客。
 */
function getEnvVersion(): 'release' | 'trial' | 'develop' {
  const v = process.env.WECHAT_QRCODE_ENV_VERSION
  return v === 'trial' || v === 'develop' ? v : 'release'
}

/** 微信实际返回的图片格式：is_hyaline=false 给 JPEG，true 给 PNG。别写死。 */
function sniffImageType(buf: Buffer, contentType: string): { ext: string; mime: string } {
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0x89504e47) return { ext: 'png', mime: 'image/png' }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xd8) return { ext: 'jpg', mime: 'image/jpeg' }
  // magic 认不出来时退回响应头
  return contentType.includes('png')
    ? { ext: 'png', mime: 'image/png' }
    : { ext: 'jpg', mime: 'image/jpeg' }
}

async function requestQrCode(
  accessToken: string,
  scene: string
): Promise<{ buf: Buffer; contentType: string } | WxErrorBody> {
  const envVersion = getEnvVersion()
  const resp = await fetch(
    `https://api.weixin.qq.com/wxa/getwxacodeunlimit?access_token=${encodeURIComponent(accessToken)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scene,
        page: 'pages/product/detail',
        width: QR_WIDTH,
        // 不用透明底：码要打印在包装/海报上，白底最稳妥，
        // 透明底一旦贴到深色背景上黑色码点就看不见了。
        // 代价是微信此时返回的是 JPEG 而非 PNG——扩展名与 Content-Type
        // 必须按实际内容判定，写死 .png 会存出一个自称 PNG 的 JPEG。
        is_hyaline: false,
        env_version: envVersion,
        // check_path 会校验 page 是否存在于**已发布**版本里。
        // 体验版/开发版还没有"已发布的页面"，开着必然失败。
        check_path: envVersion === 'release',
      }),
    }
  )

  // 成功时微信返回图片二进制，失败时返回 JSON——必须按 content-type 分流，
  // 否则会把一段错误 JSON 当成 PNG 存进 COS，前台显示成一张碎图。
  const contentType = resp.headers.get('content-type') ?? ''
  if (contentType.includes('application/json') || contentType.includes('text/plain')) {
    return (await resp.json().catch(() => ({}))) as WxErrorBody
  }
  return { buf: Buffer.from(await resp.arrayBuffer()), contentType }
}

/** 把微信的 errcode 翻译成店家看得懂的话 */
function describeWxError(body: WxErrorBody): string {
  const { errcode, errmsg } = body
  switch (errcode) {
    case 41030:
      return '小程序尚未发布，暂时生成不了正式版二维码。请先在微信公众平台提交审核并发布，发布后再回来生成。'
    case 45009:
      return '微信接口调用达到频率上限，请稍后再试。'
    case 40001:
    case 40014:
    case 42001:
      return '微信登录凭据失效，请稍后重试。'
    default:
      return `微信接口返回错误 ${errcode ?? '未知'}：${errmsg ?? ''}`.trim()
  }
}

function isImage(r: { buf: Buffer; contentType: string } | WxErrorBody): r is { buf: Buffer; contentType: string } {
  return Buffer.isBuffer((r as { buf?: Buffer }).buf)
}

export async function generateProductQrCode(
  productId: number
): Promise<{ scene: string; qrCodeUrl: string }> {
  const scene = `p_${productId}`
  const useMock = !isWechatApiConfigured() || process.env.WECHAT_QRCODE_MOCK === 'true'

  if (useMock) {
    return { scene, qrCodeUrl: `mock://qrcode/product-${productId}` }
  }

  if (!isCosEnabled()) {
    throw new Error('对象存储（COS）未配置，二维码无处存放。请先在 .env 补齐 COS_* 后重试。')
  }

  let token = await getAccessToken()
  let result = await requestQrCode(token, scene)

  // token 失效：刷新后重试一次。只重试一次，避免凭据真的错了时打死循环。
  if (!isImage(result) && TOKEN_INVALID_CODES.has(result.errcode ?? -1)) {
    invalidateAccessToken()
    token = await getAccessToken()
    result = await requestQrCode(token, scene)
  }

  if (!isImage(result)) {
    throw new Error(describeWxError(result))
  }
  // 微信偶发返回 0 字节 200：当作失败，别把空文件存进去
  if (result.buf.length === 0) {
    throw new Error('微信返回了空图片，请稍后重试。')
  }

  const { ext, mime } = sniffImageType(result.buf, result.contentType)
  const qrCodeUrl = await putObject(`qrcodes/${scene}.${ext}`, result.buf, mime)
  return { scene, qrCodeUrl }
}
