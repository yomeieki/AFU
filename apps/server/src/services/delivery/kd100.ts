/**
 * 快递100 同城急送协议实现。只懂协议：签名/编码/超时/验签/错误映射，不碰数据库。
 * 事实来源 docs/research/2026-09-03-kuaidi100-same-city-api.md：
 *  - POST https://api.kuaidi100.com/bsamecity/order，x-www-form-urlencoded
 *  - sign = MD5(param + t + key + secret) 32 位大写
 *  - 不支持商户自有单号 → deliveryNo 拼进 callbackUrl（回调按 URL 直取）
 *  - 回调 sign = MD5(param + salt)
 * ⚠️ 全仓其它 fetch 都没有超时；这里必须 AbortSignal.timeout(8000)——超时时下单可能已成功，
 *    调用方按 UNKNOWN 处理等回调认领，绝不能重试（会双呼骑手）。
 */
import crypto from 'crypto'
import { config, validateKd100Config } from '../../config'
import { ProviderError, DeliveryProvider, CreateDeliveryOrderInput, CreateDeliveryOrderResult, DeliveryCallbackPayload, ProviderErrorKind } from './types'
import { trunc } from './events'

const API_URL = 'https://api.kuaidi100.com/bsamecity/order'
const md5U = (s: string) => crypto.createHash('md5').update(s, 'utf8').digest('hex').toUpperCase()

export function _sign(paramStr: string, t: string, key: string, secret: string): string {
  return md5U(paramStr + t + key + secret)
}
export function _mapReturnCode(code: number | string): ProviderErrorKind {
  const c = String(code)
  if (c === '30004') return 'BALANCE'
  if (c === '30005') return 'CAPACITY'
  if (['30001', '30002', '30003', '30006'].includes(c)) return 'CONFIG'
  return 'BUSINESS'
}
const coord = (e6: number) => (e6 / 1e6).toFixed(6)

export function _buildOrderParam(input: CreateDeliveryOrderInput, providers: string[], goodsType: string): Record<string, unknown> {
  const { sender: s, receiver: r, goods: g } = input
  return {
    kuaidiComList: providers, lbsType: 2, orderType: 0,
    sendManName: s.name, sendManMobile: s.mobile, sendManProvince: s.province, sendManCity: s.city,
    sendManDistrict: s.district, sendManAddr: s.address, sendManLat: coord(s.latE6), sendManLng: coord(s.lngE6),
    recManName: r.name, recManMobile: r.mobile, recManProvince: r.province, recManCity: r.city,
    recManDistrict: r.district, recManAddr: r.address, recManLat: coord(r.latE6), recManLng: coord(r.lngE6),
    weight: String(Math.max(0.5, Math.round(g.weightKg * 10) / 10)),
    price: (g.totalPriceFen / 100).toFixed(2),
    goods: [{ name: g.title, type: goodsType, count: g.count }],
    remark: input.remark ?? '',
    salt: input.callbackSalt, callbackUrl: input.callbackUrl,
  }
}

interface Kd100Response { code?: number | string; returnCode?: number | string; success?: boolean; message?: string; data?: Record<string, unknown> }
async function post(method: string, param: Record<string, unknown>): Promise<Kd100Response> {
  validateKd100Config()
  const t = Date.now().toString()
  const paramStr = JSON.stringify(param)
  const body = new URLSearchParams({ method, key: config.kd100.key, sign: _sign(paramStr, t, config.kd100.key, config.kd100.secret), t, param: paramStr })
  let res: Response
  try {
    res = await fetch(API_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: body.toString(), signal: AbortSignal.timeout(8000),
    })
  } catch (e) {
    const name = (e as Error)?.name ?? ''
    const isTimeout = name === 'TimeoutError' || name === 'AbortError'
    throw new ProviderError('TIMEOUT', isTimeout ? 'TIMEOUT' : 'NETWORK', `快递100 请求${isTimeout ? '超时' : '网络失败'}: ${(e as Error).message}`, e)
  }
  let data: Kd100Response
  try { data = (await res.json()) as Kd100Response } catch { throw new ProviderError('BUSINESS', `HTTP_${res.status}`, '快递100 响应非 JSON') }
  const code = data.returnCode ?? data.code
  if (!res.ok || (String(code) !== '200' && data.success !== true)) {
    throw new ProviderError(_mapReturnCode(code ?? res.status), String(code ?? res.status), data.message ?? '快递100 返回异常', data)
  }
  return data
}

const yuanToFen = (v: unknown): number | null => {
  const n = Number(v); return Number.isFinite(n) ? Math.round(n * 100) : null
}
const toInt = (v: unknown): number | null => { const n = Number(v); return Number.isFinite(n) ? Math.round(n) : null }

export const kd100Provider: DeliveryProvider = {
  name: 'KD100',
  async price(input) {
    const settings = await import('../local-settings').then((m) => m.getLocalSettings())
    const fullInput: CreateDeliveryOrderInput = {
      deliveryNo: 'quote', callbackUrl: '', callbackSalt: '',
      sender: input.sender, receiver: input.receiver,
      goods: { title: '', weightKg: 0.5, totalPriceFen: 0, count: 1 }
    }
    const param = _buildOrderParam(fullInput, settings.kd100.providers, settings.kd100.goodsType)
    const data = await post('batchPrice', param)
    const fees = (data.data?.feeDetail as { discountFee?: unknown; distance?: unknown }[] | undefined) ?? []
    const feesFen = fees.map((f) => yuanToFen(f.discountFee)).filter((n): n is number => n !== null)
    return { feeFen: feesFen.length ? Math.min(...feesFen) : yuanToFen(data.data?.discountFee) ?? 0, distanceM: toInt(fees[0]?.distance ?? data.data?.deliveryDistance) }
  },
  async createOrder(input): Promise<CreateDeliveryOrderResult> {
    const settings = await import('../local-settings').then((m) => m.getLocalSettings())
    const param = _buildOrderParam(input, settings.kd100.providers, settings.kd100.goodsType)
    const data = await post('batchOrder', param)
    const d = data.data ?? {}
    const fees = (d.fee as { discountFee?: unknown; deliveryDistance?: unknown }[] | undefined) ?? []
    const feesFen = fees.map((f) => yuanToFen(f.discountFee)).filter((n): n is number => n !== null)
    // 距离在 fee[] 每一项里，顶层 deliveryDistance 仅作兜底
    return {
      taskId: typeof d.taskId === 'string' ? d.taskId : null,
      providerOrderId: typeof d.orderId === 'string' || typeof d.orderId === 'number' ? String(d.orderId) : null,
      quotedFeeFen: feesFen.length ? Math.min(...feesFen) : yuanToFen(d.discountFee),
      distanceM: toInt(fees[0]?.deliveryDistance ?? d.deliveryDistance), raw: data,
    }
  },
  async precancelOrder({ taskId }) {
    const data = await post('precancel', { taskId, cancelMsgType: 8, cancelMsg: '预览取消费用' })
    return { cancelFeeFen: yuanToFen(data.data?.cancelFee) }
  },
  async cancelOrder({ taskId, reason }) {
    const data = await post('cancel', { taskId, cancelMsgType: 8, cancelMsg: trunc(reason, 60) ?? '商家取消' })
    return { cancelFeeFen: yuanToFen(data.data?.cancelFee), raw: data }
  },
  async addTip({ taskId, amountFen }) {
    await post('addfee', { taskId, tips: (amountFen / 100).toFixed(2), remark: '商家加小费' })
  },
  async queryCourier({ taskId }) {
    const data = await post('queryCourier', { taskId })
    const lat = Number(data.data?.courierLat), lng = Number(data.data?.courierLng)
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null
    return { latE6: Math.round(lat * 1e6), lngE6: Math.round(lng * 1e6) }
  },
  verifyAndParseCallback(body, salt) {
    const paramStr = body.param
    const sign = body.sign
    if (typeof paramStr !== 'string' || !paramStr || typeof sign !== 'string') return { ok: false, reason: 'BAD_PARAM' }
    const expect = md5U(paramStr + salt)
    const got = sign.toUpperCase()
    // 长度不等 timingSafeEqual 会抛：先按字节长度筛掉（多字节字符等构造输入）
    if (Buffer.byteLength(got) !== Buffer.byteLength(expect)) return { ok: false, reason: 'SIGN_MISMATCH' }
    if (!crypto.timingSafeEqual(Buffer.from(expect), Buffer.from(got))) return { ok: false, reason: 'SIGN_MISMATCH' }
    let p: Record<string, unknown>
    try { p = JSON.parse(paramStr) as Record<string, unknown> } catch { return { ok: false, reason: 'BAD_PARAM' } }
    const ut = typeof p.updateTime === 'string' && p.updateTime ? new Date(p.updateTime.replace(' ', 'T') + '+08:00') : null
    const payload: DeliveryCallbackPayload = {
      taskId: trunc(String(body.taskId ?? p.taskId ?? ''), 64) ?? '',
      providerStatus: String(p.status ?? ''),
      statusDesc: trunc(p.statusDesc as string | undefined, 255),
      courierCompany: trunc(p.kuaidicom as string | undefined, 32),
      courierName: trunc(p.courierName as string | undefined, 64),
      courierMobile: trunc(p.courierMobile as string | undefined, 20),
      providerUpdateTime: ut && !Number.isNaN(ut.getTime()) ? ut : null,
      raw: p,
    }
    return { ok: true, payload }
  },
}
