import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fmtListTime, sameDayKey } from './time.ts'

// 2026-09-18 12:00 Asia/Shanghai = 2026-09-18T04:00:00Z
const NOW = new Date('2026-09-18T04:00:00Z')

test('fmtListTime：上海今天 → 今天 HH:mm', () => {
  assert.equal(fmtListTime('2026-09-18T02:42:00Z', NOW), '今天 10:42')
})

test('fmtListTime：上海昨天 → 昨天 HH:mm', () => {
  assert.equal(fmtListTime('2026-09-17T10:30:00Z', NOW), '昨天 18:30')
})

test('fmtListTime：同年非今昨 → M月D日 HH:mm', () => {
  assert.equal(fmtListTime('2026-09-10T04:15:00Z', NOW), '9月10日 12:15')
})

test('fmtListTime：跨年 → YYYY-MM-DD HH:mm', () => {
  assert.equal(fmtListTime('2024-06-15T04:00:00Z', NOW), '2024-06-15 12:00')
})

test('fmtListTime：空值 → --', () => {
  assert.equal(fmtListTime(null, NOW), '--')
  assert.equal(fmtListTime(undefined, NOW), '--')
})

test('sameDayKey：UTC 同日但上海跨日（北京 23:30 vs 次日 00:30）→ false', () => {
  assert.equal(sameDayKey('2026-09-17T15:30:00Z', '2026-09-17T16:30:00Z'), false)
})

test('sameDayKey：UTC 跨日但上海同日（北京 07:30 vs 09:00）→ true', () => {
  assert.equal(sameDayKey('2026-09-17T23:30:00Z', '2026-09-18T01:00:00Z'), true)
})

test('sameDayKey：任一端为空/非法 → false', () => {
  assert.equal(sameDayKey(null, '2026-09-18T01:00:00Z'), false)
  assert.equal(sameDayKey('2026-09-18T01:00:00Z', undefined), false)
  assert.equal(sameDayKey('not-a-date', '2026-09-18T01:00:00Z'), false)
})
