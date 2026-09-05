/**
 * 打印机 mock provider：本地开发与 e2e 用（PRINTER_PROVIDER_MOCK=true，生产禁止开启，见 config.ts）。
 * 不打真实飞鹅接口，落一份进程内队列，供 e2e 断言「已打印」「查询状态」等行为，形状与 feie.ts 对齐。
 *
 * 可选择性注入异常（参考 services/delivery/mock.ts 的做法）：调用方在 e2e 里可以把某个 sn 标记为
 * OFFLINE/FAIL，验证 services/ticket/index.ts 的失败分支与告警路径，而不用真的接一台硬件。
 */
import {
  PrinterProvider, PrintTicketInput, PrintTicketResult, PrinterStatusResult, QueryJobResult,
  BindPrinterInput, PrinterError, PrinterOnlineState, PrinterQueueInfo,
} from './printer'

interface MockJob { id: string; sn: string; content: string; copies: number; printedAt: number }
/** D2（H5b）：离线期间「已提交但还没被飞鹅吐出来」的票，模拟飞鹅云端队列——不在 `jobs` 里，
 *  `queryJob` 因此查不到（printed:false），直到 `clearQueue` 丢弃或（真机行为）打印机自己恢复吐出。
 *  本 mock 不模拟「打印机一恢复就自动吐出」那个瞬间的竞态（真机实验里两者几乎同时发生，
 *  我们的健康检测来不及抢在前面）——这是刻意简化，见 D2 交付报告。 */
interface CloudQueuedJob { id: string; sn: string; content: string; copies: number; queuedAt: number }

const jobs = new Map<string, MockJob>()
const cloudQueue = new Map<string, CloudQueuedJob[]>()
/** e2e 可写：sn → 强制在线状态 或 强制下一次 print 抛出的错误 */
const forcedState = new Map<string, PrinterOnlineState>()
const forcedPrintError = new Map<string, { kind: 'CONFIG' | 'CAPACITY' | 'BUSINESS' | 'TIMEOUT'; message: string }>()
/** e2e 可写：sn → print() 人为延迟毫秒数，用于复现「立即发送」与「定时兜扫」的无锁竞争（B6）。
 *  R4 复核第二轮：同一个延迟也应用在 queryStatus() 上——真机的 Open_printMsg 与
 *  Open_queryPrinterStatus 都是独立的 10s 超时外呼，`handleSendFailure` 的 TIMEOUT 分支会在
 *  print() 超时之后紧接着再查一次 queryStatus()，两者叠加才是 SENDING 状态真实能拖多久的
 *  上界；只让 print() 慢而 queryStatus() 瞬间返回，测不出这条叠加关系（R4 的孤儿回收窗口）。 */
const forcedDelayMs = new Map<string, number>()
/** e2e 可写：sn → 是否模拟真机「打印机一恢复上线就把云端队列全部自动吐出」的时序（R7）。
 *  默认关闭，保持 D2 交付时的刻意简化（详见 `CloudQueuedJob` 的注释）——开启后，
 *  `_setMockPrinterState(sn, 'ONLINE')` 在探测到该 sn 之前是 OFFLINE 时，会把 cloudQueue
 *  里堆积的作业直接搬进 jobs（视为已经物理打印完成），复现真机「健康检测 60s 轮询追不上
 *  打印机自己 74s 就把队列吐光」的多数情况，让 `recoverFromOfflineQueue`（R5 的
 *  queryJob-before-resend 检查）有机会在测试里被真正跑到，而不是永远只测「还没被吐出」
 *  这一种简化路径。 */
const autoFlushOnRecoverSns = new Set<string>()
let seq = 0

/** 仅测试/e2e 用：清空 mock 内部状态，避免跨用例串味 */
export function _resetMockPrinter(): void {
  jobs.clear()
  cloudQueue.clear()
  forcedState.clear()
  forcedPrintError.clear()
  forcedDelayMs.clear()
  autoFlushOnRecoverSns.clear()
  seq = 0
}

/** 仅测试/e2e 用：开关某台打印机的「恢复即吐出」模拟（R7，见 `autoFlushOnRecoverSns` 注释） */
export function _setMockAutoFlushOnRecover(sn: string, enabled: boolean): void {
  if (enabled) autoFlushOnRecoverSns.add(sn)
  else autoFlushOnRecoverSns.delete(sn)
}

/** 仅测试/e2e 用：把某条还「挂在」云端队列里的作业标记为已经物理打印完成，但**不**从 cloudQueue
 *  移除（`queryQueueInfo` 因此仍会如实报告 waiting>0）——模拟真机「我们还没来得及观测到 waiting
 *  清零，飞鹅那边其实已经把这张票吐出去了」的竞态窗口（R7），用来验证 `recoverFromOfflineQueue`
 *  重发前的 `queryJob` 检查（R5）能不能拦住重复打印，而不必依赖真实的并发时序。 */
export function _markMockCloudJobPrinted(providerJobId: string): void {
  for (const q of cloudQueue.values()) {
    const item = q.find((j) => j.id === providerJobId)
    if (item) {
      jobs.set(item.id, { id: item.id, sn: item.sn, content: item.content, copies: item.copies, printedAt: Date.now() })
      return
    }
  }
}

/** 仅测试/e2e 用：某台打印机云端队列里还积压了多少条（对照 feie.ts 的 queryQueueInfo） */
export function _mockQueueWaiting(sn: string): number {
  return cloudQueue.get(sn)?.length ?? 0
}

/** 仅测试/e2e 用：让该 sn 的下一次（及之后每一次，直到被覆盖/重置）print() 调用先睡 ms 毫秒再返回，
 *  用于把「入队后立即发送」与「定时兜扫」两条路径的时间窗拉大到 e2e 能稳定命中的程度（B6 复现）。 */
export function _setMockPrintDelay(sn: string, ms: number): void {
  if (ms > 0) forcedDelayMs.set(sn, ms)
  else forcedDelayMs.delete(sn)
}

/** 仅测试/e2e 用：把某台打印机标记为固定在线状态（ONLINE/ABNORMAL/OFFLINE/UNKNOWN）。
 *  R7：若该 sn 开了 `_setMockAutoFlushOnRecover`，且这次是从 OFFLINE 切到别的状态，
 *  模拟真机在我们观测到之前就已经把云端队列全部自动吐出——cloudQueue 里堆积的作业搬进 jobs
 *  （视为物理打印完成），不经过 `attemptSend`/`print()` 第二次。 */
export function _setMockPrinterState(sn: string, state: PrinterOnlineState): void {
  const prev = forcedState.get(sn) ?? 'ONLINE'
  forcedState.set(sn, state)
  if (prev === 'OFFLINE' && state !== 'OFFLINE' && autoFlushOnRecoverSns.has(sn)) {
    const q = cloudQueue.get(sn)
    if (q && q.length) {
      for (const item of q) {
        jobs.set(item.id, { id: item.id, sn: item.sn, content: item.content, copies: item.copies, printedAt: Date.now() })
      }
      cloudQueue.delete(sn)
    }
  }
}

/** 仅测试/e2e 用：让下一次对该 sn 的 print() 调用抛出指定分类的错误（一次性，用后清除） */
export function _setMockPrintFailure(sn: string, kind: 'CONFIG' | 'CAPACITY' | 'BUSINESS' | 'TIMEOUT', message = '模拟打印失败'): void {
  forcedPrintError.set(sn, { kind, message })
}

/** 仅测试/e2e 用：读取某台打印机已收到的全部作业（按提交顺序） */
export function _listMockJobs(sn?: string): MockJob[] {
  const all = [...jobs.values()].sort((a, b) => a.printedAt - b.printedAt)
  return sn ? all.filter((j) => j.sn === sn) : all
}

export const mockPrinterProvider: PrinterProvider = {
  name: 'MOCK',

  async print(job: PrintTicketInput): Promise<PrintTicketResult> {
    const delay = forcedDelayMs.get(job.sn)
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay))
    const forced = forcedPrintError.get(job.sn)
    if (forced) {
      forcedPrintError.delete(job.sn)
      throw new PrinterError(forced.kind, 'MOCK_FORCED', forced.message)
    }
    const state = forcedState.get(job.sn) ?? 'ONLINE'
    // D2（H5）：2026-09-05 真机实验确认——打印机离线（网络/电源断开）时 Open_printMsg 仍返回
    // ret=0（成功），票排进飞鹅云端队列，不是失败。ABNORMAL（卡纸/开盖等物理故障）不一样：
    // 那是设备本身打不出来，即使联网正常也真的会失败，沿用旧的 CAPACITY 语义。
    if (state === 'ABNORMAL') throw new PrinterError('CAPACITY', 'MOCK_ABNORMAL', '打印机异常：缺纸或开盖（mock）')
    const id = `MOCK-${Date.now()}-${++seq}`
    if (state === 'OFFLINE') {
      const q = cloudQueue.get(job.sn) ?? []
      q.push({ id, sn: job.sn, content: job.content, copies: job.copies ?? 1, queuedAt: Date.now() })
      cloudQueue.set(job.sn, q)
      return { providerJobId: id }
    }
    jobs.set(id, { id, sn: job.sn, content: job.content, copies: job.copies ?? 1, printedAt: Date.now() })
    return { providerJobId: id }
  },

  async queryStatus(sn: string): Promise<PrinterStatusResult> {
    // R4：跟 print() 共用同一个人为延迟——见 `forcedDelayMs` 的注释，用于复现 handleSendFailure
    // 的 TIMEOUT 分支里紧接着的这次 queryStatus 也会挂住的场景。
    const delay = forcedDelayMs.get(sn)
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay))
    const state = forcedState.get(sn) ?? 'ONLINE'
    return { sn, state, raw: `mock:${state}` }
  },

  async queryJob(providerJobId: string): Promise<QueryJobResult> {
    // 还在云端队列里（cloudQueue，未被 clearQueue 丢弃、也未真机式自动吐出）→ 未打印
    return { printed: jobs.has(providerJobId) }
  },

  async bindPrinter(_input: BindPrinterInput): Promise<void> {
    // mock 无需真实绑定，直接成功
  },

  async queryQueueInfo(sn: string): Promise<PrinterQueueInfo> {
    return { waiting: cloudQueue.get(sn)?.length ?? 0 }
  },

  async clearQueue(sn: string): Promise<void> {
    // 真机语义：清空整个队列，丢弃的票不会再自己吐出来
    cloudQueue.delete(sn)
  },
}
