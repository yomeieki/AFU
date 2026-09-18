import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readOrderDate, writeOrderDate, orderDateQuery, orderDateError, orderDateSummary } from './order-date-range.ts'
import type { OrderDateState } from './order-date-range.ts'

test('readOrderDate：非法 range 退回 all', () => {
  assert.deepEqual(readOrderDate(new URLSearchParams('range=foo')), { range: 'all', startDate: '', endDate: '' })
})

test('readOrderDate：custom 读 startDate/endDate', () => {
  assert.deepEqual(readOrderDate(new URLSearchParams('range=custom&startDate=2026-09-01&endDate=2026-09-10')), {
    range: 'custom', startDate: '2026-09-01', endDate: '2026-09-10',
  })
})

test('readOrderDate：预设不读 startDate/endDate（即使 URL 里有残留）', () => {
  assert.deepEqual(readOrderDate(new URLSearchParams('range=today&startDate=2020-01-01')), {
    range: 'today', startDate: '', endDate: '',
  })
})

test('writeOrderDate：all 会删掉残留的 startDate/endDate', () => {
  const p = new URLSearchParams('range=custom&startDate=2026-09-01&endDate=2026-09-10')
  writeOrderDate(p, { range: 'all', startDate: '', endDate: '' })
  assert.equal(p.get('range'), null)
  assert.equal(p.get('startDate'), null)
  assert.equal(p.get('endDate'), null)
})

test('writeOrderDate：预设只写 range', () => {
  const p = new URLSearchParams()
  writeOrderDate(p, { range: 'today', startDate: '', endDate: '' })
  assert.equal(p.get('range'), 'today')
  assert.equal(p.get('startDate'), null)
})

test('writeOrderDate：custom 写三键', () => {
  const p = new URLSearchParams()
  writeOrderDate(p, { range: 'custom', startDate: '2026-09-01', endDate: '2026-09-10' })
  assert.equal(p.get('range'), 'custom')
  assert.equal(p.get('startDate'), '2026-09-01')
  assert.equal(p.get('endDate'), '2026-09-10')
})

// 北京 2026-09-19 00:30 = UTC 2026-09-18T16:30:00Z——今日必须是 09-19，不是 09-18（时区坑）
const NOW_BOUNDARY = new Date('2026-09-18T16:30:00Z')

test('orderDateQuery：today 在北京 00:30 时给的是「新的一天」而不是 UTC 当天', () => {
  assert.deepEqual(orderDateQuery({ range: 'today', startDate: '', endDate: '' }, NOW_BOUNDARY), {
    startDate: '2026-09-19', endDate: '2026-09-19',
  })
})

test('orderDateQuery：custom 缺一端 → {}，orderDateError 非空', () => {
  const s: OrderDateState = { range: 'custom', startDate: '2026-09-01', endDate: '' }
  assert.deepEqual(orderDateQuery(s, NOW_BOUNDARY), {})
  assert.equal(orderDateError(s), '请选完整的起止日期')
})

test('orderDateQuery：custom 止早于起 → {}，orderDateError 给出对应文案', () => {
  const s: OrderDateState = { range: 'custom', startDate: '2026-09-10', endDate: '2026-09-01' }
  assert.deepEqual(orderDateQuery(s, NOW_BOUNDARY), {})
  assert.equal(orderDateError(s), '结束日期早于开始日期')
})

test('orderDateQuery：custom 跨 200 天不报错', () => {
  const s: OrderDateState = { range: 'custom', startDate: '2026-01-01', endDate: '2026-09-01' }
  assert.equal(orderDateError(s), null)
  assert.deepEqual(orderDateQuery(s, NOW_BOUNDARY), { startDate: '2026-01-01', endDate: '2026-09-01' })
})

test('orderDateQuery：all → {}', () => {
  assert.deepEqual(orderDateQuery({ range: 'all', startDate: '', endDate: '' }, NOW_BOUNDARY), {})
})

test('orderDateQuery：7d/30d 以 now 为终点向前推', () => {
  assert.deepEqual(orderDateQuery({ range: '7d', startDate: '', endDate: '' }, NOW_BOUNDARY), {
    startDate: '2026-09-13', endDate: '2026-09-19',
  })
  assert.deepEqual(orderDateQuery({ range: '30d', startDate: '', endDate: '' }, NOW_BOUNDARY), {
    startDate: '2026-08-21', endDate: '2026-09-19',
  })
})

test('orderDateSummary：预设文案', () => {
  assert.equal(orderDateSummary({ range: 'all', startDate: '', endDate: '' }, NOW_BOUNDARY), '')
  assert.equal(orderDateSummary({ range: 'today', startDate: '', endDate: '' }, NOW_BOUNDARY), '今日')
  assert.equal(orderDateSummary({ range: '7d', startDate: '', endDate: '' }, NOW_BOUNDARY), '近7天')
})

test('orderDateSummary：custom 单日只给一个日期，跨日给区间', () => {
  assert.equal(orderDateSummary({ range: 'custom', startDate: '2026-09-10', endDate: '2026-09-10' }, NOW_BOUNDARY), '9月10日')
  assert.equal(orderDateSummary({ range: 'custom', startDate: '2026-09-01', endDate: '2026-09-10' }, NOW_BOUNDARY), '9月1日 – 9月10日')
})
