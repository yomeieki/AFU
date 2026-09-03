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
  price(input: { sender: CreateDeliveryOrderInput['sender']; receiver: CreateDeliveryOrderInput['receiver'] }): Promise<{ feeFen: number; distanceM: number | null }>
  createOrder(input: CreateDeliveryOrderInput): Promise<CreateDeliveryOrderResult>
  precancelOrder(i: { taskId: string }): Promise<{ cancelFeeFen: number | null }>
  cancelOrder(i: { taskId: string; reason: string }): Promise<{ cancelFeeFen: number | null; raw: unknown }>
  addTip(i: { taskId: string; amountFen: number }): Promise<void>
  queryCourier(i: { taskId: string }): Promise<{ latE6: number; lngE6: number } | null>
  verifyAndParseCallback(body: Record<string, string>, salt: string): { ok: true; payload: DeliveryCallbackPayload } | { ok: false; reason: 'SIGN_MISMATCH' | 'BAD_PARAM' }
}
