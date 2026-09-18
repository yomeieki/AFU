import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fmtListTime } from './time.ts'

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
