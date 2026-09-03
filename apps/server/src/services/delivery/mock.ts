/**
 * Mock delivery provider for local development and e2e testing.
 * All operations are manually driven (zero setTimeout) via directive queues.
 * verifyAndParseCallback directly reuses kd100Provider's real signature verification.
 */

import { DeliveryProvider, ProviderError, CreateDeliveryOrderResult } from './types'
import { _mapReturnCode, kd100Provider } from './kd100'

export type MockDirective =
  | { kind: 'ok'; taskId?: string; providerOrderId?: string; quotedFeeFen?: number; distanceM?: number }
  | { kind: 'error'; code: '30001' | '30002' | '30003' | '30004' | '30005' | '30006' }
  | { kind: 'timeout' }

const queues = new Map<string, MockDirective[]>()
const calls: { op: string; input: unknown; at: string }[] = []
let seq = 0

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
  seq = 0
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
    return {
      feeFen: d.kind === 'ok' && d.quotedFeeFen != null ? d.quotedFeeFen : 500,
      distanceM: d.kind === 'ok' && d.distanceM != null ? d.distanceM : 2600,
    }
  },
  async createOrder(input): Promise<CreateDeliveryOrderResult> {
    const d = act('createOrder', input)
    seq += 1
    return {
      taskId: (d.kind === 'ok' && d.taskId) || `MOCKTASK-${seq}`,
      providerOrderId: (d.kind === 'ok' && d.providerOrderId) || `MOCKORD-${seq}`,
      quotedFeeFen: d.kind === 'ok' && d.quotedFeeFen != null ? d.quotedFeeFen : 500,
      distanceM: d.kind === 'ok' && d.distanceM != null ? d.distanceM : 2600,
      raw: { mock: true },
    }
  },
  async precancelOrder(i) {
    act('precancelOrder', i)
    return { cancelFeeFen: 200 }
  },
  async cancelOrder(i) {
    act('cancelOrder', i)
    return { cancelFeeFen: 200, raw: { mock: true } }
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
