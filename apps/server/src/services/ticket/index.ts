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
import crypto from 'crypto'
import prisma from '../../utils/prisma'
import { config } from '../../config'
import { notifySystemAlert } from '../notify'
import { notifyPrintFailed } from '../order-notify'
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
  renderOrderTicket, renderReminderTicket, renderCancelTicket, renderCancelRequestTicket, renderResumeTicket,
  renderTestTicket, TicketOrderInput,
} from './content'

const BATCH = 100
/**
 * 失败重试退避：首发失败后第 1/2/3 次重试分别等待 5s/30s/2min，第 3 次重试（总共 4 次发送）
 * 仍失败转 FAILED（规格 §8b「失败按 5s/30s/2min 重试 3 次后 FAILED」= 首发 + 3 次重试）。
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
/** SENT 确认循环单轮上限：比 BATCH（100）小很多——每条都是一次带 10s 超时的外呼，100 条串行
 *  最坏能拖到 1000s，而 scheduler 的 `running` 标志整轮持有，期间同城呼叫骑手/待付款超时取消/
 *  退款兜底全部停摆（M4）。20 条封顶把最坏情况压到 200s 量级。 */
const SENT_CONFIRM_BATCH = 20
/** SENT 超过这个时长还查不到「已打印」，放弃继续主动查询（M4）：飞鹅对久远 providerJobId 会
 *  返回「订单不存在」（ret=1001），这类行会永远停在 SENT、越攒越多，把后续新 SENT 行挤出批次；
 *  24h 后不再查，只把 lastError 标成 CONFIRM:GAVE_UP（状态仍留 SENT——我们并不知道它到底有没有
 *  打印成功，只是放弃继续主动确认，不能武断改判 FAILED/PRINTED 造成误告警或误判）。 */
const SENT_GIVE_UP_AFTER_MS = 24 * 60 * 60 * 1000
/** SENDING 超过这个时长还没转出（成功→SENT、失败→PENDING/FAILED），判定是进程在发送途中被杀死留下的
 *  孤儿行，退回 PENDING 重新进入正常重试路径（B6 孤儿回收）。
 *
 * R4（复核第二轮）：原值 15s（「比 feie.ts 的 fetch 超时 10s 多留 5s 缓冲」）在 M11 落地后不再成立——
 * M11 给 handleSendFailure 的 TIMEOUT 分支加了一次 queryStatus（同样 10s 超时），发生在
 * print() 超时**之后**、这一行**仍是 SENDING** 的时候，两次外呼都挂住时单次 SENDING 生命周期
 * 最坏能到 ~20s。旧的 15s 窗口会在 [15s,20s] 这个区间把仍在正常处理中的行错误地判成孤儿、
 * 提前放回 PENDING——而 attempts 此时还是 0（handleSendFailure 还没来得及写回），同一轮 PENDING
 * 扫描会立刻把它当"全新行"重新发一次；20s 时姗姗来迟的 handleSendFailure 再执行它的
 * `updateMany({where:{status:'SENDING'}})` 时这一行早已不是 SENDING（已被孤儿回收 + 新一轮
 * attemptSend 认领走），条件命不中、静默什么都不写——attempts 不涨、不判 FAILED、不告警，
 * 且下一轮孤儿回收窗口一到又是同一个故事，永不收敛。M11 存在的理由正是"飞鹅无幂等 token，
 * 超时重试会真的多打一张纸"，这个洞恰好把它的封顶作废。
 * 改到 ≥ 2×TIMEOUT_MS + 缓冲（60s）：两次 10s 外呼都超时的最坏情况（~20s）离孤儿判定还有
 * 3 倍富余，不会跟仍在正常处理（哪怕两次都挂满）的行打架；配合下面 handleSendFailure 里
 * `updateMany` 命中 0 行时的告警，即使这个假设未来又被打破，也不会再静默循环。 */
const SENDING_ORPHAN_AFTER_MS = 60 * 1000
/** 仅测试/e2e 用：覆盖 SENDING 孤儿回收窗口（毫秒），验证 R4 的时序关系不用真等 60s。
 *  生产路径不可达（同 `_setRetryDelaysMsForTest` 的口子风格）。 */
let sendingOrphanAfterMsOverride: number | null = null
export function _setSendingOrphanAfterMsForTest(ms: number | null): void {
  sendingOrphanAfterMsOverride = ms
}
/** 同一台打印机连续两次发送之间的最短间隔（规格 §8b「同 SN 串行发送、间隔 ≥300ms」）。
 *  只对 FEIE 生效——mock 模式下拖慢没有意义，只会拖慢 e2e。 */
const SEND_INTERVAL_MS = 300
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

/** dedupeKey 第四段的指纹：sha1(sn) 前 10 位。`dedupeKey` 是 `@db.VarChar(64)`，直接拼 SN 原文
 *  最长可能到 `10位orderId + 1 + 14位kind(CANCEL_REQUEST) + 1 + 13位seq + 1 + 32位sn` ≈ 72 字符，
 *  超限会被 `.slice(0,64)` 静默截断成假冲突（M8）；哈希前 10 位足够避免碰撞，且总长稳定可控。 */
function snFingerprint(sn: string): string {
  return crypto.createHash('sha1').update(sn, 'utf8').digest('hex').slice(0, 10)
}

/**
 * M8：第四段原来用 printers 数组下标（idx），店员增删打印机后数组下标会漂移到别的 SN——
 * 同一 (orderId,kind,seq) 组合下，旧行的 dedupeKey 可能因为下标巧合撞上新行该用的 key，
 * 让新行被误判为「已出过」而静默跳过。改用 SN 的指纹，与打印机在数组里的位置无关。
 */
function buildDedupeKey(orderId: number, kind: PrintJobKind, seq: number, sn: string): string {
  return `${orderId}|${kind}|${seq}|${snFingerprint(sn)}`.slice(0, 64)
}

/** SKIPPED 留痕行（未配置打印机 / 配置读取失败等，没有真实 SN 可用）专用的 key 格式——
 *  `skip:` 前缀保证它不会跟任何真实作业的 key（第四段永远是十六进制指纹）撞在一起，
 *  也不会占用真实作业的槽位（M8：修好 M9 之后新增的这条路径同样要避免这个坑）。 */
function buildSkipDedupeKey(orderId: number, kind: PrintJobKind, seq: number, reason: string): string {
  return `${orderId}|${kind}|${seq}|skip:${reason}`.slice(0, 64)
}

type OrderForTicket = {
  id: number; orderNo: string; deliveryType: string; createdAt: Date; paidAt: Date | null
  totalAmount: number; shippingFee: number; actualAmount: number; remark: string | null
  receiverName: string; receiverPhone: string; receiverFullAddress: string
  receiverDistrict: string; receiverDetail: string
  receiverPoiName: string | null; distanceM: number | null; estimatedDeliveryAt: Date | null
  announceCount: number
  items: { productName: string; specText: string | null; quantity: number; subtotal: number }[]
}

const ORDER_SELECT = {
  id: true, orderNo: true, deliveryType: true, createdAt: true, paidAt: true,
  totalAmount: true, shippingFee: true, actualAmount: true, remark: true,
  receiverName: true, receiverPhone: true, receiverFullAddress: true,
  receiverDistrict: true, receiverDetail: true,
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
    receiverDistrict: order.receiverDistrict,
    receiverDetail: order.receiverDetail,
    receiverPoiName: order.receiverPoiName,
    distanceM: order.distanceM,
    estimatedDeliveryAt: order.estimatedDeliveryAt,
    seq,
  }
}

/**
 * M12：当日流水号——按 Asia/Shanghai 自然日、数到本单 paidAt 为止的「正常单」数量。
 * 「正常单」排除测试单（isTest）与从未真正成交的单（待付款/已取消）——店员数的是「今天来了
 * 几个真实顾客」，跟系统内部生成过多少条订单记录是两回事。用固定 UTC+8（中国不实行夏令时）
 * 换算自然日边界，不依赖服务器进程本身的时区设置。
 */
function shanghaiDayStart(d: Date): Date {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d)
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '1970-01-01'
  return new Date(`${get('year')}-${get('month')}-${get('day')}T00:00:00+08:00`)
}
async function dailyOrderSeq(paidAt: Date | null): Promise<number | null> {
  if (!paidAt) return null
  return prisma.order.count({
    where: {
      isTest: false,
      status: { notIn: ['PENDING_PAYMENT', 'CANCELLED'] },
      paidAt: { gte: shanghaiDayStart(paidAt), lte: paidAt },
    },
  })
}

/**
 * @param dailySeq 当日流水号（「今日第 N 单」），只在渲染整张全票时有意义，由调用方按需算好传入
 * @param announceNo REPEAT 专属的「第几次催单」，跟 dailySeq 是两件事（M12：旧实现把这个当成
 *   了当日流水号打在票面上，店员会读错）
 */
function renderForKind(
  kind: PrintJobKind, order: OrderForTicket, settings: PrinterSettings,
  dailySeq: number | null, announceNo: number, waitedMin?: number
): string {
  const channel: PrinterChannel = order.deliveryType === 'LOCAL' ? 'LOCAL' : 'EXPRESS'
  if (kind === 'CANCEL') {
    return renderCancelTicket({ orderNo: order.orderNo, channel, reason: '订单取消/退款', at: new Date() })
  }
  if (kind === 'CANCEL_REQUEST') {
    return renderCancelRequestTicket({ orderNo: order.orderNo, channel, at: new Date() })
  }
  if (kind === 'RESUME') {
    return renderResumeTicket({ orderNo: order.orderNo, channel, at: new Date() })
  }
  if (kind === 'REPEAT' && !settings.repeat.reprint) {
    return renderReminderTicket({ orderNo: order.orderNo, channel, waitedMin: waitedMin ?? 0, announceNo })
  }
  // NEW_ORDER / REPRINT / repeat.reprint=true 时的 REPEAT，都是整张全票
  const input = toTicketInput(order, dailySeq)
  if (kind === 'REPEAT') input.announceNo = announceNo
  return renderOrderTicket(input)
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
  let settings: PrinterSettings
  try {
    settings = await getPrinterSettings()
  } catch (e) {
    // M9：配置读不出来 ≠ 未配置。「未配置」时不出票是安全默认；读失败如果也静默退化成同一条路径，
    // 出票层会以为一切正常只是没开，既不建行也不告警——这条路径比「未配置」更危险却什么都不留。
    // 这里落一条 SKIPPED 痕迹（尽量带上真实 orderNo）+ 告警，让店主知道这单本该出票但没能判断。
    let orderNo = String(orderId)
    try {
      const o = await prisma.order.findUnique({ where: { id: orderId }, select: { orderNo: true } })
      if (o) orderNo = o.orderNo
    } catch { /* 连订单都查不到，说明 DB 本身有问题，退化用 orderId 占位 */ }
    const lastError = `CONFIG:SETTINGS_UNREADABLE ${(e as Error).message}`.slice(0, 255)
    const dedupeKey = buildSkipDedupeKey(orderId, kind, opts.seq ?? 0, 'SETTINGS_UNREADABLE')
    try {
      await prisma.printJob.create({
        data: { orderId, orderNo, kind, provider: 'FEIE', printerSn: '', status: 'SKIPPED', content: '', lastError, dedupeKey },
      })
    } catch (e2) {
      if (!isDuplicateKeyError(e2)) console.error('[ticket] 配置读取失败且留痕行写入也失败:', (e2 as Error).message)
    }
    notifySystemAlert('打印机配置读取失败，本次出票已跳过', [`订单 #${orderId}（${orderNo}）`, lastError], {
      key: 'settings:printer-fallback',
    })
    return { enqueued: false, reason: 'SETTINGS_UNREADABLE' }
  }
  if (!settings.enabled) return { enqueued: false, reason: 'PRINTER_DISABLED' }
  // H6：CANCEL_REQUEST（申请取消）、RESUME（驳回后继续制作）与 CANCEL（真正取消）都是「取消类」票，
  // 同受 printCancel 开关管——开关本意是「取消/退款相关的提醒要不要打」，不是只认字面的 CANCEL。
  const isCancelKind = kind === 'CANCEL' || kind === 'CANCEL_REQUEST' || kind === 'RESUME'
  if (isCancelKind && !settings.printCancel) return { enqueued: false, reason: 'CANCEL_TICKET_DISABLED' }

  const order = await prisma.order.findUnique({ where: { id: orderId }, select: ORDER_SELECT })
  if (!order) return { enqueued: false, reason: 'ORDER_NOT_FOUND' }

  const channel: PrinterChannel = order.deliveryType === 'LOCAL' ? 'LOCAL' : 'EXPRESS'
  const printers = printersForChannel(settings, channel)
  const providerName = activeProviderName(settings)
  const baseSeq = opts.seq ?? (kind === 'NEW_ORDER' || kind === 'CANCEL' ? 0 : Date.now())
  // M12：只在真的会渲染整张全票时才查当日流水号——CANCEL/CANCEL_REQUEST/RESUME/TEST 用不上，
  // REPEAT 在 repeat.reprint=false（精简催单票）时也用不上，没必要都搭上一次 DB 查询。
  const needsDailySeq = kind === 'NEW_ORDER' || kind === 'REPRINT' || (kind === 'REPEAT' && settings.repeat.reprint)
  const dailySeq = needsDailySeq ? await dailyOrderSeq(order.paidAt) : null

  const jobIds: number[] = []

  if (printers.length === 0) {
    // 打印机未配置该渠道：仍落一条 SKIPPED 记录留痕，而不是静默什么都不做——
    // 店主在「打印记录」里能看到「这单本该出票但没配打印机」，而不是以为系统没触发。
    const dedupeKey = buildSkipDedupeKey(orderId, kind, baseSeq, 'NO_PRINTER_CONFIGURED')
    try {
      const row = await prisma.printJob.create({
        data: {
          orderId: order.id, orderNo: order.orderNo, kind, provider: providerName, printerSn: '',
          status: 'SKIPPED', content: renderForKind(kind, order, settings, dailySeq, baseSeq, opts.waitedMin),
          lastError: '未配置该渠道的打印机', dedupeKey,
        },
      })
      jobIds.push(row.id)
    } catch (e) {
      if (!isDuplicateKeyError(e)) throw e
    }
    return { enqueued: jobIds.length > 0, reason: 'NO_PRINTER_CONFIGURED', jobIds }
  }

  for (const printer of printers) {
    const content = renderForKind(kind, order, settings, dailySeq, baseSeq, opts.waitedMin)
    const dedupeKey = buildDedupeKey(orderId, kind, baseSeq, printer.sn)
    let row
    try {
      row = await prisma.printJob.create({
        data: {
          orderId: order.id, orderNo: order.orderNo, kind, provider: providerName,
          printerSn: printer.sn, status: 'PENDING', content, dedupeKey,
          // M1：入队时从 PrinterEntry.copies 快照；重试/补打/手动重试一律读这一列，
          // 不再各自硬编码 1（否则同城 2 联配置在重试路径上会丢失骑手联）。
          copies: printer.copies,
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

function isDuplicateKeyError(e: unknown): boolean {
  return typeof e === 'object' && e !== null && 'code' in e && (e as { code?: unknown }).code === 'P2002'
}

// ── 同 SN 串行发送（规格 §8b：同 SN 串行、间隔 ≥300ms）───────────────────
// 每台打印机一条进程内 Promise 链，attemptSend 对同 SN 的调用排队执行；链上前一个任务失败/被拒
// 不能卡住后面的（.catch 吞掉，交由各自的 handleSendFailure 处理）。这条链天然覆盖
// enqueueOrderTicket（首次发）、processQueue（重试/兜扫）、retryPrintJob、enqueuePrinterTestJob、
// retryRecoveredPrinterJobs 五处调用——它们全部经 attemptSend 出口，不用各自改。
const snSendQueues = new Map<string, Promise<void>>()

function serializePerSn(sn: string, providerName: PrinterProviderName, task: () => Promise<void>): Promise<void> {
  const prev = snSendQueues.get(sn) ?? Promise.resolve()
  const interval = providerName === 'FEIE' ? SEND_INTERVAL_MS : 0
  const next = prev.catch(() => undefined).then(async () => {
    await task()
    if (interval > 0) await new Promise((resolve) => setTimeout(resolve, interval))
  })
  snSendQueues.set(sn, next)
  return next
}

/** 单次发送尝试：更新 PrintJob 状态、必要时告警。被 enqueueOrderTicket（首次）与 processQueue（重试/兜扫）
 *  等共用。B6：入队后立即发送与定时兜扫无锁竞争会让同一行被 print() 两次（厨房做两份）——开头先用
 *  `status:'PENDING'→'SENDING'` 的条件 updateMany 认领，认领不到（count===0）说明另一个调用已经在发
 *  或这行已经不是可发状态，直接返回，不会真的调用 provider.print() 第二次。 */
async function attemptSend(
  jobId: number, providerName: PrinterProviderName, sn: string, content: string, copies: number
): Promise<void> {
  await serializePerSn(sn, providerName, () => attemptSendOnce(jobId, providerName, sn, content, copies))
}

async function attemptSendOnce(
  jobId: number, providerName: PrinterProviderName, sn: string, content: string, copies: number
): Promise<void> {
  const claimed = await prisma.printJob.updateMany({
    where: { id: jobId, status: 'PENDING' },
    data: { status: 'SENDING' },
  })
  if (claimed.count === 0) return // 已被并发的另一次调用认领在发，或该行已不是 PENDING（幂等退出）
  try {
    // H4：getProvider() 放在 try 内——某条历史脏行的 provider 字段是不认识的值（比如更早版本
    // 写入的 XPYUN，或手工改库）时，这里会抛 PrinterError('CONFIG', ...)，走下面的 catch 正常
    // 转成 FAILED，而不是直接从 attemptSendOnce 抛出去，把 processQueue 那一整轮兜死。
    const provider = getProvider(providerName)
    const result = await provider.print({ sn, content, copies })
    const written = await prisma.printJob.updateMany({
      where: { id: jobId, status: 'SENDING' },
      data: { status: 'SENT', providerJobId: result.providerJobId, sentAt: new Date(), lastError: null },
    })
    if (written.count === 0) {
      // R4：跟 handleSendFailure 里同一处坑对称——print() 已经物理成功了，但这一行在我们回写
      // SENT 之前已经不是 SENDING 了（唯一已知成因还是孤儿回收窗口比这次发送实际耗时短，行被
      // 提前收走、被另一轮 attemptSend 抢先认领）。这里更危险：物理上真的印出了一张票，
      // `providerJobId` 却没能落库——`result.providerJobId` 无处可查，这张票会变成一个孤儿
      // 打印记录，且这一行大概率会被"看起来还没发过"的另一次尝试再印一遍，造成真正的重复出票。
      // 不能静默吞掉，必须告警让人工介入核对。
      console.warn(`[ticket] print() 已物理成功但 SENDING→SENT 回写落空 job=${jobId} providerJobId=${result.providerJobId}：疑似重复打印`)
      notifySystemAlert('打印状态机异常：疑似重复打印', [
        `job=${jobId}`,
        `provider 返回的 providerJobId=${result.providerJobId} 未能落库`,
        '这张票已经物理打印成功，但系统记录可能会把它当成还没发送过，请人工核实是否重复出票',
      ], { key: `print:sending-lost:${jobId}` })
    }
  } catch (e) {
    const err = e instanceof PrinterError ? e : new PrinterError('BUSINESS', 'UNKNOWN', (e as Error).message)
    await handleSendFailure(jobId, err)
  }
}

/** M11：飞鹅打印接口无幂等 token。TIMEOUT 意味着我们不知道对端到底收没收到——正常错误类别
 *  「重试到第 4 次才 FAILED」的宽松上限（MAX_ATTEMPTS）不适用于这一类，重试本身就有真的多打
 *  一张纸的风险，最多只给 1 次重试机会（首发 + 1 次重试 = 2 次发送封顶）。 */
const TIMEOUT_MAX_ATTEMPTS = 2

async function handleSendFailure(jobId: number, err: PrinterError): Promise<void> {
  const job = await prisma.printJob.findUnique({
    where: { id: jobId },
    select: { attempts: true, orderNo: true, status: true, kind: true, orderId: true, printerSn: true, provider: true },
  })
  if (!job || job.status !== 'SENDING') return
  const lastError = `${err.kind}:${err.code} ${err.message}`.slice(0, 255)
  const nextAttempts = job.attempts + 1

  let shouldFail: boolean
  let alertTitle = '打印失败'
  let alertExtra = '打印机故障期间请留意工作台/推送，人工确认是否已接单'
  if (err.kind === 'TIMEOUT') {
    const exhausted = nextAttempts >= TIMEOUT_MAX_ATTEMPTS
    // D2（M11，乙情况更保守）：不确认打印机当前在线就不安排这唯一的一次重试——飞鹅这次到底
    // 收没收到本就存疑，再对着一台连状态都查不到/确认离线的机器重试，只是白白多等一轮超时；
    // 且如果原始请求其实已经进了云端队列，恢复后自己吐出 + 我们的重试各出一次就是真的多打一张。
    let onlineForRetry = false
    if (!exhausted) {
      try {
        const status = await getProvider(job.provider as PrinterProviderName).queryStatus(job.printerSn)
        onlineForRetry = status.state === 'ONLINE'
      } catch { /* 查状态本身也失败，按不在线处理，不安排重试 */ }
    }
    shouldFail = exhausted || !onlineForRetry
    alertTitle = '打印超时'
    alertExtra = exhausted
      ? '已达超时重试上限，可能已经打印成功，请查看打印机确认，避免漏单或重复出票'
      : '当前无法确认打印机在线，为避免重复打印已停止自动重试，请人工核实是否已出票'
  } else {
    // CONFIG 类错误（账号/密钥/打印机未绑定）重试没有意义，直接 FAILED，不占重试次数
    // M2：规格 §8b 是「失败按 5s/30s/2min 重试 3 次后 FAILED」= 首发 + 3 次重试 = 最多 4 次发送。
    // retryDelaysMs.length===3 对应「还能再重试 3 次」，所以终止条件是 nextAttempts 严格大于它
    // （nextAttempts=4 时才判定重试耗尽），而不是 >=（原来 nextAttempts=3 就终止，总共只发了
    // 3 次，比规格少一次）。
    shouldFail = err.kind === 'CONFIG' || nextAttempts > MAX_ATTEMPTS()
  }
  const written = await prisma.printJob.updateMany({
    where: { id: jobId, status: 'SENDING' },
    // M14：绝对值读-改-写窗口本来就已经被 SENDING 认领关闭了（同一行只有认领者本人在改），
    // 这里仍然改用 increment——认领态失败回写的窗口更短，没有理由不用更安全的写法。
    data: { attempts: { increment: 1 }, lastError, status: shouldFail ? 'FAILED' : 'PENDING' },
  })
  if (written.count === 0) {
    // R4：这一行在我们查完 job 快照（还是 SENDING）之后、真正回写之前，已经不是 SENDING 了——
    // 唯一已知成因是孤儿回收窗口比这次 handleSendFailure 实际耗时短，把仍在处理中的行提前
    // 收走、又被同一行新一轮 attemptSend 抢先认领。这条 updateMany 落空意味着 attempts 不会
    // 递增、不会判 FAILED、不会告警——状态机出现了没人负责的洞，不能静默吞掉，否则同样的
    // 竞速会无限重复（R4 的原始故障就是这样循环的）。
    console.warn(`[ticket] handleSendFailure 回写落空 job=${jobId}：该行已不是 SENDING（疑似被孤儿回收提前收走），可能造成无限重发`)
    notifySystemAlert('打印状态机异常', [
      `订单 ${job.orderNo}`,
      `job=${jobId} 的 SENDING→${shouldFail ? 'FAILED' : 'PENDING'} 回写命中 0 行`,
      '请人工核实该打印作业是否在无限重发，必要时检查 SENDING_ORPHAN_AFTER_MS 是否又短于实际发送耗时',
    ], { key: `print:sending-lost:${jobId}` })
    return
  }
  if (shouldFail) {
    notifySystemAlert(alertTitle, [`订单 ${job.orderNo}`, lastError, alertExtra], {
      key: `print:failed:${jobId}`,
    })
    // M3：打印机是接单流程的单点，NEW_ORDER 票彻底打印失败可能意味着厨房完全不知道有这一单——
    // 光靠 notifySystemAlert（文案只有订单号，还可能被限频吞掉）不够，规格要求的兜底是回退
    // 强化推送（文案带商品与地址，店主拿到就能直接派单）。CANCEL/REPEAT 等其它 kind 不推：
    // 店员已经从别的渠道知道这单存在，不需要再单独推一条。
    if (job.kind === 'NEW_ORDER') {
      try {
        const order = await prisma.order.findUnique({
          where: { id: job.orderId },
          select: {
            orderNo: true, actualAmount: true, receiverName: true, receiverPhone: true, receiverFullAddress: true,
            items: { select: { productName: true, specText: true, quantity: true } },
          },
        })
        if (order) notifyPrintFailed(order, order.items)
      } catch (e2) {
        console.warn('[ticket] 打印彻底失败后查订单详情失败（推送兜底跳过）:', (e2 as Error).message)
      }
    }
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
  const orphanAfterMs = sendingOrphanAfterMsOverride ?? SENDING_ORPHAN_AFTER_MS

  // 孤儿回收：进程在 SENDING 认领之后、写回 SENT/PENDING/FAILED 之前被杀（部署重启/崩溃），
  // 这一行会永远停在 SENDING、再也不被任何查询选中。超过「两次 provider 外呼都超时的最坏耗时
  // + 缓冲」（R4）还没转出，按「这次发送大概率没有真正完成」处理，退回 PENDING 重新进入正常
  // 重试路径。
  await prisma.printJob.updateMany({
    where: { status: 'SENDING', updatedAt: { lt: new Date(now - orphanAfterMs) } },
    data: { status: 'PENDING', lastError: 'SENDING:ORPHANED' },
  })

  const pending = await prisma.printJob.findMany({
    where: { status: 'PENDING' },
    orderBy: { createdAt: 'asc' },
    take: BATCH,
  })
  for (const job of pending) {
    // M2：第一次失败后 job.attempts=1，意味着"已经失败过 1 次"，接下来这次是第 1 次重试，
    // 应该按 retryDelaysMs[0]（5s）等待——用 attempts（而不是 attempts-1... 等等，反过来）
    // 原来的 `retryDelaysMs[min(attempts, len-1)]` 在 attempts=1 时取到 delays[1]（30s），
    // 把「首次重试该等 5s」错发成等 30s。正确下标是 attempts-1（第 N 次失败后，下一次是第 N
    // 次重试，用 delays[N-1]）；attempts=0（从未失败过，比如孤儿回收刚重置回 PENDING 之外的
    // 全新行）不会走到这个分支，下面的 `job.attempts > 0` 守卫已经短路掉了。
    const delay = job.attempts > 0 ? retryDelaysMs[Math.min(job.attempts - 1, retryDelaysMs.length - 1)] : 0
    if (job.attempts > 0 && now - job.updatedAt.getTime() < delay) continue
    try {
      // H4：单条脏行（比如 provider 字段被更早版本写成了不认识的值）不能把这一轮剩下的所有作业
      // 都拖死——attemptSend 内部已经把 getProvider() 挪进了 try（会被 handleSendFailure 正常
      // 转成 FAILED），这里再包一层是防御性的：万一 claim 那一步的 prisma 调用本身抛出（比如
      // DB 抖动），也只丢这一条，不影响同一轮里的其它作业。
      // M1：读该行自己的 copies（入队时从 PrinterEntry.copies 快照），不再硬编码 1。
      await attemptSend(job.id, job.provider as PrinterProviderName, job.printerSn, job.content, job.copies)
      retried++
    } catch (e) {
      console.warn(`[ticket] 重试发送异常 job=${job.id}:`, (e as Error).message)
    }
  }

  const sentDeadline = new Date(now - SENT_CONFIRM_AFTER_MS)
  const sent = await prisma.printJob.findMany({
    // M4：lastError:null 排除掉已经被判定 CONFIRM:GAVE_UP 的僵尸行——不然它们会一直占着
    // sentAt 最早、排在批次最前面的位置，把后面真正需要确认的新 SENT 行挤出这一轮。
    where: { status: 'SENT', sentAt: { lt: sentDeadline }, lastError: null },
    orderBy: { sentAt: 'asc' },
    take: SENT_CONFIRM_BATCH,
  })
  for (const job of sent) {
    if (!job.providerJobId) continue
    const staleForTooLong = job.sentAt !== null && now - job.sentAt.getTime() > SENT_GIVE_UP_AFTER_MS
    try {
      const provider = getProvider(job.provider as PrinterProviderName)
      const result = await provider.queryJob(job.providerJobId)
      if (result.printed) {
        const moved = await prisma.printJob.updateMany({
          where: { id: job.id, status: 'SENT' },
          data: { status: 'PRINTED', printedAt: new Date() },
        })
        confirmed += moved.count
      } else if (staleForTooLong) {
        await prisma.printJob.updateMany({ where: { id: job.id, status: 'SENT' }, data: { lastError: 'CONFIRM:GAVE_UP' } })
      }
      // 还没打印完成、也没超过放弃窗口：保持 SENT，下一轮再查（飞鹅无回调可依赖时，这是唯一的确认路径）
    } catch (e) {
      // 飞鹅对久远/不存在的 providerJobId 返回 ret=1001「订单ID错误」——这类行永远查不出结果，
      // 跟「已经查了 24h 还没定论」一样，都属于「放弃继续查」，不是「打印失败」（我们并不知道
      // 它到底有没有打印成功，只是不再主动确认了，不能武断改判 FAILED 造成误告警）。
      const isOrderNotFound = e instanceof PrinterError && e.code === '1001'
      if (isOrderNotFound || staleForTooLong) {
        await prisma.printJob.updateMany({ where: { id: job.id, status: 'SENT' }, data: { lastError: 'CONFIRM:GAVE_UP' } })
        continue
      }
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
  let settings: PrinterSettings
  try {
    settings = await getPrinterSettings()
  } catch (e) {
    console.warn('[ticket] repeatAnnounce 读配置失败，本轮跳过:', (e as Error).message)
    return { announced: 0, exhausted: 0 }
  }
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
  let settings: PrinterSettings
  try {
    settings = await getPrinterSettings()
  } catch (e) {
    console.warn('[ticket] healthCheck 读配置失败，本轮跳过:', (e as Error).message)
    return []
  }
  if (!settings.enabled || settings.printers.length === 0) return []
  const providerName = activeProviderName(settings)
  const results: PrinterHealthEntry[] = []
  for (const p of settings.printers) {
    try {
      const provider = getProvider(providerName)
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
  const dedupeKey = buildDedupeKey(0, 'TEST', Date.now(), sn)
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
/** D2（H5b）：`wasOffline` 独立于 `alerted` 跟踪——云端排队从打印机一断线就开始堆积，不等
 *  `offlineAlertMin` 阈值。哪怕这次离线短到没触发告警，恢复时也要检查 waiting 决定要不要清队列。 */
interface PrinterHealthTrack { offlineSince: number | null; alerted: boolean; wasOffline: boolean }
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
export function _setPrinterHealthTrackForTest(
  sn: string, track: { offlineSince: number | null; alerted: boolean; wasOffline?: boolean }
): void {
  healthTrack.set(sn, { offlineSince: track.offlineSince, alerted: track.alerted, wasOffline: track.wasOffline ?? false })
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
      // getProvider() 已经挪进了 attemptSend 内部的 try（H4），单条历史脏数据不会把整个
      // printerHealthTask 拖垮；这里仍然包一层，防的是 attemptSend 之外的意外抛出（比如
      // claim 那一步 prisma 调用本身失败），让恢复补打这个批处理循环里一条坏行不连累其它行——
      // 对照 processQueue() 里 SENT 确认循环同样的 try/catch 写法。
      // M1：读该行自己入队时快照的 copies（同城 2 联等配置），不再硬编码 1。
      await attemptSend(job.id, job.provider as PrinterProviderName, job.printerSn, job.content, job.copies)
      count++
    } catch (e) {
      console.warn(`[ticket] 恢复补打失败 job=${job.id}:`, (e as Error).message)
    }
  }
  return count
}

/**
 * D2（H5/H5b，取代原 H5 修法）：2026-09-05 真机实验证实打印机离线时 `Open_printMsg` 仍返回成功，
 * 票排进飞鹅云端队列——不是失败，`PrintJob` 走的是正常的 SENT 路径，永远不会因为离线走到 FAILED，
 * 所以「补打 FAILED」在这条路上无的放矢。真正的风险是：恢复瞬间飞鹅会把队列**全部自动吐出**，
 * 我们既无法从中挑选，也不知道里面有没有几小时前的陈年旧单。应对分两步：
 * 1. 查 `waiting`——队列里有积压才值得动，没有就什么都不用做（避免每次「随便一次离线又恢复」
 *    都无谓地清队列）。
 * 2. `waiting > 0`：先 `clearQueue` 丢弃飞鹅那边可能还没来得及吐出的陈旧积压，再改由我们自己
 *    权威的 `PrintJob` 表决定补发谁——30 分钟内的 PENDING/SENT-未确认行重新走一次 `attemptSend`
 *    （不管当时是通过 print() 真正排队还是刚好还没来得及发都一并处理）；超过 30 分钟的旧单不再
 *    补打（规格 §8b 明确要求），改标 FAILED + `lastError='STALE:DROPPED'`，不告警（这只是「不再
 *    追」，不是「打印机出了新故障」，不该占用告警配额）。
 * `clearQueue` 失败不阻断后续补发——两害相权：宁可小概率因飞鹅那边残留而重复出一张，也不能让
 * 恢复补打这条路径卡死，参照 D 组 M1/M14 一贯的「防御性 try/catch，坏一条不连累全部」风格。
 */
export async function recoverFromOfflineQueue(
  sn: string, providerName: PrinterProviderName
): Promise<{ backfilled: number; dropped: number }> {
  let waiting = 0
  try {
    const provider = getProvider(providerName)
    waiting = (await provider.queryQueueInfo(sn)).waiting
  } catch (e) {
    console.warn(`[ticket] 查询打印机云端队列积压失败 sn=${sn}（跳过本轮清队列/补发）:`, (e as Error).message)
    return { backfilled: 0, dropped: 0 }
  }
  if (waiting <= 0) return { backfilled: 0, dropped: 0 }

  try {
    await getProvider(providerName).clearQueue(sn)
  } catch (e) {
    console.warn(`[ticket] 清空打印机云端队列失败 sn=${sn}（继续尝试从本地记录补发，接受极小概率的重复打印风险）:`, (e as Error).message)
  }

  const cutoff = new Date(Date.now() - RECOVER_BACKFILL_MS)

  // 超过 30 分钟窗口的旧单：不再补打，标 STALE:DROPPED（不是新故障，不告警）
  const stale = await prisma.printJob.findMany({
    where: { printerSn: sn, status: { in: ['PENDING', 'SENT'] }, createdAt: { lt: cutoff } },
    orderBy: { createdAt: 'asc' },
    take: BATCH,
  })
  let dropped = 0
  for (const job of stale) {
    const moved = await prisma.printJob.updateMany({
      where: { id: job.id, status: job.status },
      data: { status: 'FAILED', lastError: 'STALE:DROPPED' },
    })
    dropped += moved.count
  }

  // 窗口内的行：重置为 PENDING 后走正常的 attemptSend 认领链路重新发送一次
  const recent = await prisma.printJob.findMany({
    where: { printerSn: sn, status: { in: ['PENDING', 'SENT'] }, createdAt: { gte: cutoff } },
    orderBy: { createdAt: 'asc' },
    take: BATCH,
  })
  let backfilled = 0
  for (const job of recent) {
    const moved = await prisma.printJob.updateMany({
      where: { id: job.id, status: job.status },
      data: { status: 'PENDING', attempts: 0, lastError: null },
    })
    if (moved.count === 0) continue
    try {
      await attemptSend(job.id, job.provider as PrinterProviderName, job.printerSn, job.content, job.copies)
      backfilled++
    } catch (e) {
      console.warn(`[ticket] 离线恢复补发失败 job=${job.id}:`, (e as Error).message)
    }
  }
  return { backfilled, dropped }
}

export interface PrinterHealthTaskResult { checked: number; alerted: number; recovered: number; backfilled: number }

/**
 * scheduler 的 `printerHealth` 任务本体：查一次全部已配置打印机的状态，用进程内 Map 跟踪「从何时起
 * 持续离线/异常」，跨过 `offlineAlertMin` 分钟才告警一次；从异常恢复到 ONLINE 时告知一次并触发补打。
 * 顺带把这次查询结果写进 `lastHealthSnapshot`，供 workbench 快照直接读缓存、不必每次轮询都外呼。
 */
export async function printerHealthTask(): Promise<PrinterHealthTaskResult> {
  let settings: PrinterSettings
  try {
    settings = await getPrinterSettings()
  } catch (e) {
    console.warn('[ticket] printerHealthTask 读配置失败，本轮跳过:', (e as Error).message)
    lastHealthSnapshot = { at: Date.now(), entries: [] }
    return { checked: 0, alerted: 0, recovered: 0, backfilled: 0 }
  }
  if (!settings.enabled || settings.printers.length === 0) {
    lastHealthSnapshot = { at: Date.now(), entries: [] }
    return { checked: 0, alerted: 0, recovered: 0, backfilled: 0 }
  }
  const entries = await healthCheck()
  lastHealthSnapshot = { at: Date.now(), entries }
  const now = Date.now()
  const knownSns = new Set(entries.map((e) => e.sn))
  for (const sn of healthTrack.keys()) if (!knownSns.has(sn)) healthTrack.delete(sn)
  const providerName = activeProviderName(settings)

  let alerted = 0
  let recovered = 0
  let backfilled = 0
  for (const e of entries) {
    const bad = e.state === 'OFFLINE' || e.state === 'ABNORMAL' || e.state === 'ERROR'
    const track = healthTrack.get(e.sn) ?? { offlineSince: null, alerted: false, wasOffline: false }
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
      // D2：只在真的是「离线」（网络/电源断开）时才置位——ABNORMAL（卡纸/开盖）走的是
      // print() 直接失败 + FAILED 补打的老路，不会有云端队列积压。
      if (e.state === 'OFFLINE') track.wasOffline = true
    } else {
      if (track.alerted) {
        recovered++
        notifySystemAlert('打印机已恢复', [`打印机 ${e.name}（${e.sn}）`], { key: `printer:recovered:${e.sn}` })
        backfilled += await retryRecoveredPrinterJobs(e.sn)
      }
      // D2（H5b）：不依赖 alerted——哪怕这次离线短到没触发告警阈值，只要曾经是 OFFLINE，
      // 恢复时都要查一次 waiting，决定要不要清云端队列 + 从本地记录补发。
      if (track.wasOffline) {
        try {
          const { backfilled: n } = await recoverFromOfflineQueue(e.sn, providerName)
          backfilled += n
        } catch (err) {
          console.warn(`[ticket] 离线恢复清队列/补发异常 sn=${e.sn}:`, (err as Error).message)
        }
      }
      track.offlineSince = null
      track.alerted = false
      track.wasOffline = false
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

/** D2（H5b）：后台手动「清空云端队列」按钮——`printerHealthTask` 恢复检测到 waiting>0 时会自动调用，
 *  这里额外开放一个手动入口（店主怀疑队列里堆了陈年旧单，不想等下一轮健康检测）。**清空整个队列，
 *  不能按单删**，调用前请知会店主。 */
export async function clearPrinterQueue(sn: string): Promise<void> {
  const settings = await getPrinterSettings()
  const providerName = activeProviderName(settings)
  await getProvider(providerName).clearQueue(sn)
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
  // M1：读该行自己的 copies（入队时从 PrinterEntry.copies 快照），不再硬编码 1。
  await attemptSend(jobId, job.provider as PrinterProviderName, job.printerSn, job.content, job.copies)
  const updated = await prisma.printJob.findUnique({ where: { id: jobId }, select: { status: true } })
  return { ok: true, status: updated?.status ?? 'PENDING' }
}
