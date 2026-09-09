import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeWeightKg, WEIGHT_MIN_KG, WEIGHT_MAX_KG } from './weight.ts'

test('normalizeWeightKg：四舍五入到 0.1', () => {
  assert.equal(normalizeWeightKg('1.14'), 1.1)
  assert.equal(normalizeWeightKg('1.15'), 1.2)
  assert.equal(normalizeWeightKg(' 3.5 '), 3.5)
  assert.equal(normalizeWeightKg('50'), 50)
})
test('normalizeWeightKg：空、非数、越界都是 null', () => {
  assert.equal(normalizeWeightKg(''), null)
  assert.equal(normalizeWeightKg('abc'), null)
  assert.equal(normalizeWeightKg('0.04'), null)   // 四舍五入后 0.0 < 0.1
  assert.equal(normalizeWeightKg('50.01'), 50)     // 四舍五入后 50.0，仍在上限内
  assert.equal(normalizeWeightKg('50.06'), null)
  assert.equal(normalizeWeightKg('-1'), null)
  assert.equal(WEIGHT_MIN_KG, 0.1); assert.equal(WEIGHT_MAX_KG, 50)
})
