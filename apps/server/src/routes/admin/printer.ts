/**
 * 打印机后台接口（规格 §8b「后台」/「接口」两节）。本批只做服务端，`apps/admin/` 前端页面
 * （`PrinterSettings.tsx`）是下一批的事——这里把它需要的接口先做出来。
 *
 * 挂载方式（见 routes/admin/index.ts）：本文件只有一个默认导出的 Router，内部用完整相对路径
 * （`/settings/printer`、`/printers/*`、`/print-jobs*`、`/orders/:id/reprint`）而不是挂在单一前缀
 * 下，因为这几组路径散落在既有的 `/settings`、`/orders` 命名空间里，与现成的 `settingsRouter`、
 * `ordersRouter` 平级共存。索性把它们放进同一个默认导出、在 `index.ts` 里整体 `router.use('/', ...)`
 * 挂在最后：Express 的 Router 在子路径找不到匹配路由时会 next() 穿透，不会跟前面已挂载的
 * `settingsRouter`/`ordersRouter` 产生冲突（两边都没有同名路由）。
 *
 * mock 专用的控制面（`printerMockRouter`）单独导出，只在 `config.mock.printer` 为真时才在
 * index.ts 里挂载——生产环境这组路由压根不存在，不是靠鉴权/环境判断拒绝（与 kd100-mock.ts 同款）。
 */
import { Router, Request, Response, NextFunction } from 'express'
import { z } from 'zod'
import prisma from '../../utils/prisma'
import { success } from '../../utils/response'
import { AppError } from '../../middlewares/error'
import {
  getPrinterSettings, setPrinterSettings, sanitizePrinterSettings, validatePrinterSettings,
} from '../../services/printer-settings'
import {
  bindPrinterToAccount, unbindPrinter, enqueuePrinterTestJob, healthCheck, retryPrintJob,
  enqueueOrderTicket, _setRetryDelaysMsForTest, _resetRetryDelaysMsForTest, _resetPrinterHealthTrack,
  _setPrinterHealthTrackForTest, _setRepeatAnnounceMinWaitMsForTest, clearPrinterQueue,
} from '../../services/ticket'
import { PrinterError, PrinterOnlineState } from '../../services/ticket/printer'
import {
  _resetMockPrinter, _setMockPrinterState, _setMockPrintFailure, _listMockJobs, _setMockPrintDelay,
  _mockQueueWaiting, _markMockCloudJobPrinted, _setMockAutoFlushOnRecover,
} from '../../services/ticket/mock'

const router = Router()

// ─────────────────────────────────────────────────────────
// GET/PUT /admin/settings/printer
// ─────────────────────────────────────────────────────────
router.get('/settings/printer', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    success(res, await getPrinterSettings())
  } catch (e) { next(e) }
})

router.put('/settings/printer', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const next_ = sanitizePrinterSettings(req.body)
    const errs = validatePrinterSettings(next_)
    if (errs.length) throw new AppError(40001, errs.join('；'))
    success(res, await setPrinterSettings(next_))
  } catch (e) { next(e) }
})

// ─────────────────────────────────────────────────────────
// 打印机绑定/解绑/测试页/状态
// ─────────────────────────────────────────────────────────
const bindSchema = z.object({
  sn: z.string().trim().min(1, '请填写打印机编号').max(32),
  key: z.string().trim().min(1, '请填写打印机绑定密钥').max(64),
  name: z.string().trim().max(64).optional(),
})

router.post('/printers/bind', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const input = bindSchema.parse(req.body ?? {})
    success(res, await bindPrinterToAccount(input))
  } catch (e) {
    next(mapPrinterError(e))
  }
})

// D2（H5b）：手动清空该打印机云端待打印队列（飞鹅 Open_delPrinterSqs）。清空整个队列、不能按单删，
// 正常情况下由 printerHealthTask 在检测到「从离线恢复且 waiting>0」时自动调用，这里是给店主的手动入口。
router.post('/printers/:sn/clear-queue', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sn = String(req.params.sn || '').trim()
    if (!sn) throw new AppError(40001, '打印机编号不能为空')
    await clearPrinterQueue(sn)
    success(res, { ok: true })
  } catch (e) {
    next(mapPrinterError(e))
  }
})

router.delete('/printers/:sn', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sn = String(req.params.sn || '').trim()
    if (!sn) throw new AppError(40001, '打印机编号不能为空')
    success(res, await unbindPrinter(sn))
  } catch (e) { next(e) }
})

router.post('/printers/:sn/test', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sn = String(req.params.sn || '').trim()
    if (!sn) throw new AppError(40001, '打印机编号不能为空')
    success(res, await enqueuePrinterTestJob(sn))
  } catch (e) {
    next(mapPrinterError(e))
  }
})

// 现查一次全部已配置打印机状态（供后台「打印机设置」页手动刷新用；工作台顶栏状态灯走的是
// GET /admin/workbench/snapshot 里缓存过的 getWorkbenchPrinterHealth，两者刻意分开——
// 这里是「我现在点一下想看最新的」，那边是「10 秒轮询别把飞鹅打爆」）。
router.get('/printers/status', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    success(res, await healthCheck())
  } catch (e) {
    next(mapPrinterError(e))
  }
})

// ─────────────────────────────────────────────────────────
// 打印记录：列表 + 失败重试；订单卡「重打小票」
// ─────────────────────────────────────────────────────────
const listSchema = z.object({
  orderId: z.coerce.number().int().positive().optional(),
})

router.get('/print-jobs', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { orderId } = listSchema.parse(req.query)
    const where = orderId ? { orderId } : {}
    const [list, total] = await Promise.all([
      prisma.printJob.findMany({ where, orderBy: { createdAt: 'desc' }, take: orderId ? 50 : 20 }),
      prisma.printJob.count({ where }),
    ])
    success(res, { list, total })
  } catch (e) { next(e) }
})

router.post('/print-jobs/:id/retry', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id)
    if (!Number.isInteger(id) || id <= 0) throw new AppError(40001, '无效的打印记录 ID')
    const result = await retryPrintJob(id)
    if (!result.ok) {
      const reasonMsg: Record<string, string> = {
        NOT_FOUND: '打印记录不存在',
        NOT_RETRYABLE: '仅失败状态的打印记录可重试',
        CONCURRENT: '打印记录状态已变化，请刷新',
      }
      throw new AppError(result.reason === 'NOT_FOUND' ? 40401 : 40001, reasonMsg[result.reason])
    }
    success(res, result)
  } catch (e) {
    next(mapPrinterError(e))
  }
})

// POST /admin/orders/:id/reprint — 店员「重打」；两渠道通用（EXPRESS/LOCAL 订单都能重打）
router.post('/orders/:id/reprint', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id)
    if (!Number.isInteger(id) || id <= 0) throw new AppError(40001, '无效的订单 ID')
    const result = await enqueueOrderTicket(id, 'REPRINT')
    if (!result.enqueued) {
      const reasonMsg: Record<string, string> = {
        ORDER_NOT_FOUND: '订单不存在',
        PRINTER_DISABLED: '打印机功能未启用',
        CANCEL_TICKET_DISABLED: '打印机功能未启用',
        NO_PRINTER_CONFIGURED: '该订单所属渠道尚未配置打印机',
      }
      throw new AppError(
        result.reason === 'ORDER_NOT_FOUND' ? 40401 : 42240,
        reasonMsg[result.reason ?? ''] ?? '重打失败'
      )
    }
    success(res, result)
  } catch (e) {
    next(mapPrinterError(e))
  }
})

/** PrinterError（来自 services/ticket）落到路由层统一映射成规格 §8b 的三个错误码；其余错误原样透传 */
function mapPrinterError(e: unknown): unknown {
  if (!(e instanceof PrinterError)) return e
  if (e.kind === 'CONFIG') return new AppError(42240, `打印机未配置：${e.message}`)
  if (e.kind === 'CAPACITY') return new AppError(42241, `打印机离线：${e.message}`)
  return new AppError(42242, `打印提交失败：${e.message}`)
}

export default router

// ─────────────────────────────────────────────────────────
// mock 专用控制面（仅 PRINTER_PROVIDER_MOCK=true 时挂载，供本地开发与 e2e）
// ─────────────────────────────────────────────────────────
export const printerMockRouter = Router()

printerMockRouter.post('/reset', async (_req: Request, res: Response) => {
  _resetMockPrinter()
  _resetPrinterHealthTrack()
  _resetRetryDelaysMsForTest()
  _setRepeatAnnounceMinWaitMsForTest(null)
  success(res, { ok: true })
})

const repeatMinWaitSchema = z.object({ ms: z.number().int().min(0).nullable() })
printerMockRouter.post('/repeat-min-wait', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { ms } = repeatMinWaitSchema.parse(req.body ?? {})
    _setRepeatAnnounceMinWaitMsForTest(ms)
    success(res, { ok: true })
  } catch (e) { next(e) }
})

const stateSchema = z.object({
  sn: z.string().trim().min(1),
  state: z.enum(['ONLINE', 'ABNORMAL', 'OFFLINE', 'UNKNOWN']),
})
printerMockRouter.post('/state', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { sn, state } = stateSchema.parse(req.body ?? {})
    _setMockPrinterState(sn, state as PrinterOnlineState)
    success(res, { ok: true })
  } catch (e) { next(e) }
})

const failSchema = z.object({
  sn: z.string().trim().min(1),
  kind: z.enum(['CONFIG', 'CAPACITY', 'BUSINESS', 'TIMEOUT']),
  message: z.string().trim().max(200).optional(),
})
printerMockRouter.post('/fail', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { sn, kind, message } = failSchema.parse(req.body ?? {})
    _setMockPrintFailure(sn, kind, message)
    success(res, { ok: true })
  } catch (e) { next(e) }
})

printerMockRouter.get('/jobs', async (req: Request, res: Response) => {
  const sn = typeof req.query.sn === 'string' ? req.query.sn : undefined
  success(res, _listMockJobs(sn))
})

// D2：e2e 用来断言「离线时下发的作业已经进了 mock 的云端队列（waiting>0）」，不依赖真实调用
// Open_printerInfo（那是 feie.ts 的事），只读 mock 自己的内部状态。
printerMockRouter.get('/queue', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sn = String(req.query.sn || '').trim()
    if (!sn) throw new AppError(40001, '打印机编号不能为空')
    success(res, { waiting: _mockQueueWaiting(sn) })
  } catch (e) { next(e) }
})

// B6 复现用：让某台打印机的 print() 人为变慢，撑大「入队后立即发送」与「定时兜扫」的竞争窗口
const delaySchema = z.object({ sn: z.string().trim().min(1), ms: z.number().int().min(0).max(10_000) })
printerMockRouter.post('/delay', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { sn, ms } = delaySchema.parse(req.body ?? {})
    _setMockPrintDelay(sn, ms)
    success(res, { ok: true })
  } catch (e) { next(e) }
})

// 覆盖退避重试等待时长，秒级验证「重试耗尽→FAILED」而不必真等 5s+30s+2min
const retryDelaysSchema = z.object({
  delays: z.array(z.number().int().min(0).max(5000)).length(3),
})
printerMockRouter.post('/retry-delays', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { delays } = retryDelaysSchema.parse(req.body ?? {})
    _setRetryDelaysMsForTest(delays)
    success(res, { ok: true })
  } catch (e) { next(e) }
})

// 直接写打印机健康跟踪状态：`offlineAlertMin` 下限是 1 分钟（printer-settings.ts 的 sanitize 规则），
// 没法靠调阈值到 0 来秒级触发告警，e2e 改用「把 offlineSince 设成足够早」来跳过真实等待。
const healthTrackSchema = z.object({
  sn: z.string().trim().min(1),
  offlineSinceMsAgo: z.number().int().min(0).nullable(),
  alerted: z.boolean(),
})
printerMockRouter.post('/health-track', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { sn, offlineSinceMsAgo, alerted } = healthTrackSchema.parse(req.body ?? {})
    _setPrinterHealthTrackForTest(sn, {
      offlineSince: offlineSinceMsAgo === null ? null : Date.now() - offlineSinceMsAgo,
      alerted,
    })
    success(res, { ok: true })
  } catch (e) { next(e) }
})

// R7 复核第二轮：e2e 用来模拟「打印机在我们 queryQueueInfo/clearQueue 这两次外呼之间的空档，
// 已经自己把某张票吐出去了」这个竞态窗口（见 services/ticket/mock.ts 的
// `_markMockCloudJobPrinted` 注释）——不这样模拟的话，「离线恢复后物理只印 1 次」这类断言测不出
// recoverFromOfflineQueue 重发前的 queryJob-before-resend 检查（R5/R7）到底生效没有：mock 不会
// 自己制造第二次 print()，断言在这条检查缺失时也照样通过。
// 注意：不要用「恢复即整队列吐出」（_setMockAutoFlushOnRecover）来测这条——那个开关会在状态
// 切换的同时把 cloudQueue 整个清空，recoverFromOfflineQueue 一进来看到 waiting===0 就直接提前
// return 了，根本走不到 queryJob-before-resend 那段代码，测不出东西。这里用的是「waiting 依然
// >0（还没被我们观测到清零），但这一条具体的作业其实已经被物理打印」这个更精确的竞态。
// R7 的**多数路径**开关：真机实测「通电 74s 后打印机在线时，队列里的票已经自己吐完了、
// waiting=0」，而我们的健康检测是 60s 轮询——绝大多数情况下我们观测到的就是 waiting=0，
// recoverFromOfflineQueue 一进来就 return，整套 clearQueue + 补发一行都不执行。
// mock 默认不模拟这个瞬间（刻意简化），导致 e2e 全部押在 waiting>0 这条少数路径上。
// 这个开关把多数路径也变成可测：开了之后 OFFLINE→ONLINE 会把 cloudQueue 直接搬进 jobs。
const autoFlushSchema = z.object({ sn: z.string().trim().min(1), enabled: z.boolean() })
printerMockRouter.post('/auto-flush', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { sn, enabled } = autoFlushSchema.parse(req.body ?? {})
    _setMockAutoFlushOnRecover(sn, enabled)
    success(res, { ok: true })
  } catch (e) { next(e) }
})

const markPrintedSchema = z.object({ providerJobId: z.string().trim().min(1) })
printerMockRouter.post('/mark-cloud-job-printed', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { providerJobId } = markPrintedSchema.parse(req.body ?? {})
    _markMockCloudJobPrinted(providerJobId)
    success(res, { ok: true })
  } catch (e) { next(e) }
})
