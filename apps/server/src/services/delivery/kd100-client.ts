/**
 * 快递100 两个产品（同城急送 / 上门取件）共用的协议底座：签名、form 提交、超时与网络错误分类。
 * 只懂 HTTP，不懂业务：returnCode → ProviderErrorKind 的映射由各产品自己传进来。
 * 2026-09-08 从 kd100.ts 抽出，行为与抽出前逐字节一致；selftest-kd100 与同城 e2e 是判据。
 *
 * ⚠️ 超时/网络错误的分类规则是同城下单防双呼的根基（详见 kd100.ts 顶部注释），这里一行都不能松：
 *  - AbortSignal 超时 → TIMEOUT（下单可能已成功，调用方按 UNKNOWN 等回调，绝不重试）
 *  - ECONNREFUSED/ENOTFOUND/EAI_AGAIN → BUSINESS（能证明包没发出去，可重试）
 *  - 其它 fetch reject、HTTP 5xx → TIMEOUT（证明不了没送达）
 */
import crypto from 'crypto'
import { ProviderError, ProviderErrorKind } from './types'

export interface Kd100Response {
  code?: number | string
  returnCode?: number | string
  success?: boolean
  message?: string
  data?: unknown
}

const md5U = (s: string) => crypto.createHash('md5').update(s, 'utf8').digest('hex').toUpperCase()

/** sign = MD5(param + t + key + secret)，32 位大写。两个产品同一公式。 */
export function signKd100(paramStr: string, t: string, key: string, secret: string): string {
  return md5U(paramStr + t + key + secret)
}

export interface PostKd100Options {
  url: string
  method: string
  param: Record<string, unknown>
  key: string
  secret: string
  timeoutMs: number
  /** 业务错误码 → 错误类别。同城是 30001…，上门取件是 400/503/600…，各产品自己给。 */
  mapReturnCode: (code: number | string, message?: string) => ProviderErrorKind
}

export async function postKd100(o: PostKd100Options): Promise<Kd100Response> {
  const t = Date.now().toString()
  const paramStr = JSON.stringify(o.param)
  const body = new URLSearchParams({
    method: o.method, key: o.key, sign: signKd100(paramStr, t, o.key, o.secret), t, param: paramStr,
  })
  let res: Response
  try {
    res = await fetch(o.url, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: body.toString(), signal: AbortSignal.timeout(o.timeoutMs),
    })
  } catch (e) {
    const err = e as Error & { cause?: unknown }
    const name = err?.name ?? ''
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new ProviderError('TIMEOUT', 'TIMEOUT', `快递100 请求超时: ${err.message}`, e)
    }
    const causeCode = err.cause && typeof err.cause === 'object' && 'code' in err.cause
      ? String((err.cause as { code?: unknown }).code ?? '') : ''
    const CONFIRMED_NOT_SENT = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'])
    if (CONFIRMED_NOT_SENT.has(causeCode)) {
      throw new ProviderError('BUSINESS', causeCode, `快递100 请求未能发出（${causeCode}）: ${err.message}`, e)
    }
    throw new ProviderError('TIMEOUT', causeCode || 'NETWORK', `快递100 请求网络失败: ${err.message}`, e)
  }
  if (res.status >= 500) {
    throw new ProviderError('TIMEOUT', 'HTTP_5XX', `快递100 网关异常 HTTP ${res.status}`, res)
  }
  let data: Kd100Response
  try { data = (await res.json()) as Kd100Response } catch { throw new ProviderError('BUSINESS', `HTTP_${res.status}`, '快递100 响应非 JSON') }
  const code = data.returnCode ?? data.code
  if (!res.ok || (String(code) !== '200' && data.success !== true)) {
    throw new ProviderError(o.mapReturnCode(code ?? res.status, data.message), String(code ?? res.status), data.message ?? '快递100 返回异常', data)
  }
  return data
}
