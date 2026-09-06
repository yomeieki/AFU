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
  // 呼叫策略。SOLO_LOWEST = 只呼报价最低那一家（省钱，且余额只冻结一笔）；ALL = 并呼全表（旧行为）。
  // escalateAfterMin 分钟无人接单则自动取消重呼、升级为并呼；0 = 不自动升级。
  callStrategy: { mode: 'SOLO_LOWEST' | 'ALL'; escalateAfterMin: number }
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
    estimatedDeliveryAt: string | null   // 规格 §3 要求同城卡片出现「预计送达」，来自 Order.estimatedDeliveryAt
    cancelRequested: boolean
    delivery: {
      status: string; statusLabel: string; courierName: string | null; courierMobile: string | null
      /** 最近一次呼叫骑手失败（运力方拒单/下单报错），订单还停在备餐中等店员重呼或改自送。服务端可选下发 */
      callFailed?: boolean
    } | null
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
