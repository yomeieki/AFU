export type Channel = 'EXPRESS' | 'LOCAL'
export const CHANNEL_LABEL: Record<Channel, string> = { EXPRESS: '全国邮寄', LOCAL: '同城配送' }

/** 订单履约渠道：在销售渠道之上多一个「到店自取」（商品/购物车仍按 LOCAL 渠道，见 spec P14） */
export type OrderChannel = Channel | 'PICKUP'

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

/** 分类内商品排序方式（2026-09-17 分类内排序设计 §S2）：MANUAL=手动拖拽，SALES_30D=近 30 天销量降序 */
export const PRODUCT_SORT_MODES = ['MANUAL', 'SALES_30D'] as const
export type ProductSortMode = (typeof PRODUCT_SORT_MODES)[number]

export interface Category {
  id: number
  name: string
  iconUrl: string | null
  sortOrder: number
  status: number
  channel: Channel
  productSortMode: ProductSortMode
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
  /** 单件打包费（分）；null = 跟随全店默认，0 = 这道菜不收 */
  packingFeeFen: number | null
  isRecommended: number
  salesCount: number
  /** 分类内手动排序值，同分类从小到大（2026-09-17 分类内排序设计 §3.1） */
  sortOrder: number
  /** 近 30 天销量；仅 GET /api/admin/products 返回，其它接口（如创建/更新响应）没有这个字段 */
  sales30d?: number
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
  /** 订单详情接口返回的是完整 OrderItem 行；商品被删时为 null（拒单售罄勾选要用它） */
  productId?: number | null
  productName: string
  productImage: string | null
  specText?: string | null
  quantity: number
  productPrice: number
  subtotal: number
  /** M2：随单赠品。赠品行 productPrice/subtotal 恒为 0，靠这个标区分「免费的」与「0 元 bug」 */
  isGift?: boolean
  /** M2：单件积分价 */
  pointsCost?: number
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
  /** 列表与详情都返回（M2 把它加进了 orderListSelect）。M3「发赔偿券」要用——发券端点是用户维度的 */
  userId?: number
  status: OrderStatus
  totalAmount: number
  shippingFee: number
  /** 打包费（分）。邮寄单恒为 0 */
  packingFee?: number
  actualAmount: number
  /** M2：券抵扣额（分） */
  discountAmount?: number
  /** M2：赠品消耗的积分 */
  pointsUsed?: number
  /** M2：本单获得的积分 */
  pointsEarned?: number
  /** M2：用的哪张券（普通 Int 列，无关系字段；详情接口另给 coupon 对象） */
  couponId?: number | null
  /** 已成功退款累计（分） */
  refundedAmount: number
  /** 可退余额（分），服务端计算 */
  remainingRefundable: number
  deliveryType: string
  receiverName: string
  receiverPhone: string
  receiverFullAddress: string
  /** 同城单为「区+详细地址」，邮寄单同 receiverFullAddress。服务端算好，前端直接显示 */
  receiverDisplayAddress?: string
  remark?: string | null
  /** 餐具选择（2026-09-14 设计）。列表与详情都返回；邮寄单、老订单为 null */
  tablewareMode?: string | null
  tablewareCount?: number | null
  cancelReason?: string | null
  paidAt: string | null
  acceptedAt?: string | null
  completedAt?: string | null
  /** 以下同城字段仅 GET /admin/orders/:id 返回（列表接口精简后没有） */
  estimatedDeliveryAt?: string | null
  /** 计费距离（米） */
  distanceM?: number | null
  cancelRequestedAt?: string | null
  cancelRequestNote?: string | null
  /** 自取单：取餐时段起点 / 备好时刻 / 自取优惠（分）。非自取单为 null/0 */
  pickupAt?: string | null
  pickupReadyAt?: string | null
  pickupDiscountAmount?: number
  /** 满减（分），下单时快照（2026-09-17 全店满减设计）。非参加单为 0 */
  promoDiscountAmount?: number
  createdAt: string
  items: OrderItem[]
  shipment?: Shipment | null
  latestRefund?: RefundSummary | null
  afterSale?: AfterSaleSummary | null
  /** M2/M3：本单用的那张券的快照，仅详情接口返回；没用券为 null */
  coupon?: OrderCoupon | null
}

/** 订单详情里的券快照。比顾客端多 source/issuedBy/remark——售后要看「是不是我们自己补的」 */
export interface OrderCoupon {
  name: string
  code: string
  amount: number
  threshold: number
  source: CouponSource
  issuedBy: string | null
  remark: string | null
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
    /** 券前商品小计（分） */
    totalAmount: number
    shippingFee: number
    actualAmount: number
    refundedAmount: number
    /** M2/M3：券抵扣额。>0 时售后面板与退款弹窗都要显式提示「实付里已经扣过券」 */
    discountAmount: number
    /** M2/M3：赠品消耗的积分 */
    pointsUsed: number
    receiverName: string
    receiverPhone: string
    receiverFullAddress: string
    receiverDisplayAddress?: string
    completedAt: string | null
    items: { productName: string; specText: string | null; quantity: number; subtotal: number; isGift?: boolean }[]
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
  /** M3：当前积分余额 */
  pointsBalance: number
  /** M3：可用券张数（UNUSED 且未过期，服务端按时间判，不依赖定时任务跑没跑） */
  availableCoupons: number
}

export interface UserOrder {
  id: number
  orderNo: string
  status: OrderStatus
  actualAmount: number
  createdAt: string
  items: { productName: string; quantity: number }[]
}

// 扫码统计
export interface ScanSummary {
  totalScans: number
  /** 扫过码的**登录用户**数。匿名扫码（无 userId）只进 totalScans，不进这个数 */
  uniqueVisitors: number
  todayScans: number
  conversion: { scans: number; orders: number; rate: number | null }
}

export interface ScanTrendPoint {
  date: string
  scans: number
  /** 扫过码的**登录用户**数。匿名扫码（无 userId）只进 totalScans，不进这个数 */
  uniqueVisitors: number
}

export interface ScanProductRow {
  productId: number
  productName: string
  scans: number
  orders: number
  conversionRate: number | null
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

/** 邮寄设置（与服务端 services/express-settings.ts 同构；金额分、重量克） */
export interface RegionGroup { name: string; provinces: string[]; freeShipMinFen: number; tableFirstFen: number; tableOverPerKgFen: number; blocked: boolean }
export interface ExpressSettings {
  version: number
  weight: { packagingG: number; defaultItemG: number }
  pricingPool: string[]
  fee: { mode: 'QUOTE' | 'TABLE'; markupFen: number; roundToFen: number; minQuoteCount: number }
  minOrderAmountFen: number
  regionGroups: RegionGroup[]
  acceptGraceMin: number
  pickup: { cargoName: string; defaultRemark: string; unacceptedRemindHours: number; unpickedRemindMin: number }
  costAlertRatio: number
}

export interface PickupSettings {
  enabled: boolean
  paused: { until: string | null; reason: string } | null
  /** 取餐时段粒度（分） */
  slotMinutes: number
  /** 接单缓冲（分）：最早可取 = 现在 + 缓冲 + 备餐，向上取整到粒度 */
  acceptBufferMin: number
  /** 可预订天数：0=仅今天，1=今天+明天 */
  daysAhead: number
  minOrderAmountFen: number
  /** PERCENT 的 value 是「按几折收」（90 = 九折，减 10%）；FIXED 的 value 是立减分数 */
  discount: { type: 'NONE' | 'PERCENT' | 'FIXED'; value: number }
  autoCompleteAfterMin: number
  unpickedRemindAfterMin: number
}

/**
 * 全店自动满减（与服务端 services/local-settings.ts 同构；2026-09-17 设计）。
 * `channels` 的键直接用 `DeliveryType`（`LOCAL`/`PICKUP`/`EXPRESS`），不是设计稿草案的
 * `LOCAL_DELIVERY`——00 规划定稿后店主对「冲突 5」的裁定，两套值域本来就一一对应。
 */
export interface PromotionTier { minFen: number; cutFen: number }
export interface PromotionSettings {
  enabled: boolean
  name: string
  /** ISO 8601（带时区）。null = 立即生效 */
  startAt: string | null
  /** ISO 8601（带时区）。null = 长期有效 */
  endAt: string | null
  channels: { LOCAL: boolean; PICKUP: boolean; EXPRESS: boolean }
  /** 按 minFen 升序、去重、≤ 10 档 */
  tiers: PromotionTier[]
}

/** 同城配送设置（与服务端 services/local-settings.ts 同构；金额分、坐标微度） */
export interface LocalDeliverySettings {
  version: number
  enabled: boolean
  paused: { until: string | null; reason: string } | null
  pickup: PickupSettings
  holiday: { until: string | null; reason: string } | null
  store: { name: string; phone: string; province: string; city: string; district: string; address: string; latE6: number | null; lngE6: number | null }
  radiusKm: number
  detourFactor: number
  fee: {
    baseFee: number; baseKm: number; perKmFee: number; minOrderAmount: number
    /** 阶梯满额免运费：满 minAmountFen 且距离 ≤ maxKm 就免。空数组 = 关闭。按**券前**商品小计判 */
    freeShipTiers: { minAmountFen: number; maxKm: number }[]
    /** QUOTE = 按实时最低报价 + 加价定价（默认）；TABLE = 起步价 + 每公里的固定表（也是查价失败时的兜底） */
    mode: 'TABLE' | 'QUOTE'
    /** QUOTE 口径下在最低报价之上加多少（分）——第一级接得掉时，这就是每单毛利。远单档 */
    quoteMarkupFen: number
    /** 近单分界（km，道路距离）。0 = 不分档 */
    quoteNearKm: number
    /** 近单（≤ quoteNearKm）的加价（分） */
    quoteNearMarkupFen: number
    /** 向上取整到这个粒度（分）；0 = 不取整 */
    roundToFen: number
  }
  businessHours: { start: string; end: string }[]
  /** 打包费：整店默认每份多少钱，商品可各自覆盖（见 Product.packingFeeFen） */
  packing: { enabled: boolean; perItemFen: number }
  /** 全店自动满减（2026-09-17 设计） */
  promotion: PromotionSettings
  /** 平时备餐时长（分）。**从店员点接单开始算**，不含顾客下单到接单那一段 */
  prepMinutes: number
  /** 高峰时段：备餐排队。prepMin/prepMax 是范围——结算页如实给顾客看区间，算预计送达取上界 */
  peak: { windows: { start: string; end: string }[]; prepMinMinutes: number; prepMaxMinutes: number }
  riderSpeedKmh: number
  /** 呼叫骑手 → 骑手到店取走要多久（分）。自动呼叫开着时与备餐并行，手动呼叫时保守按串行算 */
  callToPickupMin: number
  acceptGraceMin: number
  autoCallDelayMin: number
  defaultProvider: 'KD100' | 'SELF'
  kd100: { providers: string[]; goodsType: string; defaultItemWeightG: number; insurance: boolean; autoDowngradeToSelfOnNoBalance: boolean }
  // 呼叫策略。CHEAPEST_N = 并呼报价最低的 N 家（默认 N=3，2026-09-07 店主定）；
  // SOLO_LOWEST = 只呼最低那一家（最省冻结额度，但抢单成功率最低）；ALL = 并呼全表（旧行为）。
  // escalateAfterMin 分钟无人接单则自动取消重呼、升级为并呼；0 = 不自动升级。
  callStrategy: { mode: 'SOLO_LOWEST' | 'CHEAPEST_N' | 'ALL'; cheapestN: number; escalateAfterMin: number }
  limits: { maxItems: number; maxWeightKg: number }
  callTimeoutMin: number
  acceptedStuckMin: number
  deliveringTimeoutMin: number
  tip: { maxPerCall: number; maxPerOrder: number }
}

/** 单家运力的一条报价/预扣。provider = 快递100 kuaidicom 编码，与中标运力同一套编码 */
export interface ProviderQuote {
  provider: string
  feeFen: number
  distanceM: number | null
}

/** 呼叫当次的报价快照（server services/delivery/quote.ts 的 QuoteSnapshot） */
export interface QuoteSnapshot {
  at: string
  provider: string
  quotes: ProviderQuote[]
  lowest: { provider: string; feeFen: number } | null
}

/** 骑手实时位置 + 距离/ETA（管理端 GET /admin/local/orders/:id/courier） */
export interface CourierLive {
  location: { latE6: number; lngE6: number } | null
  fetchedAt: string | null
  toStoreM: number | null
  toReceiverM: number | null
  etaMinutes: number | null
  phase: 'TO_STORE' | 'TO_RECEIVER' | null
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
  // ⚠️ quotedFee 是**下单那一刻被冻结的钱**，不是「中标运力的报价」。并呼时每家各冻一笔，
  // 这一列取其中最低的那笔；中标方到底扣了多少在 actualFee（由回调按中标运力认领）。
  // 首单就是在这里显示错的：并呼 7 家、闪送 ¥23.32 中标，而页面显示 ¥16.23（达达的报价）。
  quotedFee: number | null
  actualFee: number | null
  tipFee: number
  cancelFee: number
  providerDistanceM: number | null
  /** 呼叫当次的各家报价快照（结构见 server services/delivery/quote.ts） */
  quoteSnapshot: QuoteSnapshot | null
  quotedAt: string | null
  /** 本单实际呼了哪些运力（kuaidicom 编码） */
  calledProviders: string[] | null
  /** SOLO | CHEAPEST | ALL | MANUAL | SOLO_HELD | CHEAPEST_HELD；null = 策略上线前的历史单 */
  callStrategy: string | null
  /** 下单那一刻**各家各自的预扣**（batchOrder 的 fee[]），比呼叫前的报价快照更权威 */
  orderFees: ProviderQuote[] | null
  providerOrderId: string | null
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

/** 邮寄取件预约详情。与服务端 services/delivery/express-booking.ts 的 BookingView 同构 */
export interface ExpressBookingView {
  id: number
  bookingNo: string
  status: string
  statusLabel: string
  kuaidicom: string
  courierLabel: string
  serviceType: string | null
  kuaidinum: string | null
  dayType: string | null
  pickupDate: string | null
  pickupStart: string | null
  pickupEnd: string | null
  slotText: string
  weightKg: number
  customerFeeFen: number
  quotedFeeFen: number | null
  prepaidFeeFen: number | null
  settledFeeFen: number | null
  billedWeightG: number | null
  courierName: string | null
  courierMobile: string | null
  failReason: string | null
  cancelledBy: string | null
  bookedAt: string | null
  acceptedAt: string | null
  pickedAt: string | null
  deliveredAt: string | null
  cancelledAt: string | null
  /** 批次三：轨迹摘要（trackJson 由快递100 推送落库） */
  trackStatus: string | null
  trackUpdatedAt: string | null
  trackCount: number
  latestTrack: { context: string; ftime: string } | null
}

/** 邮寄预约事件时间线（与服务端 ExpressBookingEvent 模型同构，仅取前端用得到的字段） */
export interface ExpressBookingEventInfo {
  id: number
  source: string
  providerStatus: number | null
  statusDesc: string | null
  courierName: string | null
  operator: string | null
  createdAt: string
}

/** 预约取件弹窗用的报价（GET /admin/express/orders/:id/quotes） */
export interface ExpressBookingQuotes {
  quotes: { kuaidicom: string; serviceType: string | null; priceFen: number | null; defPriceFen: number | null }[]
  weightKg: number
  customerFeeFen: number
  fromSnapshot: boolean
  quotedAt: string | null
  suggestedSlot: { dayType: '今天' | '明天' | '后天'; pickupStart: string | null; pickupEnd: string | null }
  couriers: { code: string; label: string }[]
  /** 邮寄设置 pickup.defaultRemark，弹窗备注首帧预填用（spec §5.2） */
  defaultRemark: string
}

/** 工作台看板卡片。与服务端 GET /admin/workbench/snapshot 的 toCard() 同构 */
export interface WorkbenchCard {
  orderId: number
  orderNo: string
  channel: OrderChannel
  status: string
  /** 本列计时锚点 ISO：pending=paidAt / preparing=acceptedAt / waitingCourier=delivery.calledAt / delivering=同城取货或邮寄发货 / done=completedAt */
  waitSince: string
  amountFen: number
  items: { first: string[]; kinds: number; units: number }
  note: string | null
  /** 餐具选择（2026-09-14 设计）。同城/自取单才有；老单为 null */
  tableware: { mode: string; count: number | null } | null
  receiver: { name: string; phone: string }
  express: {
    province: string; city: string; expressCompany: string | null; expressNo: string | null
    /** 最近一条取件预约（不分终态/活跃）；null = 从未预约过 */
    booking: {
      status: string; statusLabel: string; courierLabel: string; courierName: string | null; courierMobile: string | null
      slotText: string; kuaidinum: string | null; failReason: string | null; bookedAt: string | null
      /** 原始快递公司编码（如 'shunfeng'）与改约用得到的原始时段字段——courierLabel/slotText 都是格式化后的展示文案，
       *  ModifySlotModal 改约预填 / 识别顺丰必填时段要用这几个原始值，不能从展示文案里反查 */
      kuaidicom: string; dayType: string | null; pickupDate: string | null; pickupStart: string | null; pickupEnd: string | null
    } | null
    cancelRequested: boolean
    /** 取消申请被驳回过：AUTO=接单满 expressAcceptGraceMin 分钟系统自动驳回，MANUAL=店员点的。null=没被驳回过 */
    cancelRejected: 'AUTO' | 'MANUAL' | null
    /** 接单时刻。卡片用它 + snapshot.expressAcceptGraceMin 自己算「还剩多久自动驳回」的倒计时 */
    acceptedAt: string | null
  } | null
  local: {
    distanceM: number | null
    estimatedDeliveryAt: string | null   // 规格 §3 要求同城卡片出现「预计送达」，来自 Order.estimatedDeliveryAt
    cancelRequested: boolean
    /** 取消申请被驳回过：AUTO=接单满 5 分钟系统自动驳回，MANUAL=店员点的。null=没被驳回过 */
    cancelRejected: 'AUTO' | 'MANUAL' | null
    /** 接单时刻。卡片用它 + snapshot.acceptGraceMin 自己算「还剩多久自动驳回」的倒计时 */
    acceptedAt: string | null
    delivery: {
      status: string; statusLabel: string; courierName: string | null; courierMobile: string | null
      /** 'SELF' = 店内自送，其余是快递100 的运力方。「已完成」列靠它区分「自送」与「骑手」 */
      provider?: string | null
      /** 最近一次呼叫骑手失败（运力方拒单/下单报错），订单还停在备餐中等店员重呼或改自送。服务端可选下发 */
      callFailed?: boolean
    } | null
  } | null
  /** 自取单（deliveryType=PICKUP）。与服务端 workbench.ts toCard 的 pickup 同构 */
  pickup: {
    pickupAt: string | null
    pickupReadyAt: string | null
    /** 开始备餐时刻 = pickupAt − 备餐时长 − acceptBufferMin（服务端 prepStartAt） */
    prepStartAt: string | null
    /** 「今天 12:00–12:30」，服务端按快照时刻算好 */
    slotLabel: string
    cancelRequested: boolean
    cancelRejected: 'AUTO' | 'MANUAL' | null
    acceptedAt: string | null
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
  /** 顾客可申请取消 / 店员可处理的窗口（分钟，从接单起算）——同一条线，见服务端「甲」口径 */
  acceptGraceMin: number
  /** 邮寄版本的「甲」口径宽限分钟数，与 acceptGraceMin 各自可调，不能混用 */
  expressAcceptGraceMin: number
  paused: { reason: string; until: string | null } | null
  pickupEnabled: boolean
  pickupPaused: { reason: string; until: string | null } | null
  /** 休业总开关（P12）：外送与自取一起停，邮寄不受影响。until 为 'YYYY-MM-DD' 或 null */
  holiday: { until: string | null; reason: string } | null
  /** 多台打印机取「最差」状态归并（见服务端 workbench.ts 的 summarizePrinterStatus） */
  printer: {
    status: 'NOT_CONNECTED' | 'ONLINE' | 'ABNORMAL' | 'OFFLINE'
    printers: { sn: string; name: string; state: string }[]
  }
  /** 未处理取消申请 + ABNORMAL/UNKNOWN 在途配送单 + 熔断(1) */
  pendingAlerts: number
  now: string
}

/** 拒单原因（顾客原样可见的文案由服务端映射） */
export type RejectReason = 'SOLD_OUT' | 'OUT_OF_RANGE' | 'PAST_ACCEPT_TIME' | 'CUSTOMER_CANCEL' | 'OTHER'

// ─────────────────────────────────────────────────────────
// 打印机（飞鹅云）。与服务端 services/printer-settings.ts / services/ticket/index.ts 同构。
// ─────────────────────────────────────────────────────────
export type PrinterChannel = 'LOCAL' | 'EXPRESS'

export interface PrinterEntry {
  sn: string
  name: string
  channels: PrinterChannel[]
  /** 打印份数，1–10 */
  copies: number
}

/** 打印机运营设置（GET/PUT /admin/settings/printer）。PUT 是整包覆盖，见 PrinterSettings.tsx 顶部注释。 */
export interface PrinterSettings {
  enabled: boolean
  provider: 'FEIE' | 'XPYUN'
  printers: PrinterEntry[]
  voice: { enabled: boolean; localText: string; expressText: string }
  repeat: {
    /** 同城单：付款后多少分钟未接单开始重复播报 */
    localAfterMin: number
    /** 邮寄单：付款后多少分钟未接单开始重复播报 */
    expressAfterMin: number
    /** 重复播报间隔（分钟） */
    everyMin: number
    /** 最多重复次数，耗尽后告警老板 */
    maxTimes: number
    /** true = 重复播报时重打整张全票；false = 只打精简「催接单」小票 */
    reprint: boolean
  }
  /** 打印机连续离线超过多少分钟告警老板 */
  offlineAlertMin: number
  /** 取消/退款是否也出提醒票 */
  printCancel: boolean
}

/** 现查一次打印机在线状态（GET /admin/printers/status） */
export interface PrinterHealthEntry {
  sn: string
  name: string
  state: 'ONLINE' | 'ABNORMAL' | 'OFFLINE' | 'UNKNOWN' | 'ERROR'
  raw?: string
}

/** 打印记录（GET /admin/print-jobs） */
export interface PrintJob {
  id: number
  orderId: number
  orderNo: string
  kind: 'NEW_ORDER' | 'REPEAT' | 'CANCEL' | 'REPRINT' | 'TEST' | 'CANCEL_REQUEST' | 'RESUME'
  provider: string
  printerSn: string
  status: 'PENDING' | 'SENDING' | 'SENT' | 'PRINTED' | 'FAILED' | 'SKIPPED'
  providerJobId: string | null
  attempts: number
  lastError: string | null
  copies: number
  sentAt: string | null
  printedAt: string | null
  createdAt: string
  updatedAt: string
}

/** 后台绑定/测试页/重打等操作的通用返回（与服务端 EnqueueResult 同构） */
export interface PrinterEnqueueResult {
  enqueued: boolean
  reason?: string
  jobIds?: number[]
}

// ─────────────────────────────────────────────────────────
// 会员：券模板 / 用户券 / 积分赠品 / 积分流水 / 会员设置（M3）
// 字段与 spec §4 的模型逐字对应，金额一律是**分**
// ─────────────────────────────────────────────────────────

/** 券的发放路径。决定这张模板能从哪条口子发出去，建后不可改 */
export type CouponSource = 'ADMIN' | 'POINTS' | 'CAMPAIGN' | 'NEWCOMER'
/** 券的适用渠道。ALL = 两种配送都能用 */
export type CouponChannel = 'ALL' | 'LOCAL' | 'EXPRESS'
export type CouponStatus = 'UNUSED' | 'USED' | 'EXPIRED'
/** 上下架。券模板与积分赠品共用这一组字面量 */
export type OnOff = 'ON' | 'OFF'

export interface CouponTemplate {
  id: number
  name: string
  description: string | null
  /** 面额（分） */
  amount: number
  /** 门槛（分），0 = 无门槛 */
  threshold: number
  channel: CouponChannel
  source: CouponSource
  /** 领到后多少天过期 */
  validDays: number
  /** 仅 source='POINTS' 有值 */
  pointsCost: number | null
  totalLimit: number | null
  perUserLimit: number | null
  /**
   * ⚠️ **不要拿这个当「已发」显示，用 `issuedTotal`。**
   * 它是限量券的并发防线（`updateMany` 条件递增），只有 POINTS / CAMPAIGN 两条自助
   * 路径会递增；ADMIN 定向发放与 NEWCOMER 新客券都不递增，拿它显示会永远是 0。
   */
  issuedCount: number
  /** 真实发出去的张数（服务端按 UserCoupon 行数统计）。「已发」列用这个 */
  issuedTotal: number
  /** 其中已核销的张数 */
  usedCount: number
  /**
   * 这张模板正被「会员设置」选为新客券。
   * 停用它 = 新注册的顾客从此收不到见面礼，而那个后果在券模板页上是看不见的
   * （停用走的是这个接口，它本身完全不知道会员设置的存在）。列表标出来 + 停用时加重确认。
   */
  usedAsNewcomer: boolean
  sortOrder: number
  status: OnOff
  createdAt: string
  updatedAt: string
}

/** 某个用户名下的一张券。管理端可见 issuedBy/remark，顾客端不可见 */
export interface UserCouponRow {
  id: number
  templateId: number
  code: string
  name: string
  amount: number
  threshold: number
  channel: CouponChannel
  status: CouponStatus
  source: CouponSource
  /** 发放来源引用：ADMIN 券填的是补偿针对的订单号 */
  sourceRef: string | null
  /** 哪个管理员发的，仅 ADMIN 券有值 */
  issuedBy: string | null
  /** 发放原因，仅 ADMIN 券有值 */
  remark: string | null
  expiresAt: string
  usedAt: string | null
  orderId: number | null
  /** 核销在哪一单，服务端联查补上 */
  orderNo: string | null
  createdAt: string
}

/** 券模板的发放记录一行（GET /admin/coupon-templates/:id/issued） */
export interface CouponIssuedRow {
  id: number
  code: string
  status: CouponStatus
  source: CouponSource
  issuedBy: string | null
  remark: string | null
  sourceRef: string | null
  expiresAt: string
  usedAt: string | null
  orderId: number | null
  createdAt: string
  user: { id: number; nickname: string | null }
}

/**
 * 随单赠品配置：顾客在结算页用积分加购、跟着付费订单一起履约的商品。
 * `productId`/`skuId` 建后不可改（改了就是换了一件商品，等于另一条配置）。
 */
export interface PointsGood {
  id: number
  productId: number
  skuId: number | null
  /** 单件积分价 */
  pointsCost: number
  /** 每单最多加购几件 */
  perOrderLimit: number
  /** 总发放上限，null = 不限 */
  stockLimit: number | null
  /** 已发放件数，配合 stockLimit 判剩余 */
  issuedCount: number
  sortOrder: number
  status: OnOff
  createdAt: string
  updatedAt: string
  // 以下由服务端联查补上（PointsGood 没有 product/sku 关系字段）
  productName: string | null
  productImage: string | null
  /**
   * 商品当前状态。前两个是 `Product.status` 原值（**是 `ON_SHELF`/`OFF_SHELF`，不是 `ON`/`OFF`**——
   * 与本文件里券模板/赠品自身的 `OnOff` 不是一回事，写混会得到一个 `undefined` 的查表结果），
   * `DELETED` = 商品已软删，`MISSING` = 按 id 查不到。后三种在顾客侧都是隐形的
   * （`loadCheckoutOptions` 会过滤掉），页面必须显式标出来，否则店主永远不知道这条赠品是死的。
   */
  productStatus: 'ON_SHELF' | 'OFF_SHELF' | 'DELETED' | 'MISSING'
  productChannel: string | null
  specText: string | null
  /** 商品（或所选规格）的当前库存 */
  stock: number
  /** 商品（或所选规格）的当前售价（分）；商品已删除时为 null。算「等值消费 / 回报率」用 */
  unitPrice: number | null
}

/** 积分流水类型。中文标签由服务端给（typeLabel），前端不再自己 map */
export type PointsLedgerType =
  | 'EARN'
  | 'REDEEM'
  | 'GIFT'
  | 'GIFT_REVERT'
  | 'REFUND_DEDUCT'
  | 'EXPIRE'
  | 'ADMIN'

export interface PointsLedgerRow {
  id: number
  type: PointsLedgerType | string
  /** 服务端拼好的中文标签；未知 type 会原样回落成字面量 */
  typeLabel: string
  /** 正 = 入账，负 = 出账 */
  delta: number
  balanceAfter: number
  refType: string
  refId: string
  /** refType='ORDER' 时服务端联查补上，其余为 null */
  orderNo: string | null
  remark: string | null
  /** 入账行才有意义：这批分什么时候过期 */
  expiresAt: string | null
  createdAt: string
}

/**
 * 会员总开关与参数（KV 存储，服务端 60s 缓存）。
 * `points.enabled=false` 的语义是 **只停发新分**，已有积分照常能花（PO 2026-09-05 裁决）。
 */
export interface MemberSettings {
  points: {
    enabled: boolean
    /** 每消费 1 元得多少分 */
    earnRatePerYuan: number
    /** 积分有效期（天） */
    validDays: number
  }
  newcomer: {
    /** 新客券模板 id，null = 不发新客券 */
    templateId: number | null
  }
  /** 规则说明页的补充文案 */
  rulesText: string
}

// ── 经营概览（spec 2026-09-08） ──
export interface StatsRangeParams { startDate: string; endDate: string }
export interface StatsRangeOut { startDate: string; endDate: string; prevStartDate: string; prevEndDate: string }
export interface ChannelAgg { orderCount: number; revenueFen: number }
export interface OverviewStats {
  range: StatsRangeOut
  kpi: { revenueFen: number; refundFen: number; orderCount: number; avgOrderFen: number; prev: { revenueFen: number; refundFen: number; orderCount: number; avgOrderFen: number } }
  channels: { LOCAL: ChannelAgg; EXPRESS: ChannelAgg; PICKUP: ChannelAgg }
  trend: { date: string; LOCAL: ChannelAgg; EXPRESS: ChannelAgg; PICKUP: ChannelAgg }[]
  hourly: number[]
  customers: { users: number; newUsers: number; returningUsers: number; repeatRate: number | null }
  hotProducts: { productId: number; name: string; qty: number; revenueFen: number }[]
}
export interface LocalStatsKpi { orderCount: number; revenueFen: number; avgDistanceM: number | null; freeShipCount: number; freeShipRate: number | null }
export interface LocalStats {
  range: StatsRangeOut
  kpi: LocalStatsKpi & { prev: LocalStatsKpi }
  freight: { customerPaidFen: number; deliveryFen: number; tipFen: number; cancelFen: number; riderTotalFen: number; netFen: number; unpricedCount: number; prev: { customerPaidFen: number; riderTotalFen: number; netFen: number } }
  timing: { stages: { key: string; label: string; medianMin: number | null; p90Min: number | null; n: number }[] }
  providers: { provider: string; count: number; avgFeeFen: number | null; avgPickupMin: number | null }[]
  ladder: { first: number; cheapestN: number; all: number }
  distance: { label: string; count: number }[]
  cancels: { requested: number; deliveryCancelled: number }
}
export interface ExpressStatsKpi { orderCount: number; revenueFen: number; shippingFeeFen: number }
export interface ExpressStats {
  range: StatsRangeOut
  kpi: ExpressStatsKpi & { prev: ExpressStatsKpi }
  backlog: { count: number; oldestHours: number | null; oldestOrderNo: string | null }
  shipTiming: { medianHours: number | null; p90Hours: number | null; n: number }
  companies: { name: string; count: number }[]
  regions: { province: string; count: number }[]
  afterSales: { refundCount: number; refundFen: number; afterSaleCount: number }
}
