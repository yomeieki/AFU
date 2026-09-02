export async function generateProductQrCode(
  productId: number
): Promise<{ scene: string; qrCodeUrl: string }> {
  const scene = `p_${productId}`
  const hasWxConfig = process.env.WECHAT_APP_ID && process.env.WECHAT_APP_SECRET
  const useMock = !hasWxConfig || process.env.WECHAT_QRCODE_MOCK === 'true'

  if (useMock) {
    return { scene, qrCodeUrl: `mock://qrcode/product-${productId}` }
  }

  // TODO: Phase 7 — implement real WeChat getwxacodeunlimit
  //
  // Steps:
  //   1. getWechatAccessToken()
  //      GET https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential
  //          &appid=WECHAT_APP_ID&secret=WECHAT_APP_SECRET
  //      Cache token in-process (TTL = expires_in - 300 seconds)
  //
  //   2. Call getwxacodeunlimit
  //      POST https://api.weixin.qq.com/wxa/getwxacodeunlimit?access_token=TOKEN
  //      Body: { scene, page: 'pages/product/detail', width: 280,
  //              is_hyaline: true, env_version: 'release' }
  //      responseType: 'arraybuffer'
  //
  //   3. Validate response content-type is image/*
  //      (WeChat returns JSON on error, not an image)
  //
  //   4. Upload buffer to COS（已有封装 services/cos.ts：putObject(buildObjectKey('qrcodes', '.png'), buf, 'image/png')）
  //      Returns a public URL
  //
  //   5. Return { scene, qrCodeUrl }
  throw new Error(
    '真实微信二维码接口尚未实现。请在 .env 中设置 WECHAT_QRCODE_MOCK=true 使用 Mock 模式'
  )
}
