import { test } from 'node:test'
import assert from 'node:assert/strict'
import { callStrategyLabelWithEscalation, historyEventRows } from './delivery-history.ts'
import { callStrategyLabel } from './providers.ts'

test('callStrategyLabelWithEscalation：escalatedFrom 非空时追加自动升级说明', () => {
  const d = {
    callStrategy: 'CHEAPEST', calledProviders: ['dadatongcheng', 'fengniaotongcheng', 'uupaotui'],
    escalatedFrom: { fromDeliveryNo: 'D34-1', providersLabel: '达达', minutes: '3' },
  }
  assert.equal(
    callStrategyLabelWithEscalation(d),
    '并呼最便宜 3 家（达达、蜂鸟、UU跑腿）（只呼达达 3 分钟无人接，自动升级）',
  )
})

test('callStrategyLabelWithEscalation：escalatedFrom 为 null 时与 callStrategyLabel 逐字相同', () => {
  const d = { callStrategy: 'SOLO', calledProviders: ['dadatongcheng'], courierCompany: null, escalatedFrom: null }
  assert.equal(callStrategyLabelWithEscalation(d), callStrategyLabel(d.callStrategy, d.calledProviders, d.courierCompany))
})

test('historyEventRows：两张单的事件按 deliveryNo 打标签、按时间升序，同刻按 id 升序', () => {
  const history = {
    deliveries: [{ deliveryNo: 'D34-1' }, { deliveryNo: 'D34-2' }],
    events: [
      { id: 3, createdAt: '2026-09-26T10:03:00Z', deliveryNo: 'D34-2', statusDesc: '并呼最便宜 3 家' },
      { id: 1, createdAt: '2026-09-26T10:00:00Z', deliveryNo: 'D34-1', statusDesc: '只呼达达' },
      { id: 2, createdAt: '2026-09-26T10:03:00Z', deliveryNo: 'D34-1', statusDesc: '达达 3 分钟无人接，已自动取消' },
    ],
  }
  const rows = historyEventRows(history)
  assert.deepEqual(rows.map((r) => r.id), [1, 2, 3])
  assert.deepEqual(rows.map((r) => r.tag), ['D34-1', 'D34-1', 'D34-2'])
})

test('historyEventRows：只有一张单时 tag 恒为 null', () => {
  const history = {
    deliveries: [{ deliveryNo: 'D34-1' }],
    events: [{ id: 1, createdAt: '2026-09-26T10:00:00Z', deliveryNo: 'D34-1', statusDesc: '只呼达达' }],
  }
  const rows = historyEventRows(history)
  assert.equal(rows[0].tag, null)
})

test('historyEventRows：text 优先 displayDesc，其次 statusDesc，最后 source', () => {
  const history = {
    deliveries: [{ deliveryNo: 'D34-1' }, { deliveryNo: 'D34-2' }],
    events: [
      { id: 1, createdAt: '2026-09-26T10:00:00Z', deliveryNo: 'D34-1', displayDesc: '改写后文案', statusDesc: '原文案', source: 'ADMIN' },
      { id: 2, createdAt: '2026-09-26T10:01:00Z', deliveryNo: 'D34-1', displayDesc: null, statusDesc: '原文案2', source: 'ADMIN' },
      { id: 3, createdAt: '2026-09-26T10:02:00Z', deliveryNo: 'D34-1', displayDesc: null, statusDesc: null, source: 'CALLBACK' },
    ],
  }
  const rows = historyEventRows(history)
  assert.equal(rows[0].text, '改写后文案')
  assert.equal(rows[1].text, '原文案2')
  assert.equal(rows[2].text, 'CALLBACK')
})
