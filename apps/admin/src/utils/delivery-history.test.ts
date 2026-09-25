import { test } from 'node:test'
import assert from 'node:assert/strict'
import { callStrategyLabelWithEscalation, historyEventRows, isSelfDelivery } from './delivery-history.ts'
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

// 复核 R3：DetailDelivery.tsx 的新分支只渲染了 row.text，丢了 BASE 原有的「（骑手名）」与
// 「 · 操作人」——historyEventRows 必须原样透传这两个字段，由 DetailDelivery 自己拼回去。
test('historyEventRows：原样透传 courierName/operator，缺省时为 null', () => {
  const history = {
    deliveries: [{ deliveryNo: 'D34-1' }],
    events: [
      { id: 1, createdAt: '2026-09-26T10:00:00Z', deliveryNo: 'D34-1', statusDesc: '骑手已接单', courierName: '王骑手', operator: '张三' },
      { id: 2, createdAt: '2026-09-26T10:01:00Z', deliveryNo: 'D34-1', statusDesc: '已送达' },
    ],
  }
  const rows = historyEventRows(history)
  assert.equal(rows[0].courierName, '王骑手')
  assert.equal(rows[0].operator, '张三')
  assert.equal(rows[1].courierName, null)
  assert.equal(rows[1].operator, null)
})

// 复核 R4：SELF（店内自送）没有运力概念，callStrategy 恒 null——「呼叫方式」行与时间线
// 「呼叫骑手」节点都不该出现在它身上（会显示词不达意的「并呼（旧）」）。
test('isSelfDelivery：按 provider 判定', () => {
  assert.equal(isSelfDelivery({ provider: 'SELF' }), true)
  assert.equal(isSelfDelivery({ provider: 'KD100' }), false)
  assert.equal(isSelfDelivery({ provider: null }), false)
  assert.equal(isSelfDelivery({}), false)
})
