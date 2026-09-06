/**
 * Mock delivery provider for local development and e2e testing.
 * All operations are manually driven (zero setTimeout) via directive queues.
 * verifyAndParseCallback directly reuses kd100Provider's real signature verification.
 */

import { DeliveryProvider, ProviderError, CreateDeliveryOrderResult, ProviderQuote } from './types'
import { _mapReturnCode, kd100Provider } from './kd100'
import { haversineM, getLocalSettings } from '../local-settings'

/**
 * 未指定 distanceM 的指令下，mock 的默认「道路距离」= 直线 × 1.6。
 *
 * 曾经写死 2600 米。真实道路距离接进报价与下单之后这就不能再写死了——e2e 里那个 40 km 外的
 * 「超范围」点会被 mock 报成 2.6 km 判进配送范围，一条本该发红的断言反而变绿。系数取 1.6
 * 只是为了与兜底的 detourFactor(1.7) 不同，好让「这次用的是实测还是估算」在断言里可区分。
 */
const MOCK_DETOUR = 1.6
function mockDistanceM(input: unknown): number {
  const i = input as { sender?: { latE6?: number; lngE6?: number }; receiver?: { latE6?: number; lngE6?: number } }
  const s = i?.sender, r = i?.receiver
  if (typeof s?.latE6 !== 'number' || typeof s?.lngE6 !== 'number' || typeof r?.latE6 !== 'number' || typeof r?.lngE6 !== 'number') return 2600
  return Math.round(haversineM(s.latE6, s.lngE6, r.latE6, r.lngE6) * MOCK_DETOUR)
}

/**
 * mock 默认报价用的运力编码。**必须是 KD100_PROVIDERS 里的真编码**：
 * 「只呼最低价」的策略引擎会把快照里选出的 provider 原样交给 callRider，而它对未知编码
 * 一律 40001 拒绝（orchestrator.ts 的白名单）。曾经写的 `mocktongcheng` 是个假编码，
 * SOLO 策略上线后会让每一条 mock 链路都在白名单那里断掉。
 */
const MOCK_PROVIDER_CODE = 'dadatongcheng'

export type MockDirective =
  // quotes 只对 price 有意义：让 mock 返回多家不同报价，才测得出「快照里存了几家、各是多少」
  // cancelFeeFen 只对 precancelOrder / cancelOrder 有意义：默认 200（¥2）保持既有 e2e 行为不变，
  // 但「3 分钟无人接自动升级」要求预估取消费为 0 才动手（>0 转 SOLO_HELD 交人工），
  // 所以那条链路必须能把它压成 0——写死 200 的话正常升级路径在 mock 下永远走不到。
  | { kind: 'ok'; taskId?: string; providerOrderId?: string; quotedFeeFen?: number; distanceM?: number; quotes?: ProviderQuote[]; cancelFeeFen?: number }
  | { kind: 'error'; code: '30001' | '30002' | '30003' | '30004' | '30005' | '30006' | '50000' }
  | { kind: 'timeout' }

const queues = new Map<string, MockDirective[]>()
const calls: { op: string; input: unknown; at: string }[] = []
let seq = 0
// 进程启动时间戳做前缀：providerTaskId 在库里有唯一索引，仅靠进程内自增 seq 在热重载/重启后归零，
// 会与仍存活的历史配送单（前一次进程生成的）撞号（P2002）。真实供应商的任务号本就全局唯一，
// mock 也应如此——不影响 e2e 里 `MOCKTASK-*` 前缀断言。
const procTag = Date.now().toString(36)

export function queueDirective(op: 'createOrder' | 'cancelOrder' | 'precancelOrder' | 'addTip' | 'queryCourier' | 'price', d: MockDirective): void {
  if (!queues.has(op)) queues.set(op, [])
  queues.get(op)!.push(d)
}

export function getCalls(): { op: string; input: unknown; at: string }[] {
  return [...calls]
}

export function resetMock(): void {
  queues.clear()
  calls.length = 0
  // seq 故意不重置：providerTaskId 在库里有唯一索引，一次 e2e 运行中会多次 reset
  // （不同订单/场景之间清状态），若 seq 归零会与仍存活的历史配送单撞号（P2002）。
  // 真实供应商的任务号本就不会因为「重置」而复用，这里让 mock 的行为与之一致。
}

function take(op: string): MockDirective {
  return queues.get(op)?.shift() ?? { kind: 'ok' }
}

function record(op: string, input: unknown) {
  calls.push({ op, input, at: new Date().toISOString() })
}

function act(op: string, input: unknown): MockDirective {
  record(op, input)
  const d = take(op)
  if (d.kind === 'error') throw new ProviderError(_mapReturnCode(d.code), d.code, `mock:${d.code}`)
  if (d.kind === 'timeout') throw new ProviderError('TIMEOUT', 'TIMEOUT', 'mock timeout')
  return d
}

export const mockProvider: DeliveryProvider = {
  name: 'MOCK',
  async price(input) {
    const d = act('price', input)
    const distanceM = d.kind === 'ok' && d.distanceM != null ? d.distanceM : mockDistanceM(input)
    const quotes: ProviderQuote[] = d.kind === 'ok' && d.quotes?.length
      ? d.quotes.map((q) => ({ provider: q.provider, feeFen: q.feeFen, distanceM: q.distanceM ?? distanceM }))
      : [{ provider: MOCK_PROVIDER_CODE, feeFen: d.kind === 'ok' && d.quotedFeeFen != null ? d.quotedFeeFen : 500, distanceM }]
    // 与真实 provider 同一口径：feeFen 是这批报价里的最低价，不是随便挑一家
    return { feeFen: Math.min(...quotes.map((q) => q.feeFen)), distanceM, quotes }
  },
  async createOrder(input): Promise<CreateDeliveryOrderResult> {
    const d = act('createOrder', input)
    seq += 1
    const distanceM = d.kind === 'ok' && d.distanceM != null ? d.distanceM : mockDistanceM(input)
    const feeFen = d.kind === 'ok' && d.quotedFeeFen != null ? d.quotedFeeFen : 500
    // 真实 batchOrder 对**被呼的每一家**各返回一条预扣（并呼 N 家就是 N 条，各家金额不同）。
    // mock 照这个形状来：呼几家就回几条，才测得出 orderFees 的条数与 actualFee 的认领。
    // 金额分不出各家高低（mock 没有价目表），统一给 feeFen——断言看的是「哪家在不在里面」。
    //
    // ⚠️ 不传 providers 的兜底必须与 kd100.createOrder 一致 = **设置里的默认列表**，
    // 不是某一个固定编码。写成单个编码时并呼单的 orderFees 只会有一条，
    // 「并呼到底冻结了几笔」这件事在 mock 下就永远测不出来（正是本次要盯的那笔钱）。
    const called = input.providers?.length ? input.providers : (await getLocalSettings()).kd100.providers
    const quotes: ProviderQuote[] = d.kind === 'ok' && d.quotes?.length
      ? d.quotes.map((q) => ({ provider: q.provider, feeFen: q.feeFen, distanceM: q.distanceM ?? distanceM }))
      : called.map((p) => ({ provider: p, feeFen, distanceM }))
    return {
      taskId: (d.kind === 'ok' && d.taskId) || `MOCKTASK-${procTag}-${seq}`,
      providerOrderId: (d.kind === 'ok' && d.providerOrderId) || `MOCKORD-${procTag}-${seq}`,
      quotedFeeFen: feeFen,
      distanceM, quotes,
      raw: { mock: true },
    }
  },
  async precancelOrder(i) {
    const d = act('precancelOrder', i)
    return { cancelFeeFen: d.kind === 'ok' && d.cancelFeeFen != null ? d.cancelFeeFen : 200 }
  },
  async cancelOrder(i) {
    const d = act('cancelOrder', i)
    return { cancelFeeFen: d.kind === 'ok' && d.cancelFeeFen != null ? d.cancelFeeFen : 200, raw: { mock: true } }
  },
  async addTip(i) {
    act('addTip', i)
  },
  async queryCourier(i) {
    act('queryCourier', i)
    return null
  },
  verifyAndParseCallback: kd100Provider.verifyAndParseCallback,
}
