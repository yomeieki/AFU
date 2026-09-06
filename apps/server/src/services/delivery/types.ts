/**
 * 配送引擎类型定义
 */

export type ProviderErrorKind = 'CONFIG' | 'CAPACITY' | 'BALANCE' | 'TIMEOUT' | 'BUSINESS'

export class ProviderError extends Error {
  name = 'ProviderError'
  constructor(
    public kind: ProviderErrorKind,
    public code: string,
    message: string,
    public raw?: unknown,
  ) {
    super(message)
  }
}

export interface CreateDeliveryOrderInput {
  deliveryNo: string
  /**
   * 本次呼叫指定的运力列表（kuaidicom 编码），不传则用设置里的默认列表。
   * 规格 §10：留口子给将来的「指定单家运力」，用具名列表而不是 oneToOne 布尔值——
   * 哪家算「一对一」是运营选择，不该焊死在代码里。
   */
  providers?: string[]
  callbackUrl: string
  callbackSalt: string
  sender: {
    name: string
    mobile: string
    province: string
    city: string
    district: string
    address: string
    latE6: number
    lngE6: number
  }
  receiver: {
    name: string
    mobile: string
    province: string
    city: string
    district: string
    address: string
    latE6: number
    lngE6: number
  }
  goods: {
    title: string
    weightKg: number
    totalPriceFen: number
    count: number
  }
  remark?: string
}

/** 单家运力的一条报价。provider = 快递100 kuaidicom 编码，与回调里的中标运力同一套编码 */
export interface ProviderQuote {
  provider: string
  feeFen: number
  distanceM: number | null
}

export interface CreateDeliveryOrderResult {
  taskId: string | null
  providerOrderId: string | null
  quotedFeeFen: number | null
  distanceM: number | null
  /**
   * 下单那一刻**每一家被呼运力各自的预扣**（batchOrder 响应 fee[]），落 Delivery.orderFees。
   *
   * 与 price() 返回的 quotes 结构相同但语义不同：那个是免费查价（可能是几分钟前的），
   * 这个是运力方真金白银冻结的数——2026-09-06 首单实测，快递100 企业后台四行扣费明细
   * 与这里的四条一一对上。中标运力接单后 actualFee 就从这里认领（见 callback.ts）。
   * 拿不到编码的项不进列表（同 price()：宁可少一家，也不要一堆 provider:"" 的行）。
   */
  quotes: ProviderQuote[]
  raw: unknown
}

export interface DeliveryCallbackPayload {
  taskId: string
  providerStatus: string
  statusDesc: string | null
  courierCompany: string | null
  courierName: string | null
  courierMobile: string | null
  providerUpdateTime: Date | null
  raw: Record<string, unknown>
}

export interface DeliveryProvider {
  readonly name: 'KD100' | 'MOCK'
  /**
   * 批量查价（快递100 batchPrice，免费不扣费）。feeFen = 六家里的最低价，quotes = 每家明细。
   *
   * `timeoutMs` 只对本次查价生效，不传按全局默认（8 秒）。之所以做成**逐次可指定**而不是调小全局：
   * 顾客在地址页等报价，5 秒不回就该退回估算；店员侧的呼叫弹窗/报价保鲜是内部操作，
   * 宁可多等几秒也要拿到真数据。把全局改成 5 秒会把店员侧一并改掉，把顾客侧改成 8 秒则是让顾客干等。
   */
  price(input: {
    sender: CreateDeliveryOrderInput['sender']
    receiver: CreateDeliveryOrderInput['receiver']
    timeoutMs?: number
  }): Promise<{ feeFen: number; distanceM: number | null; quotes: ProviderQuote[] }>
  createOrder(input: CreateDeliveryOrderInput): Promise<CreateDeliveryOrderResult>
  precancelOrder(i: { taskId: string }): Promise<{ cancelFeeFen: number | null }>
  cancelOrder(i: { taskId: string; reason: string }): Promise<{ cancelFeeFen: number | null; raw: unknown }>
  addTip(i: { taskId: string; amountFen: number }): Promise<void>
  // orderId 才是这个接口认的键（快递100 侧订单号 = Delivery.providerOrderId）；taskId 一并传只是冗余。
  // 2026-09-06 生产实测：只传 taskId 会被拒 30001「orderId不能为空」。
  queryCourier(i: { taskId: string; orderId: string | null }): Promise<{ latE6: number; lngE6: number } | null>
  verifyAndParseCallback(body: Record<string, string>, salt: string): { ok: true; payload: DeliveryCallbackPayload } | { ok: false; reason: 'SIGN_MISMATCH' | 'BAD_PARAM' }
}
