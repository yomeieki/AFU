import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fmtYuanGrouped } from './money.ts'

test('fmtYuanGrouped：0 → ¥0.00', () => {
  assert.equal(fmtYuanGrouped(0), '¥0.00')
})

test('fmtYuanGrouped：千分位分组', () => {
  assert.equal(fmtYuanGrouped(108640), '¥1,086.40')
})

test('fmtYuanGrouped：百万级两次分组', () => {
  assert.equal(fmtYuanGrouped(123456789), '¥1,234,567.89')
})

test('fmtYuanGrouped：不足一元', () => {
  assert.equal(fmtYuanGrouped(5), '¥0.05')
})

test('fmtYuanGrouped：负数前缀在 ¥ 之前', () => {
  assert.equal(fmtYuanGrouped(-5), '-¥0.05')
})
