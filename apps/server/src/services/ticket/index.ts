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
  getPrinterSettings, printersForChannel, PrinterSettings, PrinterChannel,
} from '../printer-settings'
import { PrinterProvider, PrinterProviderName, PrintJobKind, PrinterError } from './printer'
import { feieProvider } from './feie'
import { mockPrinterProvider } from './mock'
import {
  renderOrderTicket, renderReminderTicket, renderCancelTicket, renderTestTicket, TicketOrderInput,
} from './content'

const BATCH = 100
/** 失败重试退避：第 1/2/3 次失败后分别等待 5s/30s/2min 再重试，第 3 次仍失败转 FAILED（规格 §8b） */
const RETRY_DELAYS_MS = [5_000, 30_000, 120_000]
const MAX_ATTEMPTS = RETRY_DELAYS_MS.length
/** SENT 状态超过这个时长仍未被回调/查询确认为 PRINTED，就主动查一次平台状态（规格 §8b 兜扫） */
const SENT_CONFIRM_AFTER_MS = 3 * 60 * 1000

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
  const shouldFail = err.kind === 'CONFIG' || attempts >= MAX_ATTEMPTS
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
    const delay = RETRY_DELAYS_MS[Math.min(job.attempts, RETRY_DELAYS_MS.length - 1)]
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
    const waitedMin = (now - order.paidAt.getTime()) / 60_000
    if (waitedMin < afterMin) continue
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
