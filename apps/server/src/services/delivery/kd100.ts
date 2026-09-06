/**
 * 快递100 同城急送协议实现。只懂协议：签名/编码/超时/验签/错误映射，不碰数据库。
 * 事实来源 docs/research/2026-09-03-kuaidi100-same-city-api.md：
 *  - POST https://api.kuaidi100.com/bsamecity/order，x-www-form-urlencoded
 *  - sign = MD5(param + t + key + secret) 32 位大写
 *  - 不支持商户自有单号 → deliveryNo 拼进 callbackUrl（回调按 URL 直取）
 *  - 回调 sign = MD5(param + salt)
 * ⚠️ 全仓其它 fetch 都没有超时；这里必须 AbortSignal.timeout(...)——超时时下单可能已成功，
 *    调用方按 UNKNOWN 处理等回调认领，绝不能重试（会双呼骑手）。
 */
import crypto from 'crypto'
import { config, validateKd100Config } from '../../config'
import { ProviderError, DeliveryProvider, CreateDeliveryOrderInput, CreateDeliveryOrderResult, DeliveryCallbackPayload, ProviderErrorKind, ProviderQuote } from './types'
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
/** 默认请求超时。调用方可逐次覆盖（目前只有顾客侧查价这么做，见 DeliveryProvider.price 的注释） */
const DEFAULT_TIMEOUT_MS = 8000
async function post(method: string, param: Record<string, unknown>, timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<Kd100Response> {
  validateKd100Config()
  const t = Date.now().toString()
  const paramStr = JSON.stringify(param)
  const body = new URLSearchParams({ method, key: config.kd100.key, sign: _sign(paramStr, t, config.kd100.key, config.kd100.secret), t, param: paramStr })
  let res: Response
  try {
    res = await fetch(API_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: body.toString(), signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (e) {
    const err = e as Error & { cause?: unknown }
    const name = err?.name ?? ''
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new ProviderError('TIMEOUT', 'TIMEOUT', `快递100 请求超时: ${err.message}`, e)
    }
    // fetch 本身 reject 且不是超时：区分「能证明请求根本没发出去」与「判断不了」。
    // Node fetch 把底层错误包在 cause.code 里——ECONNREFUSED/DNS 解析失败（ENOTFOUND/EAI_AGAIN）
    // 说明连接从未建立，本地包都没发出去，按硬失败处理最省心（明确失败，可直接重试，不占 UNKNOWN）。
    // 其它一律保守当超时：连接中途断开、EPIPE、ECONNRESET 这类无法证明请求没送达对方，
    // 下单可能已经发出去了，绝不能让调用方当作「肯定没成」去重试（会双呼骑手）。
    const causeCode = err.cause && typeof err.cause === 'object' && 'code' in err.cause
      ? String((err.cause as { code?: unknown }).code ?? '') : ''
    const CONFIRMED_NOT_SENT = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'])
    if (CONFIRMED_NOT_SENT.has(causeCode)) {
      throw new ProviderError('BUSINESS', causeCode, `快递100 请求未能发出（${causeCode}）: ${err.message}`, e)
    }
    throw new ProviderError('TIMEOUT', causeCode || 'NETWORK', `快递100 请求网络失败: ${err.message}`, e)
  }
  if (res.status >= 500) {
    // 网关级 5xx：不能证明请求没有在对方那头产生真实下单（可能背后已经建单，只是响应炸了）。
    // 必须按超时语义处理——停 UNKNOWN 等回调认领或人工核对，绝不能当「明确失败」直接放行重试
    // （createOrder 若在此 fail-open，会导致两个骑手上门、两笔配送费；cancelOrder/addTip 同类错误下
    // 本就 fail-closed，不受影响）。在尝试解析响应体之前先判断，5xx 时无论 body 是不是合法 JSON 都一视同仁。
    throw new ProviderError('TIMEOUT', 'HTTP_5XX', `快递100 网关异常 HTTP ${res.status}`, res)
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
    // ⚠️ callbackUrl 必须是**格式合法的 URL**，哪怕 batchPrice 根本不会回调。
    // 2026-09-06 生产实测（A/B 只变这一个量，其余 param 完全相同）：
    //   callbackUrl: ''  → returnCode=30001「回调地址格式错误」
    //   callbackUrl: 真实地址 → returnCode=200，返回 4 家真实报价
    // 此前这里写的是空串，于是**生产上每一次查价都在失败**，而且失败得很安静：
    // measureRoadDistanceM 的 catch 会退回「直线 × detourFactor」估算并只标记
    // distanceSource:'ESTIMATED'，报价照样签发、订单照样能下——所以没人发现顾客
    // 看到的配送费从来不是真实道路距离算出来的。（同一发实测：直线 1.11km 的点真实
    // 道路 1422m，实际系数 1.28，而兜底配的 1.7 高估 33%。）
    // 用 /api/kd/quote 而不是随便编一个：万一运力方真往这里 POST，handleKdCallback
    // 查不到 deliveryNo='quote' 会返 200 + 一条固定键告警，不会污染任何真实配送单。
    const fullInput: CreateDeliveryOrderInput = {
      deliveryNo: 'quote', callbackUrl: `${config.publicBaseUrl}/api/kd/quote`, callbackSalt: 'quote',
      sender: input.sender, receiver: input.receiver,
      goods: { title: '', weightKg: 0.5, totalPriceFen: 0, count: 1 }
    }
    const param = _buildOrderParam(fullInput, settings.kd100.providers, settings.kd100.goodsType)
    const data = await post('batchPrice', param, input.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    // batchPrice 响应 data.feeDetail[]：每项 kuaidiCom / distance(米) / discountFee(元)
    // ——注意这里官方文档写的是驼峰 kuaidiCom，与回调里的全小写 kuaidicom 不是同一个拼写，
    // 两种都读一遍再兜底，读不出编码的那一项不进快照（宁可少一家，也不要一堆 provider:"" 的行）。
    const fees = (data.data?.feeDetail as Record<string, unknown>[] | undefined) ?? []
    const quotes: ProviderQuote[] = []
    for (const f of fees) {
      const code = String(f.kuaidiCom ?? f.kuaidicom ?? '').trim()
      const fen = yuanToFen(f.discountFee)
      if (!code || fen === null) continue
      quotes.push({ provider: code, feeFen: fen, distanceM: toInt(f.distance ?? f.deliveryDistance) })
    }
    const feesFen = fees.map((f) => yuanToFen(f.discountFee)).filter((n): n is number => n !== null)
    return {
      feeFen: feesFen.length ? Math.min(...feesFen) : yuanToFen(data.data?.discountFee) ?? 0,
      distanceM: toInt(fees[0]?.distance ?? data.data?.deliveryDistance),
      quotes,
    }
  },
  async createOrder(input): Promise<CreateDeliveryOrderResult> {
    const settings = await import('../local-settings').then((m) => m.getLocalSettings())
    // input.providers 覆盖设置里的默认列表（规格 §10 的口子）；不传就是并呼默认那几家
    const param = _buildOrderParam(input, input.providers?.length ? input.providers : settings.kd100.providers, settings.kd100.goodsType)
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
  async queryCourier({ taskId, orderId }) {
    // ⚠️ 这个接口认的是 **orderId**（快递100 侧订单号，回调里的 orderId → Delivery.providerOrderId），
    // 不是并呼下单返回的 taskId。2026-09-06 生产 A/B 实测（只变参数名，其余完全相同）：
    //   { taskId }  → 30001「orderId不能为空」
    //   { orderId } → 200 success，返回 lbsType:2 与骑手坐标
    // 此前一直只传 taskId，所以顾客端「骑手位置」**从上线起没成功过一次**——
    // 而失败被 routes/orders.ts 的 catch 吞成 location:null，页面只是不显示卡片、不报错，
    // 于是没人发现。（同一家族的静默失败还有 price() 的 callbackUrl 空串，见本文件 price()。）
    // orderId 缺失时直接放弃：占位单（下单超时的 UNKNOWN）本来就没有它，硬打一发只会白挨一个 30001。
    if (!orderId) return null
    const data = await post('queryCourier', { orderId, taskId })
    // 坐标系必须是 GCJ-02（lbsType=2）才能和收货坐标同系比较：
    // 收货坐标来自 wx.chooseLocation，是 GCJ-02；BD-09（lbsType=1）与之相差数百米。
    // 官方默认是 2，但响应里会带回实际值——不是 2 就当拿不到位置（顾客端整块卡片隐藏），
    // 而不是照算一个悄悄偏几百米、还不报错的距离。快递100 FAQ「距离与实际严重不符」
    // 的头一条排查项就是它。真遇到 lbsType=1 再补 BD-09→GCJ-02 转换，别提前写没验过的算法。
    const lbsType = data.data?.lbsType
    if (lbsType != null && String(lbsType) !== '2') {
      console.warn(`[kd100] queryCourier 返回非 GCJ-02 坐标（lbsType=${String(lbsType)}），已按无位置处理`)
      return null
    }
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
