// 到店自取「尽快取」后台纯函数（plans/2026-09-28-pickup-asap.md 测试用例 C 组的纯函数部分）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isFutureDayPickup, pickupUrgency, pickupPendingAnchor, pickupDetailLine } from './pickup.ts'
import { deliveryColumn, type OrderListRow } from './order-list.ts'

// 2026-09-28 11:22 Asia/Shanghai = 03:22Z
const NOW = Date.parse('2026-09-28T03:22:00Z')
const min = (n: number) => n * 60_000
const at = (ms: number) => new Date(ms).toISOString()

test('C1 deliveryColumn：尽快单第一行「尽快取 约 HH:mm」，预约单仍是「取餐 HH:mm」', () => {
  const row: OrderListRow = { deliveryType: 'PICKUP', status: 'PREPARING', pickupAt: '2026-09-28T03:40:00Z', pickupReadyAt: null, completedAt: null, shipment: null, latestDelivery: null }
  assert.deepEqual(deliveryColumn({ ...row, pickupAsap: true }, new Date(NOW)), ['尽快取 约 11:40', ''])
  assert.deepEqual(deliveryColumn({ ...row, pickupAsap: false }, new Date(NOW)), ['取餐 11:40', ''])
  // 老接口没有 pickupAsap 字段 → 与改前一致
  assert.deepEqual(deliveryColumn(row, new Date(NOW)), ['取餐 11:40', ''])
  // 第二行规则不变：已备好 / 已取走
  assert.deepEqual(deliveryColumn({ ...row, pickupAsap: true, status: 'SHIPPED', pickupReadyAt: '2026-09-28T03:35:00Z' }, new Date(NOW)), ['尽快取 约 11:40', '已备好'])
  assert.deepEqual(deliveryColumn({ ...row, pickupAsap: true, status: 'COMPLETED', completedAt: '2026-09-28T03:45:00Z' }, new Date(NOW)), ['尽快取 约 11:40', '已取走'])
})

test('C2 待接单：尽快单从付款时刻开始计等待（服务端给的 prepStartAt 也是付款时刻），预约单口径不变', () => {
  const paid = at(NOW - min(2))
  // 尽快单：不管 prepStartAt 给什么，锚点都是付款时刻
  assert.equal(pickupPendingAnchor(paid, paid, true), NOW - min(2))
  assert.equal(pickupPendingAnchor(paid, at(NOW + min(120)), true), NOW - min(2))
  assert.equal(pickupPendingAnchor(paid, null, true), NOW - min(2))
  // 预约单：仍是 max(付款, 开始备餐 − 15 分)
  assert.equal(pickupPendingAnchor(paid, at(NOW + min(120))), NOW + min(105))
  assert.equal(pickupPendingAnchor(paid, at(NOW + min(120)), false), NOW + min(105))
})

test('C2 紧急度：尽快单备餐中沿用「距取餐 ≤15 琥珀、≤5 红」；跨零点的尽快单不当「明日单」', () => {
  const p = (pickupAt: number) => ({ pickupAt: at(pickupAt), prepStartAt: at(NOW - min(2)), asap: true })
  assert.equal(pickupUrgency('preparing', p(NOW + min(30)), NOW), '')
  assert.equal(pickupUrgency('preparing', p(NOW + min(15)), NOW), 'warn')
  assert.equal(pickupUrgency('preparing', p(NOW + min(5)), NOW), 'late')
  assert.equal(pickupUrgency('delivering', p(NOW - min(1)), NOW), 'warn')
  assert.equal(pickupUrgency('pending', p(NOW + min(5)), NOW), '')
  // 23:50 上海（15:50Z）时，次日 00:04（16:04Z）可取的尽快单：
  const late = Date.parse('2026-09-28T15:50:00Z')
  const nextDay = '2026-09-28T16:04:00Z'
  assert.equal(isFutureDayPickup(nextDay, late, true), false)
  assert.equal(isFutureDayPickup(nextDay, late), true, '预约单照旧算明日单')
  assert.equal(pickupUrgency('preparing', { pickupAt: nextDay, prepStartAt: at(late), asap: true }, late - min(5)), '', '19 分钟后可取：还没到琥珀线')
  assert.equal(pickupUrgency('preparing', { pickupAt: nextDay, prepStartAt: at(late), asap: true }, late), 'warn', '14 分钟后可取：琥珀（不因跨日被压成不点亮）')
  assert.equal(pickupUrgency('preparing', { pickupAt: nextDay, prepStartAt: at(late), asap: true }, late + min(10)), 'late')
  assert.equal(pickupUrgency('preparing', { pickupAt: nextDay, prepStartAt: at(late) }, late), '', '同一时刻的预约单跨日照旧不点亮')
})

test('C3 后台订单详情：尽快单「尽快取 · 预计 HH:mm」，不出「预约取餐」；预约单照旧', () => {
  assert.equal(pickupDetailLine({ pickupAt: '2026-09-28T03:40:00Z', pickupAsap: true }), '尽快取 · 预计 11:40')
  assert.equal(pickupDetailLine({ pickupAt: '2026-09-28T04:00:00Z', pickupAsap: false }).startsWith('预约取餐 '), true)
  assert.equal(pickupDetailLine({ pickupAt: '2026-09-28T04:00:00Z' }).startsWith('预约取餐 '), true)
  assert.ok(!pickupDetailLine({ pickupAt: '2026-09-28T03:40:00Z', pickupAsap: true }).includes('预约'))
  assert.equal(pickupDetailLine({ pickupAt: null, pickupAsap: true }), '')
})
