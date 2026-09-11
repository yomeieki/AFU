import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pickupCountdown, isFutureDayPickup, pickupUrgency, pickupPendingAnchor } from './pickup.ts'

// 2026-09-11 12:00 Asia/Shanghai = 04:00Z
const NOON = Date.parse('2026-09-11T04:00:00Z')
const min = (n: number) => n * 60_000

test('pickupCountdown：未到点显示「距取餐 N 分」，向上取整', () => {
  assert.deepEqual(pickupCountdown(new Date(NOON + min(25)).toISOString(), NOON), { text: '距取餐 25 分', overdueMin: 0 })
  assert.deepEqual(pickupCountdown(new Date(NOON + min(0.4)).toISOString(), NOON), { text: '距取餐 1 分', overdueMin: 0 })
})

test('pickupCountdown：过点显示「已过取餐时间 N 分钟」，向下取整', () => {
  assert.deepEqual(pickupCountdown(new Date(NOON - min(40.9)).toISOString(), NOON), { text: '已过取餐时间 40 分钟', overdueMin: 40 })
  assert.deepEqual(pickupCountdown(new Date(NOON).toISOString(), NOON), { text: '已过取餐时间 0 分钟', overdueMin: 0 })
})

test('isFutureDayPickup：按上海日历日比较，不按 24 小时', () => {
  // 今天 23:30 取 → 不是明日
  assert.equal(isFutureDayPickup('2026-09-11T15:30:00Z', NOON), false)
  // 明天 00:30 取 → 明日（上海 2026-09-12）
  assert.equal(isFutureDayPickup('2026-09-11T16:30:00Z', NOON), true)
  assert.equal(isFutureDayPickup(null, NOON), false)
})

test('pickupUrgency：备餐中看离取餐还剩多久；待取餐过点转琥珀；明日单永不点亮', () => {
  const p = (pickupAt: number, prepStartAt = pickupAt - min(25)) => ({
    pickupAt: new Date(pickupAt).toISOString(), prepStartAt: new Date(prepStartAt).toISOString(),
  })
  assert.equal(pickupUrgency('preparing', p(NOON + min(30)), NOON), '')
  assert.equal(pickupUrgency('preparing', p(NOON + min(15)), NOON), 'warn')
  assert.equal(pickupUrgency('preparing', p(NOON + min(5)), NOON), 'late')
  assert.equal(pickupUrgency('preparing', p(NOON - min(1)), NOON), 'late')
  assert.equal(pickupUrgency('delivering', p(NOON + min(5)), NOON), '')
  assert.equal(pickupUrgency('delivering', p(NOON - min(1)), NOON), 'warn')
  assert.equal(pickupUrgency('pending', p(NOON + min(5)), NOON), '')
  assert.equal(pickupUrgency('done', p(NOON - min(60)), NOON), '')
  // 明天的单：哪一列都不点亮
  assert.equal(pickupUrgency('preparing', p(NOON + min(24 * 60)), NOON), '')
})

test('pickupPendingAnchor：待接单计时从 max(付款, 开始备餐−15分) 起算', () => {
  const paid = new Date(NOON - min(10)).toISOString()
  // 开始备餐在 2 小时后 → 锚点 = 开始备餐−15 分（还在未来）
  assert.equal(pickupPendingAnchor(paid, new Date(NOON + min(120)).toISOString()), NOON + min(105))
  // 开始备餐 5 分钟前 → 锚点 = 付款时刻
  assert.equal(pickupPendingAnchor(paid, new Date(NOON - min(5)).toISOString()), NOON - min(10))
  // 没有 prepStartAt → 付款时刻
  assert.equal(pickupPendingAnchor(paid, null), NOON - min(10))
})
