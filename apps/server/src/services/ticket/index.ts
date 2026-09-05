/**
 * 出票编排层。规格 §8b：`enqueueOrderTicket(orderId, kind)`、`processQueue()`、`repeatAnnounce()`、
 * `healthCheck()`。
 *
 * 本批只做核心层，不接挂钩点：`orders.ts`/`wechat-notify.ts` 尚未调用 `enqueueOrderTicket`，
 * `scheduler.ts` 也尚未把 `processQueue`/`repeatAnnounce`/`healthCheck` 接进定时任务——那是下一批的事，
 * 这里先把编排逻辑写完整、可独立单测/e2e。
 *
 * 硬件是带语音播报的云喇叭款：`print()` 正常出票即触发固件自动播报，本文件不做任何播报专属调用。
 */
import prisma from '../../utils/prisma'
import { config } from '../../config'
import { notifySystemAlert } from '../notify'
import {
  getPrinterSettings, setPrinterSettings, printersForChannel,
  PrinterSettings, PrinterChannel, PrinterEntry,
} from '../printer-settings'
import {
  PrinterProvider, PrinterProviderName, PrintJobKind, PrinterError, BindPrinterInput,
} from './printer'
import { feieProvider } from './feie'
import { mockPrinterProvider } from './mock'
import {
  renderOrderTicket, renderReminderTicket, renderCancelTicket, renderTestTicket, TicketOrderInput,
} from './content'

const BATCH = 100
/**
 * 失败重试退避：第 1/2/3 次失败后分别等待 5s/30s/2min 再重试，第 3 次仍失败转 FAILED（规格 §8b）。
 * 用可变数组而非常量，是为了给 `_setRetryDelaysMsForTest` 留口子——e2e 要验证「重试耗尽→FAILED」
 * 这条路径，真等 5s+30s+2min≈2.5 分钟会把整跑拖慢一个数量级；测试口子只在 PRINTER_PROVIDER_MOCK
 * 模式下通过 admin/printer.ts 的 mock 控制路由暴露，生产环境代码路径不可达。
 */
let retryDelaysMs = [5_000, 30_000, 120_000]
const MAX_ATTEMPTS = () => retryDelaysMs.length
/** 仅测试/e2e 用：覆盖退避等待时长（保持数组长度=3，否则 MAX_ATTEMPTS 语义会跟着变） */
export function _setRetryDelaysMsForTest(delays: number[]): void {
  retryDelaysMs = delays
}
export function _resetRetryDelaysMsForTest(): void {
  retryDelaysMs = [5_000, 30_000, 120_000]
}
/** SENT 状态超过这个时长仍未被回调/查询确认为 PRINTED，就主动查一次平台状态（规格 §8b 兜扫） */
const SENT_CONFIRM_AFTER_MS = 3 * 60 * 1000
/** 打印机恢复在线后自动补打 FAILED 作业的回溯窗口：超过这个时长的旧单不再补打（规格 §8b，避免离线
 *  半天后恢复时一次吐一堆过期小票）*/
const RECOVER_BACKFILL_MS = 30 * 60 * 1000

function activeProviderName(settings: PrinterSettings): PrinterProviderName {
  if (config.mock.printer) return 'MOCK'
  return settings.provider === 'XPYUN' ? 'XPYUN' : 'FEIE'
}

function getProvider(name: PrinterProviderName): PrinterProvider {
  if (name === 'MOCK') return mockPrinterProvider
  if (name === 'FEIE') return feieProvider
  throw new PrinterError('CONFIG', 'PROVIDER_NOT_IMPLEMENTED', `打印 provider ${name} 尚未实现（二期）`)
}

function buildDedupeKey(orderId: number, kind: PrintJobKind, seq: number, idx: number): string {
  return `${orderId}|${kind}|${seq}.${idx}`.slice(0, 64)
}

type OrderForTicket = {
  id: number; orderNo: string; deliveryType: string; createdAt: Date; paidAt: Date | null
  totalAmount: number; shippingFee: number; actualAmount: number; remark: string | null
  receiverName: string; receiverPhone: string; receiverFullAddress: string
  receiverPoiName: string | null; distanceM: number | null; estimatedDeliveryAt: Date | null
  announceCount: number
  items: { productName: string; specText: string | null; quantity: number; subtotal: number }[]
}

const ORDER_SELECT = {
  id: true, orderNo: true, deliveryType: true, createdAt: true, paidAt: true,
  totalAmount: true, shippingFee: true, actualAmount: true, remark: true,
  receiverName: true, receiverPhone: true, receiverFullAddress: true,
  receiverPoiName: true, distanceM: true, estimatedDeliveryAt: true, announceCount: true,
  items: { select: { productName: true, specText: true, quantity: true, subtotal: true } },
} as const

function toTicketInput(order: OrderForTicket, seq: number | null): TicketOrderInput {
  return {
    channel: order.deliveryType === 'LOCAL' ? 'LOCAL' : 'EXPRESS',
    orderNo: order.orderNo,
    createdAt: order.createdAt,
    paidAt: order.paidAt,
    items: order.items,
    totalAmount: order.totalAmount,
    shippingFee: order.shippingFee,
    actualAmount: order.actualAmount,
    remark: order.remark,
    receiverName: order.receiverName,
    receiverPhone: order.receiverPhone,
    receiverFullAddress: order.receiverFullAddress,
    receiverPoiName: order.receiverPoiName,
    distanceM: order.distanceM,
    estimatedDeliveryAt: order.estimatedDeliveryAt,
    seq,
  }
}

function renderForKind(kind: PrintJobKind, order: OrderForTicket, settings: PrinterSettings, seq: number | null, waitedMin?: number): string {
  const channel: PrinterChannel = order.deliveryType === 'LOCAL' ? 'LOCAL' : 'EXPRESS'
  if (kind === 'CANCEL') {
    return renderCancelTicket({ orderNo: order.orderNo, channel, reason: '订单取消/退款', at: new Date() })
  }
  if (kind === 'REPEAT' && !settings.repeat.reprint) {
    return renderReminderTicket({ orderNo: order.orderNo, channel, waitedMin: waitedMin ?? 0 })
  }
  // NEW_ORDER / REPRINT / repeat.reprint=true 时的 REPEAT，都是整张全票
  return renderOrderTicket(toTicketInput(order, seq))
}

export interface EnqueueResult {
  enqueued: boolean
  reason?: string
  jobIds?: number[]
}

/**
 * 落库一个订单的出票任务并立即尝试发送（PENDING 落库后立即发，不等下一轮 processQueue，
 * 规格 §8b「落库后立即尝试发送」）。幂等：同一 (orderId, kind, seq) 组合重复调用只会命中
 * `dedupeKey` 唯一索引被跳过，不会重复出票——付款回调重复触发时安全。
 *
 * @param seq 用于 dedupeKey 去重的序号：NEW_ORDER/CANCEL 默认 0（同一单同一种票只出一次）；
 *   REPEAT 应由调用方传当次播报序号（如 announceCount）；REPRINT/TEST 每次都应不同，默认取时间戳。
 */
export async function enqueueOrderTicket(
  orderId: number,
  kind: PrintJobKind,
  opts: { seq?: number; waitedMin?: number } = {}
): Promise<EnqueueResult> {
  const settings = await getPrinterSettings()
  if (!settings.enabled) return { enqueued: false, reason: 'PRINTER_DISABLED' }
  if (kind === 'CANCEL' && !settings.printCancel) return { enqueued: false, reason: 'CANCEL_TICKET_DISABLED' }

  const order = await prisma.order.findUnique({ where: { id: orderId }, select: ORDER_SELECT })
  if (!order) return { enqueued: false, reason: 'ORDER_NOT_FOUND' }

  const channel: PrinterChannel = order.deliveryType === 'LOCAL' ? 'LOCAL' : 'EXPRESS'
  const printers = printersForChannel(settings, channel)
  const providerName = activeProviderName(settings)
  const baseSeq = opts.seq ?? (kind === 'NEW_ORDER' || kind === 'CANCEL' ? 0 : Date.now())

  const jobIds: number[] = []

  if (printers.length === 0) {
    // 打印机未配置该渠道：仍落一条 SKIPPED 记录留痕，而不是静默什么都不做——
    // 店主在「打印记录」里能看到「这单本该出票但没配打印机」，而不是以为系统没触发。
    const dedupeKey = buildDedupeKey(orderId, kind, baseSeq, 0)
    try {
      const row = await prisma.printJob.create({
        data: {
          orderId: order.id, orderNo: order.orderNo, kind, provider: providerName, printerSn: '',
          status: 'SKIPPED', content: renderForKind(kind, order, settings, orderSeqOrNull(baseSeq, kind), opts.waitedMin),
          lastError: '未配置该渠道的打印机', dedupeKey,
        },
      })
      jobIds.push(row.id)
    } catch (e) {
      if (!isDuplicateKeyError(e)) throw e
    }
    return { enqueued: jobIds.length > 0, reason: 'NO_PRINTER_CONFIGURED', jobIds }
  }

  for (let i = 0; i < printers.length; i++) {
    const printer = printers[i]
    const content = renderForKind(kind, order, settings, orderSeqOrNull(baseSeq, kind), opts.waitedMin)
    const dedupeKey = buildDedupeKey(orderId, kind, baseSeq, i)
    let row
    try {
      row = await prisma.printJob.create({
        data: {
          orderId: order.id, orderNo: order.orderNo, kind, provider: providerName,
          printerSn: printer.sn, status: 'PENDING', content, dedupeKey,
        },
      })
    } catch (e) {
      if (isDuplicateKeyError(e)) continue // 幂等命中：已经出过这张票，跳过
      throw e
    }
    jobIds.push(row.id)
    // 立即尝试发送一次，不等下一轮 processQueue（付款成功到出票之间的延迟越小越好）
    await attemptSend(row.id, providerName, printer.sn, content, printer.copies)
  }
  return { enqueued: jobIds.length > 0, jobIds }
}

/** REPEAT 的 seq 语义是「第几次播报」，落进票面用于给顾客/店员看，NEW_ORDER/CANCEL/REPRINT/TEST 不需要 */
function orderSeqOrNull(seq: number, kind: PrintJobKind): number | null {
  return kind === 'REPEAT' ? seq : null
}

function isDuplicateKeyError(e: unknown): boolean {
  return typeof e === 'object' && e !== null && 'code' in e && (e as { code?: unknown }).code === 'P2002'
}

/** 单次发送尝试：更新 PrintJob 状态、必要时告警。被 enqueueOrderTicket（首次）与 processQueue（重试/兜扫）共用 */
async function attemptSend(
  jobId: number, providerName: PrinterProviderName, sn: string, content: string, copies: number
): Promise<void> {
  const provider = getProvider(providerName)
  try {
    const result = await provider.print({ sn, content, copies })
    await prisma.printJob.updateMany({
      where: { id: jobId, status: 'PENDING' },
      data: { status: 'SENT', providerJobId: result.providerJobId, sentAt: new Date(), lastError: null },
    })
  } catch (e) {
    const err = e instanceof PrinterError ? e : new PrinterError('BUSINESS', 'UNKNOWN', (e as Error).message)
    await handleSendFailure(jobId, err)
  }
}

async function handleSendFailure(jobId: number, err: PrinterError): Promise<void> {
  const job = await prisma.printJob.findUnique({ where: { id: jobId }, select: { attempts: true, orderNo: true, status: true } })
  if (!job || job.status !== 'PENDING') return
  const lastError = `${err.kind}:${err.code} ${err.message}`.slice(0, 255)
  // CONFIG 类错误（账号/密钥/打印机未绑定）重试没有意义，直接 FAILED，不占重试次数
  const attempts = job.attempts + 1
  const shouldFail = err.kind === 'CONFIG' || attempts >= MAX_ATTEMPTS()
  await prisma.printJob.updateMany({
    where: { id: jobId, status: 'PENDING' },
    data: { attempts, lastError, status: shouldFail ? 'FAILED' : 'PENDING' },
  })
  if (shouldFail) {
    notifySystemAlert('打印失败', [`订单 ${job.orderNo}`, lastError, '打印机故障期间请留意工作台/推送，人工确认是否已接单'], {
      key: `print:failed:${jobId}`,
    })
  }
}

/**
 * 定时兜扫（尚未接进 scheduler.ts，本批只实现函数本体）：
 * 1. PENDING 且到了退避重试时间点的任务，重新尝试发送
 * 2. SENT 超过 3 分钟未确认的任务，主动查一次平台打印状态
 * 都有 100 条上限（参考 services/scheduler.ts 的做法，避免一轮扫描处理量失控）。
 */
export async function processQueue(): Promise<{ retried: number; confirmed: number }> {
  let retried = 0
  let confirmed = 0

  const now = Date.now()
  const pending = await prisma.printJob.findMany({
    where: { status: 'PENDING' },
    orderBy: { createdAt: 'asc' },
    take: BATCH,
  })
  for (const job of pending) {
    const delay = retryDelaysMs[Math.min(job.attempts, retryDelaysMs.length - 1)]
    if (job.attempts > 0 && now - job.updatedAt.getTime() < delay) continue
    await attemptSend(job.id, job.provider as PrinterProviderName, job.printerSn, job.content, 1)
    retried++
  }

  const sentDeadline = new Date(now - SENT_CONFIRM_AFTER_MS)
  const sent = await prisma.printJob.findMany({
    where: { status: 'SENT', sentAt: { lt: sentDeadline } },
    orderBy: { sentAt: 'asc' },
    take: BATCH,
  })
  for (const job of sent) {
    if (!job.providerJobId) continue
    try {
      const provider = getProvider(job.provider as PrinterProviderName)
      const result = await provider.queryJob(job.providerJobId)
      if (result.printed) {
        const moved = await prisma.printJob.updateMany({
          where: { id: job.id, status: 'SENT' },
          data: { status: 'PRINTED', printedAt: new Date() },
        })
        confirmed += moved.count
      }
      // 还没打印完成：保持 SENT，下一轮再查（飞鹅无回调可依赖时，这是唯一的确认路径）
    } catch (e) {
      console.warn(`[ticket] 查询打印状态失败 job=${job.id}:`, (e as Error).message)
    }
  }
  return { retried, confirmed }
}

/**
 * 仅测试/e2e 用：覆盖「等待多久算未接单」的判断阈值（毫秒），跳过 `repeat.localAfterMin/expressAfterMin`
 * 的真实等待——这两个字段的合法下限是 1 分钟（printer-settings.ts 的 sanitize 规则），不能靠调设置
 * 秒级触发；传 null 恢复用设置里的真实分钟数。
 */
let testMinWaitMsOverride: number | null = null
export function _setRepeatAnnounceMinWaitMsForTest(ms: number | null): void {
  testMinWaitMsOverride = ms
}

/**
 * 未接单重复播报（D7）：`PAID` 且等待已超过设置的阈值、距上次播报够久、次数未耗尽 → 入队 REPEAT 作业。
 * 语音款硬件没有独立播报接口，重复播报 = 重新发一次打印任务（`repeat.reprint` 决定是打全票还是精简
 * 催单票）。接单（状态离开 PAID）后自然停止——下一轮查询条件里就不会再选中它。
 *
 * 尚未接进 scheduler.ts，本批只实现函数本体、可独立调用/测试。
 */
export async function repeatAnnounce(): Promise<{ announced: number; exhausted: number }> {
  const settings = await getPrinterSettings()
  if (!settings.enabled) return { announced: 0, exhausted: 0 }
  const now = Date.now()

  const candidates = await prisma.order.findMany({
    where: { status: 'PAID', paidAt: { not: null } },
    select: { id: true, deliveryType: true, paidAt: true, announceCount: true, lastAnnouncedAt: true },
    orderBy: { paidAt: 'asc' },
    take: BATCH,
  })

  let announced = 0
  let exhausted = 0
  for (const order of candidates) {
    if (!order.paidAt) continue
    const afterMin = order.deliveryType === 'LOCAL' ? settings.repeat.localAfterMin : settings.repeat.expressAfterMin
    const waitedMs = now - order.paidAt.getTime()
    const waitedMin = waitedMs / 60_000
    if (waitedMs < (testMinWaitMsOverride ?? afterMin * 60_000)) continue
    if (order.announceCount >= settings.repeat.maxTimes) {
      if (!order.lastAnnouncedAt || now - order.lastAnnouncedAt.getTime() >= settings.repeat.everyMin * 60_000) {
        // 次数耗尽仍未接单：只告警一次（用 lastAnnouncedAt 顶替"已告警"标记，避免每轮都重复告警）
        const moved = await prisma.order.updateMany({
          where: { id: order.id, status: 'PAID', announceCount: order.announceCount },
          data: { lastAnnouncedAt: new Date() },
        })
        if (moved.count > 0) {
          exhausted++
          notifySystemAlert('重复播报耗尽仍未接单', [`订单 #${order.id}`, `已播报 ${order.announceCount} 次`], {
            key: `print:announce-exhausted:${order.id}`,
          })
        }
      }
      continue
    }
    if (order.lastAnnouncedAt && now - order.lastAnnouncedAt.getTime() < settings.repeat.everyMin * 60_000) continue

    // 原子递增 announceCount，guard 住并发定时任务/手动触发同时命中同一单
    const nextCount = order.announceCount + 1
    const moved = await prisma.order.updateMany({
      where: { id: order.id, status: 'PAID', announceCount: order.announceCount },
      data: { announceCount: nextCount, lastAnnouncedAt: new Date() },
    })
    if (moved.count === 0) continue // 被并发的另一轮抢先，跳过
    const result = await enqueueOrderTicket(order.id, 'REPEAT', { seq: nextCount, waitedMin: Math.round(waitedMin) })
    if (result.enqueued) announced++
  }
  return { announced, exhausted }
}

export interface PrinterHealthEntry {
  sn: string
  name: string
  state: 'ONLINE' | 'ABNORMAL' | 'OFFLINE' | 'UNKNOWN' | 'ERROR'
  raw?: string
}

/**
 * 查询全部已配置打印机的在线状态。离线/异常超过 `offlineAlertMin` 分钟才告警——
 * 这里只做一次查询快照，"连续离线 N 分钟"的判断需要调用方（未来的 scheduler 任务）
 * 按固定间隔调用本函数并自行跟踪"从何时起持续异常"，本函数本身不维护跨调用状态
 * （核心层不假设自己被多频繁调用，状态判断交给挂钩点）。
 */
export async function healthCheck(): Promise<PrinterHealthEntry[]> {
  const settings = await getPrinterSettings()
  if (!settings.enabled || settings.printers.length === 0) return []
  const providerName = activeProviderName(settings)
  const provider = getProvider(providerName)
  const results: PrinterHealthEntry[] = []
  for (const p of settings.printers) {
    try {
      const status = await provider.queryStatus(p.sn)
      results.push({ sn: p.sn, name: p.name, state: status.state, raw: status.raw })
    } catch (e) {
      results.push({ sn: p.sn, name: p.name, state: 'ERROR', raw: (e as Error).message })
    }
  }
  return results
}

/** 后台「打印测试页」：不挂在任何真实订单上，orderId 记 0、orderNo 记 'TEST'，dedupeKey 用时间戳保证每次都是新记录 */
export async function enqueuePrinterTestJob(sn: string): Promise<EnqueueResult> {
  const settings = await getPrinterSettings()
  const providerName = activeProviderName(settings)
  const printer = settings.printers.find((p) => p.sn === sn)
  const content = renderTestTicket(printer?.name)
  const dedupeKey = `0|TEST|${Date.now()}|${sn}`.slice(0, 64)
  const row = await prisma.printJob.create({
    data: { orderId: 0, orderNo: 'TEST', kind: 'TEST', provider: providerName, printerSn: sn, status: 'PENDING', content, dedupeKey },
  })
  await attemptSend(row.id, providerName, sn, content, 1)
  return { enqueued: true, jobIds: [row.id] }
}

// ── 打印机健康：告警/恢复补打（本批新增，接入 scheduler 的 printerHealth 任务）───────────
//
// healthCheck() 本身有意不维护跨调用状态（见其注释）；「连续离线 N 分钟才告警、恢复后再告知一次」
// 这条判断只能由调用方跟踪。这里选择放在 ticket/index.ts 而不是 scheduler.ts：一是需要与
// enqueueOrderTicket/attemptSend 共享的「补打」逻辑放在一起更自然，二是 scheduler.ts 里其余任务
// 的状态都落在 Order/Delivery 的具名列上（如 callTimeoutRemindedAt），打印机健康没有对应的实体列
// 可挂（PrinterEntry 是 Setting JSON 里的一项，不是数据库行），只能用进程内 Map；这与
// scheduler.ts 自己的 `lastLowStockPushAt`（同样是进程内状态、同样不持久化、进程重启即重新计时）
// 是同一类做法，不是新引入的模式。**代价**：多实例部署或进程重启会丢失"已持续离线多久"的计时，
// 相当于该次重启后重新起算——PM2 单实例 fork 前提下可接受（与 lastLowStockPushAt 的既有取舍一致）。
interface PrinterHealthTrack { offlineSince: number | null; alerted: boolean }
const healthTrack = new Map<string, PrinterHealthTrack>()
let lastHealthSnapshot: { at: number; entries: PrinterHealthEntry[] } | null = null
/** workbench 快照复用这份缓存的最长时效：略大于 scheduler 的 60s 心跳，容忍一次心跳延迟/失败 */
const HEALTH_SNAPSHOT_MAX_AGE_MS = 90 * 1000

/** 仅测试/e2e 用：清空健康跟踪状态，避免上一个用例的「已告警」标记影响下一个用例 */
export function _resetPrinterHealthTrack(): void {
  healthTrack.clear()
  lastHealthSnapshot = null
}

/**
 * 仅测试/e2e 用：直接写入某台打印机的健康跟踪状态（跳过真实等待 `offlineAlertMin` 分钟）。
 * `offlineAlertMin` 的合法下限是 1（见 printer-settings.ts 的 sanitize 规则），没法靠把阈值设成 0
 * 来秒级触发告警；这里改用「直接把 offlineSince 设成足够早的过去时间点」来达到同样的测试目的，
 * 不去动生产配置本身的校验下限。
 */
export function _setPrinterHealthTrackForTest(sn: string, track: { offlineSince: number | null; alerted: boolean }): void {
  healthTrack.set(sn, track)
}

/**
 * 恢复在线后自动补打：只找该 sn 名下最近 30 分钟内、状态仍是 FAILED 且失败原因不是 CONFIG 类
 * （账号/密钥/未绑定等配置问题不会因为「设备连通性恢复」而自愈，重打只会立刻再失败一次，白白
 * 占用打印机队列——这是规格没写死、本批自行做出的判断，详见最终报告）的作业，重置为 PENDING 后
 * 立即重新尝试发送一次。超过窗口的旧单按规格明确要求不再补打。
 */
export async function retryRecoveredPrinterJobs(sn: string): Promise<number> {
  const cutoff = new Date(Date.now() - RECOVER_BACKFILL_MS)
  const jobs = await prisma.printJob.findMany({
    where: { printerSn: sn, status: 'FAILED', createdAt: { gt: cutoff }, NOT: { lastError: { startsWith: 'CONFIG:' } } },
    orderBy: { createdAt: 'asc' },
    take: BATCH,
  })
  let count = 0
  for (const job of jobs) {
    const moved = await prisma.printJob.updateMany({
      where: { id: job.id, status: 'FAILED' },
      data: { status: 'PENDING', attempts: 0, lastError: null },
    })
    if (moved.count === 0) continue
    try {
      // attemptSend 内部对「打印失败」这类错误自己兜底，但 getProvider() 那一行本身在 try 之外
      // （只在收到未实现的 provider 名字时才会抛，正常路径不会走到）；这里补一层，让恢复补打这个
      // 批处理循环里，单条历史脏数据（比如 provider 字段被更早版本写成了不认识的值）不会把整个
      // printerHealthTask 拖垮——那样会导致 scheduler 的这一轮 stats 里连 printerHealth 这个键
      // 都不出现，调用方（工作台/e2e）拿到的是 undefined 而不是一个数字，对照 processQueue() 里
      // SENT 确认循环同样的 try/catch 写法。
      await attemptSend(job.id, job.provider as PrinterProviderName, job.printerSn, job.content, 1)
      count++
    } catch (e) {
      console.warn(`[ticket] 恢复补打失败 job=${job.id}:`, (e as Error).message)
    }
  }
  return count
}

export interface PrinterHealthTaskResult { checked: number; alerted: number; recovered: number; backfilled: number }

/**
 * scheduler 的 `printerHealth` 任务本体：查一次全部已配置打印机的状态，用进程内 Map 跟踪「从何时起
 * 持续离线/异常」，跨过 `offlineAlertMin` 分钟才告警一次；从异常恢复到 ONLINE 时告知一次并触发补打。
 * 顺带把这次查询结果写进 `lastHealthSnapshot`，供 workbench 快照直接读缓存、不必每次轮询都外呼。
 */
export async function printerHealthTask(): Promise<PrinterHealthTaskResult> {
  const settings = await getPrinterSettings()
  if (!settings.enabled || settings.printers.length === 0) {
    lastHealthSnapshot = { at: Date.now(), entries: [] }
    return { checked: 0, alerted: 0, recovered: 0, backfilled: 0 }
  }
  const entries = await healthCheck()
  lastHealthSnapshot = { at: Date.now(), entries }
  const now = Date.now()
  const knownSns = new Set(entries.map((e) => e.sn))
  for (const sn of healthTrack.keys()) if (!knownSns.has(sn)) healthTrack.delete(sn)

  let alerted = 0
  let recovered = 0
  let backfilled = 0
  for (const e of entries) {
    const bad = e.state === 'OFFLINE' || e.state === 'ABNORMAL' || e.state === 'ERROR'
    const track = healthTrack.get(e.sn) ?? { offlineSince: null, alerted: false }
    if (bad) {
      if (track.offlineSince === null) track.offlineSince = now
      const downMin = (now - track.offlineSince) / 60_000
      if (!track.alerted && downMin >= settings.offlineAlertMin) {
        track.alerted = true
        alerted++
        notifySystemAlert('打印机离线或异常', [`打印机 ${e.name}（${e.sn}）`, `已持续 ${Math.round(downMin)} 分钟`, e.raw ?? e.state], {
          key: `printer:offline:${e.sn}`,
        })
      }
    } else {
      if (track.alerted) {
        recovered++
        notifySystemAlert('打印机已恢复', [`打印机 ${e.name}（${e.sn}）`], { key: `printer:recovered:${e.sn}` })
        backfilled += await retryRecoveredPrinterJobs(e.sn)
      }
      track.offlineSince = null
      track.alerted = false
    }
    healthTrack.set(e.sn, track)
  }
  return { checked: entries.length, alerted, recovered, backfilled }
}

/**
 * 供 workbench 快照读取的打印机状态：优先用 `printerHealthTask`（scheduler 每 60s 跑一次）留下的
 * 缓存，避免工作台每次轮询（前台 10s 一次）都外呼一次飞鹅查状态接口；缓存过期或从未跑过时
 * （进程刚启动、scheduler 被禁用）退化为现查一次，不让状态灯长期停在「未知」。
 */
export async function getWorkbenchPrinterHealth(): Promise<PrinterHealthEntry[]> {
  if (lastHealthSnapshot && Date.now() - lastHealthSnapshot.at < HEALTH_SNAPSHOT_MAX_AGE_MS) {
    return lastHealthSnapshot.entries
  }
  const entries = await healthCheck()
  lastHealthSnapshot = { at: Date.now(), entries }
  return entries
}

// ── 后台绑定/解绑/重试（admin/printer.ts 用）──────────────────────────────
/**
 * 绑定打印机：调用 provider.bindPrinter（飞鹅 Open_printerAddlist）成功后才写入 PrinterSettings.printers；
 * KEY 只用于这一次绑定调用，不落库明文（规格 §8b）。已存在同 sn 时视为「更新备注/重新绑定」，覆盖旧行
 * 而不是报重复——店员改打印机备注名或补喂一次 KEY 都会走这条路径，没必要单独开一个 PATCH。
 */
export async function bindPrinterToAccount(input: BindPrinterInput): Promise<PrinterSettings> {
  const settings = await getPrinterSettings()
  const providerName = activeProviderName(settings)
  const provider = getProvider(providerName)
  await provider.bindPrinter(input)
  const next: PrinterEntry = {
    sn: input.sn,
    name: input.name?.trim() || input.sn,
    channels: ['LOCAL', 'EXPRESS'],
    copies: 1,
  }
  const printers = [...settings.printers.filter((p) => p.sn !== input.sn), next]
  return setPrinterSettings({ ...settings, printers })
}

/** 解绑：只从本地设置移除，不调用飞鹅侧删除接口（Open_printerDelList）——多台门店共用同一飞鹅账号时，
 *  贸然调用远端删除会影响到其他还在用这台机器的场景；本地移除已经能达到「不再往这台机器出票」的效果。 */
export async function unbindPrinter(sn: string): Promise<PrinterSettings> {
  const settings = await getPrinterSettings()
  return setPrinterSettings({ ...settings, printers: settings.printers.filter((p) => p.sn !== sn) })
}

export type RetryPrintJobResult =
  | { ok: true; status: string }
  | { ok: false; reason: 'NOT_FOUND' | 'NOT_RETRYABLE' | 'CONCURRENT' }

/** 后台「失败重试」按钮：只允许对 FAILED 状态的作业操作，条件写防并发（对照 refund.ts 的惯例） */
export async function retryPrintJob(jobId: number): Promise<RetryPrintJobResult> {
  const job = await prisma.printJob.findUnique({ where: { id: jobId } })
  if (!job) return { ok: false, reason: 'NOT_FOUND' }
  if (job.status !== 'FAILED') return { ok: false, reason: 'NOT_RETRYABLE' }
  const moved = await prisma.printJob.updateMany({
    where: { id: jobId, status: 'FAILED' },
    data: { status: 'PENDING', attempts: 0, lastError: null },
  })
  if (moved.count === 0) return { ok: false, reason: 'CONCURRENT' }
  await attemptSend(jobId, job.provider as PrinterProviderName, job.printerSn, job.content, 1)
  const updated = await prisma.printJob.findUnique({ where: { id: jobId }, select: { status: true } })
  return { ok: true, status: updated?.status ?? 'PENDING' }
}
