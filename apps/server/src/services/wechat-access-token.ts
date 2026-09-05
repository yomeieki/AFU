/**
 * 小程序全局接口调用凭据 access_token（订阅消息 / 小程序码等服务端接口共用）。
 * 进程内缓存，提前 5 分钟刷新；并发请求共享同一个 in-flight Promise。
 * 注意：同一 AppID 重复获取会使旧 token 失效，本项目 PM2 单实例，不做跨进程共享。
 */

let cached: { token: string; expiresAt: number } | null = null
let inFlight: Promise<string> | null = null

const REFRESH_AHEAD_MS = 5 * 60 * 1000
// A9：这里之前是裸 fetch，无超时——微信网关不响应时会一直挂着，而 getAccessToken 是
// 二维码生成/订阅消息发送两条链路唯一的 token 来源，挂住就等于把它们一起拖死。
const TOKEN_FETCH_TIMEOUT_MS = 10000

export function isWechatApiConfigured(): boolean {
  return !!process.env.WECHAT_APP_ID && !!process.env.WECHAT_APP_SECRET
}

export async function getAccessToken(): Promise<string> {
  if (cached && Date.now() < cached.expiresAt - REFRESH_AHEAD_MS) return cached.token
  if (inFlight) return inFlight
  inFlight = fetchToken().finally(() => {
    inFlight = null
  })
  return inFlight
}

async function fetchToken(): Promise<string> {
  const appId = process.env.WECHAT_APP_ID
  const secret = process.env.WECHAT_APP_SECRET
  if (!appId || !secret) throw new Error('WECHAT_APP_ID / WECHAT_APP_SECRET 未配置')
  const url = `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${encodeURIComponent(appId)}&secret=${encodeURIComponent(secret)}`
  let resp: Response
  try {
    resp = await fetch(url, { signal: AbortSignal.timeout(TOKEN_FETCH_TIMEOUT_MS) })
  } catch (e) {
    const err = e as Error
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      throw new Error(`获取 access_token 请求超时（${TOKEN_FETCH_TIMEOUT_MS}ms）: ${err.message}`)
    }
    throw err
  }
  const data = (await resp.json()) as { access_token?: string; expires_in?: number; errcode?: number; errmsg?: string }
  if (!data.access_token) {
    throw new Error(`获取 access_token 失败: ${data.errcode ?? ''} ${data.errmsg ?? ''}`.trim())
  }
  cached = { token: data.access_token, expiresAt: Date.now() + (data.expires_in ?? 7200) * 1000 }
  return cached.token
}

/** 微信返回 40001/40014/42001 等 token 失效码时调用，下次强制刷新 */
export function invalidateAccessToken(): void {
  cached = null
}
