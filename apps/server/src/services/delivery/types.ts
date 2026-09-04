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
  /** 批量查价（快递100 batchPrice，免费不扣费）。feeFen = 六家里的最低价，quotes = 每家明细 */
  price(input: { sender: CreateDeliveryOrderInput['sender']; receiver: CreateDeliveryOrderInput['receiver'] }): Promise<{ feeFen: number; distanceM: number | null; quotes: ProviderQuote[] }>
  createOrder(input: CreateDeliveryOrderInput): Promise<CreateDeliveryOrderResult>
  precancelOrder(i: { taskId: string }): Promise<{ cancelFeeFen: number | null }>
  cancelOrder(i: { taskId: string; reason: string }): Promise<{ cancelFeeFen: number | null; raw: unknown }>
  addTip(i: { taskId: string; amountFen: number }): Promise<void>
  queryCourier(i: { taskId: string }): Promise<{ latE6: number; lngE6: number } | null>
  verifyAndParseCallback(body: Record<string, string>, salt: string): { ok: true; payload: DeliveryCallbackPayload } | { ok: false; reason: 'SIGN_MISMATCH' | 'BAD_PARAM' }
}
