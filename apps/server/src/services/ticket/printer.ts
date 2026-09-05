/**
 * 云打印机 provider 接口。规格 §8b：`{ print(job), queryStatus(), queryJob(id) }`。
 *
 * 首期实现 `feie.ts`（飞鹅云打印开放平台）+ `mock.ts`（本地/e2e）；`xpyun.ts`（芯烨云）留作二期，
 * 接口形状已经预留（provider 之间互不感知业务，index.ts 只认这一个接口）。
 *
 * 硬件是带语音播报的「云喇叭」款：软件侧不做任何播报逻辑，`print()` 正常出票即可，
 * 播报由打印机固件在收到 `Open_printMsg` 时自动触发（见 docs/research/2026-09-03-cloud-printer-feie-xpyun.md §1.7）。
 */

/** PrintJob.kind：NEW_ORDER 新单 | REPEAT 未接单重打 | CANCEL 取消/退款提醒 | REPRINT 手动重打 | TEST 测试页 */
export type PrintJobKind = 'NEW_ORDER' | 'REPEAT' | 'CANCEL' | 'REPRINT' | 'TEST'

/** PrintJob.provider */
export type PrinterProviderName = 'FEIE' | 'MOCK' | 'XPYUN'

/**
 * 错误分类，供调用方（services/ticket/index.ts 的重试/告警逻辑）区分「配置错了」与「打印机离线」：
 * - CONFIG：账号/密钥/打印机未绑定等配置类问题——重试没有意义，直接 FAILED + 告警配置问题
 * - CAPACITY：打印机离线/缺纸/开盖等设备连通性问题——值得按退避重试
 * - BUSINESS：其它业务错误（参数、内容超限等）——按退避重试有限次数
 * - TIMEOUT：请求超时/网络错误，无法确认对端是否已收到——按退避重试（参考 kd100.ts 对超时的保守处理，
 *   但飞鹅没有幂等 token，重试存在双打风险，由调用方权衡重试次数）
 */
export type PrinterErrorKind = 'CONFIG' | 'CAPACITY' | 'BUSINESS' | 'TIMEOUT'

export class PrinterError extends Error {
  kind: PrinterErrorKind
  code: string
  raw?: unknown
  constructor(kind: PrinterErrorKind, code: string, message: string, raw?: unknown) {
    super(message)
    this.name = 'PrinterError'
    this.kind = kind
    this.code = code
    this.raw = raw
  }
}

export interface PrintTicketInput {
  /** 打印机编号 */
  sn: string
  /** 已渲染好的票面内容（含厂商标签），调用方须保证 ≤5000 字节，见 services/ticket/content.ts */
  content: string
  /** 打印份数，默认 1 */
  copies?: number
}

export interface PrintTicketResult {
  /** 打印平台返回的订单标识（飞鹅：Open_printMsg 的 data 字段），供 queryJob 查询打印状态用 */
  providerJobId: string
  raw?: unknown
}

export type PrinterOnlineState = 'ONLINE' | 'ABNORMAL' | 'OFFLINE' | 'UNKNOWN'

export interface PrinterStatusResult {
  sn: string
  state: PrinterOnlineState
  /** 平台原始状态描述（飞鹅是中文串，如「在线，工作状态正常。」），保留供告警文案与人工排查 */
  raw?: string
}

export interface QueryJobResult {
  printed: boolean
  raw?: unknown
}

export interface BindPrinterInput {
  sn: string
  /** 打印机随机出厂的绑定密钥，只用于本次绑定调用，不落库存明文（见 printer-settings.ts） */
  key: string
  name?: string
}

export interface PrinterProvider {
  name: PrinterProviderName
  print(job: PrintTicketInput): Promise<PrintTicketResult>
  queryStatus(sn: string): Promise<PrinterStatusResult>
  queryJob(providerJobId: string): Promise<QueryJobResult>
  /** 绑定打印机到开发者账号（飞鹅 Open_printerAddlist）；后台绑定页用，mock 直接返回成功 */
  bindPrinter(input: BindPrinterInput): Promise<void>
}
