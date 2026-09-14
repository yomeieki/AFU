// 餐具选择的纯函数锁（2026-09-14 餐具设计）。文案与服务端 services/tableware.ts 的
// tablewareLabel 逐字一致，normalizeTableware/stepCount 只在这一层测。
const test = require('node:test')
const assert = require('node:assert/strict')

const { tablewareLabel, normalizeTableware, stepCount } = require('../../apps/miniapp/utils/tableware')

test('tablewareLabel：四例与服务端同一组输出', function () {
  assert.equal(tablewareLabel('NONE'), '无需餐具')
  assert.equal(tablewareLabel('BY_MEAL'), '需要餐具 · 按餐量')
  assert.equal(tablewareLabel('COUNT', 3), '需要餐具 · 3 份')
  assert.equal(tablewareLabel(null, null), '')
})

test('normalizeTableware：不合法一律 null，按「没选」处理', function () {
  assert.deepEqual(normalizeTableware({ mode: 'NONE' }), { mode: 'NONE' })
  // BY_MEAL 带多余 count：丢掉
  assert.deepEqual(normalizeTableware({ mode: 'BY_MEAL', count: 3 }), { mode: 'BY_MEAL' })
  assert.deepEqual(normalizeTableware({ mode: 'COUNT', count: 3 }), { mode: 'COUNT', count: 3 })
  assert.equal(normalizeTableware({ mode: 'COUNT', count: 0 }), null)
  assert.equal(normalizeTableware({ mode: 'COUNT', count: 11 }), null)
  assert.equal(normalizeTableware({ mode: 'COUNT', count: '3' }), null)
  assert.equal(normalizeTableware({ mode: 'COUNT' }), null)
  assert.equal(normalizeTableware(null), null)
  assert.equal(normalizeTableware({ mode: 'XX' }), null)
})

test('stepCount：边界钳制在 1–10，缺失当 1 处理', function () {
  assert.equal(stepCount(1, -1), 1)
  assert.equal(stepCount(10, 1), 10)
  assert.equal(stepCount(3, 1), 4)
  assert.equal(stepCount(undefined, 1), 2)
})
