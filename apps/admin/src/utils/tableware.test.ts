import assert from 'node:assert/strict'
import test from 'node:test'
import { tablewareLabel } from './tableware.ts'

test('tablewareLabel：NONE 无需餐具', () => {
  assert.equal(tablewareLabel('NONE', null), '无需餐具')
})
test('tablewareLabel：BY_MEAL 需要餐具 · 按餐量', () => {
  assert.equal(tablewareLabel('BY_MEAL', null), '需要餐具 · 按餐量')
})
test('tablewareLabel：COUNT 需要餐具 · N 份', () => {
  assert.equal(tablewareLabel('COUNT', 3), '需要餐具 · 3 份')
})
test('tablewareLabel：null/undefined 不显示', () => {
  assert.equal(tablewareLabel(null, null), '')
  assert.equal(tablewareLabel(undefined, undefined), '')
})
