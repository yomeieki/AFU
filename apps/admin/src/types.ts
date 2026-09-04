export type Channel = 'EXPRESS' | 'LOCAL'
export const CHANNEL_LABEL: Record<Channel, string> = { EXPRESS: '全国邮寄', LOCAL: '同城配送' }

export interface ApiResponse<T = unknown> {
  code: number
  message: string
  data: T
}

export interface PaginatedData<T> {
  list: T[]
  total: number
  page: number
  pageSize: number
}

export interface Category {
  id: number
  name: string
  iconUrl: string | null
  sortOrder: number
  status: number
  channel: Channel
  createdAt: string
  _count?: { products: number }
}

export interface SpecDimension {
  name: string
  values: string[]
}

export interface ProductSku {
  id?: number
  specText: string
  specValues: string[]
  price: number
  originalPrice: number | null
  stock: number
  sortOrder: number
}

export interface Product {
  id: number
  categoryId: number
  name: string
  subtitle: string | null
  coverImage: string | null
  price: number
  originalPrice: number | null
  stock: number
  unit: string
  weight: string | null
  shelfLife: string | null
  storageMethod: string | null
  deliveryInfo: string | null
  description: string | null
  status: 'ON_SHELF' | 'OFF_SHELF'
  deliveryType: string
  channel: Channel
  netWeightG: number | null
  isRecommended: number
  salesCount: number
  qrScene: string | null
  qrCodeUrl: string | null
  qrGeneratedAt: string | null
  deletedAt: string | null
  createdAt: string
  category?: { id: number; name: string }
  images?: { imageUrl: string }[]
  specDimensions?: SpecDimension[] | null
  skus?: ProductSku[]
}

export interface QrCodeResult {
  qrCodeUrl: string | null
  qrScene: string | null
  qrGeneratedAt: string | null
}

export interface OrderItem {
  productName: string
  productImage: string | null
  specText?: string | null
  quantity: number
  productPrice: number
  subtotal: number
}

export type OrderStatus = 'PENDING_PAYMENT' | 'PAID' | 'PREPARING' | 'SHIPPED' | 'COMPLETED' | 'CANCELLED' | 'REFUNDING' | 'REFUNDED'

export interface Shipment {
  id: number
  orderId: number
  expressCompany: string | null
  expressNo: string | null
  shippedAt: string | null
  remark: string | null
}

export type RefundStatus = 'PENDING' | 'PROCESSING' | 'SUCCESS' | 'ABNORMAL' | 'CLOSED' | 'FAILED'

/** 订单最近一条退款记录（列表接口附带） */
export interface RefundSummary {
  id: number
  status: RefundStatus
  outRefundNo: string
  amount: number
  mode: 'MOCK' | 'WECHAT'
  errorMessage: string | null
  createdAt: string
}

export type AfterSaleStatus = 'PENDING' | 'APPROVED' | 'DONE' | 'REJECTED'
export type AfterSaleReason = 'SHORTAGE' | 'WRONG' | 'DAMAGED' | 'OTHER'

export const AFTER_SALE_REASON_LABEL: Record<AfterSaleReason, string> = {
  SHORTAGE: '少发/漏发',
  WRONG: '错发',
  DAMAGED: '变质/破损',
  OTHER: '其他',
}
export const AFTER_SALE_STATUS_LABEL: Record<AfterSaleStatus, string> = {
  PENDING: '待处理',
  APPROVED: '已同意·退款中',
  DONE: '已退款',
  REJECTED: '已拒绝',
}

/** 订单列表附带的售后摘要（最近一条） */
export interface AfterSaleSummary {
  id: number
  status: AfterSaleStatus
  reason: AfterSaleReason
  createdAt: string
}

export interface Order {
  id: number
  orderNo: string
  status: OrderStatus
  totalAmount: number
  shippingFee: number
  actualAmount: number
  /** 已成功退款累计（分） */
  refundedAmount: number
  /** 可退余额（分），服务端计算 */
  remainingRefundable: number
  deliveryType: string
  receiverName: string
  receiverPhone: string
  receiverFullAddress: string
  remark?: string | null
  cancelReason?: string | null
  paidAt: string | null
  acceptedAt?: string | null
  completedAt?: string | null
  createdAt: string
  items: OrderItem[]
  shipment?: Shipment | null
  latestRefund?: RefundSummary | null
  afterSale?: AfterSaleSummary | null
}

/** 售后单（后台列表，含订单摘要） */
export interface AfterSale {
  id: number
  orderId: number
  orderNo: string
  userId: number
  reason: AfterSaleReason
  reasonLabel: string
  description: string | null
  images: string[]
  status: AfterSaleStatus
  reply: string | null
  refundId: number | null
  handledBy: string | null
  handledAt: string | null
  createdAt: string
  remainingRefundable: number
  order: {
    id: number
    orderNo: string
    status: OrderStatus
    actualAmount: number
    refundedAmount: number
    receiverName: string
    receiverPhone: string
    receiverFullAddress: string
    completedAt: string | null
    items: { productName: string; specText: string | null; quantity: number; subtotal: number }[]
    shipment: { expressCompany: string | null; expressNo: string | null; shippedAt: string | null } | null
  }
}

export interface AdminUser {
  id: number
  openid: string
  nickname: string | null
  avatarUrl: string | null
  phone: string | null
  status: number
  lastLoginAt: string | null
  createdAt: string
  orderCount: number
}

export interface UserOrder {
  id: number
  orderNo: string
  status: OrderStatus
  actualAmount: number
  createdAt: string
  items: { productName: string; quantity: number }[]
}

export interface Stats {
  today: {
    orderCount: number
    salesAmount: number
  }
  total: {
    orderCount: number
    productCount: number
    categoryCount: number
  }
  hotProducts: {
    id: number
    name: string
    coverImage: string | null
    salesCount: number
    price: number
  }[]
}

// 扫码统计
export interface ScanSummary {
  totalScans: number
  uniqueOpenids: number
  todayScans: number
  conversion: { scans: number; orders: number; rate: number | null }
}

export interface ScanTrendPoint {
  date: string
  scans: number
  uniqueOpenids: number
}

export interface ScanProductRow {
  productId: number
  productName: string
  scans: number
  orders: number
  conversionRate: number | null
}

export interface SalesTrendPoint {
  date: string
  orderCount: number
  salesAmount: number
}

// Banner
export interface Banner {
  id: number
  title: string | null
  imageUrl: string
  linkType: 'none' | 'product'
  productId: number | null
  sortOrder: number
  status: number
  createdAt: string
  updatedAt: string
}

/** 运费规则。金额单位「分」，与订单接口一致。 */
export interface ShippingSettings {
  /** 运费（分）。0 = 不收运费 */
  fee: number
  /** 满额包邮门槛（分），按商品小计判断。0 = 不设门槛 */
  freeThreshold: number
  /** 起送金额（分），按商品小计判断。0 = 无门槛 */
  minOrderAmount: number
}

/** 同城配送设置（与服务端 services/local-settings.ts 同构；金额分、坐标微度） */
export interface LocalDeliverySettings {
  version: number
  enabled: boolean
  paused: { until: string | null; reason: string } | null
  store: { name: string; phone: string; province: string; city: string; district: string; address: string; latE6: number | null; lngE6: number | null }
  radiusKm: number
  detourFactor: number
  fee: { baseFee: number; baseKm: number; perKmFee: number; freeThreshold: number; minOrderAmount: number }
  businessHours: { start: string; end: string }[]
  prepMinutes: number
  riderSpeedKmh: number
  acceptGraceMin: number
  autoCallDelayMin: number
  defaultProvider: 'KD100' | 'SELF'
  kd100: { providers: string[]; goodsType: string; defaultItemWeightG: number; insurance: boolean; autoDowngradeToSelfOnNoBalance: boolean }
  limits: { maxItems: number; maxWeightKg: number }
  callTimeoutMin: number
  acceptedStuckMin: number
  deliveringTimeoutMin: number
  tip: { maxPerCall: number; maxPerOrder: number }
}

/** 配送单（同城）。与服务端 Prisma Delivery 模型同构，仅取前端用得到的字段。 */
export interface DeliveryInfo {
  id: number
  deliveryNo: string
  provider: 'KD100' | 'SELF' | 'MOCK'
  status: string
  statusRank: number
  activeOrderId: number | null
  courierCompany: string | null
  courierName: string | null
  courierMobile: string | null
  quotedFee: number | null
  actualFee: number | null
  tipFee: number
  cancelFee: number
  providerDistanceM: number | null
  errorCode: string | null
  failReason: string | null
  calledAt: string | null
  acceptedAt: string | null
  pickedUpAt: string | null
  deliveredAt: string | null
  cancelledAt: string | null
  cancelReason: string | null
}

/** 配送单事件时间线（与服务端 DeliveryEvent 模型同构，仅取前端用得到的字段） */
export interface DeliveryEventInfo {
  id: number
  source: string
  providerStatus: number | null
  statusDesc: string | null
  courierName: string | null
  operator: string | null
  createdAt: string
}

/** 工作台看板卡片。与服务端 GET /admin/workbench/snapshot 的 toCard() 同构 */
export interface WorkbenchCard {
  orderId: number
  orderNo: string
  channel: Channel
  status: string
  /** 本列计时锚点 ISO：pending=paidAt / preparing=acceptedAt / waitingCourier=delivery.calledAt / delivering=同城取货或邮寄发货 / done=completedAt */
  waitSince: string
  amountFen: number
  items: { first: string[]; kinds: number; units: number }
  note: string | null
  receiver: { name: string; phone: string }
  express: { province: string; city: string; expressCompany: string | null; expressNo: string | null } | null
  local: {
    distanceM: number | null
    cancelRequested: boolean
    delivery: { status: string; statusLabel: string; courierName: string | null; courierMobile: string | null } | null
  } | null
}

/** 工作台看板快照。与服务端 GET /admin/workbench/snapshot 响应同构 */
export interface WorkbenchSnapshot {
  columns: {
    pending: WorkbenchCard[]
    preparing: WorkbenchCard[]
    waitingCourier: WorkbenchCard[]
    delivering: WorkbenchCard[]
    done: WorkbenchCard[]
  }
  stats: { todayOrders: number; todayRevenueFen: number; avgDeliverMinutes: number | null }
  circuit: { tripped: boolean }
  localEnabled: boolean
  localOpenNow: boolean
  paused: { reason: string; until: string | null } | null
  /** M2b 接飞鹅打印机后替换 */
  printer: { status: 'NOT_CONNECTED' }
  /** 未处理取消申请 + ABNORMAL/UNKNOWN 在途配送单 + 熔断(1) */
  pendingAlerts: number
  now: string
}

/** 拒单原因（顾客原样可见的文案由服务端映射） */
export type RejectReason = 'SOLD_OUT' | 'OUT_OF_RANGE' | 'PAST_ACCEPT_TIME' | 'CUSTOMER_CANCEL' | 'OTHER'
