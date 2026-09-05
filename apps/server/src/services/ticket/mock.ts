/**
 * 打印机 mock provider：本地开发与 e2e 用（PRINTER_PROVIDER_MOCK=true，生产禁止开启，见 config.ts）。
 * 不打真实飞鹅接口，落一份进程内队列，供 e2e 断言「已打印」「查询状态」等行为，形状与 feie.ts 对齐。
 *
 * 可选择性注入异常（参考 services/delivery/mock.ts 的做法）：调用方在 e2e 里可以把某个 sn 标记为
 * OFFLINE/FAIL，验证 services/ticket/index.ts 的失败分支与告警路径，而不用真的接一台硬件。
 */
import {
  PrinterProvider, PrintTicketInput, PrintTicketResult, PrinterStatusResult, QueryJobResult,
  BindPrinterInput, PrinterError, PrinterOnlineState,
} from './printer'

interface MockJob { id: string; sn: string; content: string; copies: number; printedAt: number }

const jobs = new Map<string, MockJob>()
/** e2e 可写：sn → 强制在线状态 或 强制下一次 print 抛出的错误 */
const forcedState = new Map<string, PrinterOnlineState>()
const forcedPrintError = new Map<string, { kind: 'CONFIG' | 'CAPACITY' | 'BUSINESS' | 'TIMEOUT'; message: string }>()
/** e2e 可写：sn → print() 人为延迟毫秒数，用于复现「立即发送」与「定时兜扫」的无锁竞争（B6） */
const forcedDelayMs = new Map<string, number>()
let seq = 0

/** 仅测试/e2e 用：清空 mock 内部状态，避免跨用例串味 */
export function _resetMockPrinter(): void {
  jobs.clear()
  forcedState.clear()
  forcedPrintError.clear()
  forcedDelayMs.clear()
  seq = 0
}

/** 仅测试/e2e 用：让该 sn 的下一次（及之后每一次，直到被覆盖/重置）print() 调用先睡 ms 毫秒再返回，
 *  用于把「入队后立即发送」与「定时兜扫」两条路径的时间窗拉大到 e2e 能稳定命中的程度（B6 复现）。 */
export function _setMockPrintDelay(sn: string, ms: number): void {
  if (ms > 0) forcedDelayMs.set(sn, ms)
  else forcedDelayMs.delete(sn)
}

/** 仅测试/e2e 用：把某台打印机标记为固定在线状态（ONLINE/ABNORMAL/OFFLINE/UNKNOWN） */
export function _setMockPrinterState(sn: string, state: PrinterOnlineState): void {
  forcedState.set(sn, state)
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
    const state = forcedState.get(job.sn)
    if (state === 'OFFLINE') throw new PrinterError('CAPACITY', 'MOCK_OFFLINE', '打印机离线（mock）')
    const id = `MOCK-${Date.now()}-${++seq}`
    jobs.set(id, { id, sn: job.sn, content: job.content, copies: job.copies ?? 1, printedAt: Date.now() })
    return { providerJobId: id }
  },

  async queryStatus(sn: string): Promise<PrinterStatusResult> {
    const state = forcedState.get(sn) ?? 'ONLINE'
    return { sn, state, raw: `mock:${state}` }
  },

  async queryJob(providerJobId: string): Promise<QueryJobResult> {
    return { printed: jobs.has(providerJobId) }
  },

  async bindPrinter(_input: BindPrinterInput): Promise<void> {
    // mock 无需真实绑定，直接成功
  },
}
