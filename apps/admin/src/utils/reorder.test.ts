import assert from 'node:assert/strict'
import test from 'node:test'
import { moveItem, moveAdjacent } from './reorder.ts'

test('moveItem：前移（from > to）', () => {
  assert.deepEqual(moveItem(['A', 'B', 'C', 'D'], 3, 1), ['A', 'D', 'B', 'C'])
})
test('moveItem：后移（from < to）', () => {
  assert.deepEqual(moveItem(['A', 'B', 'C', 'D'], 0, 2), ['B', 'C', 'A', 'D'])
})
test('moveItem：同位不变，原样返回同一引用', () => {
  const list = ['A', 'B', 'C']
  const next = moveItem(list, 1, 1)
  assert.equal(next, list)
})
test('moveItem：越界不变（from 越界 / to 越界）', () => {
  const list = ['A', 'B', 'C']
  assert.equal(moveItem(list, -1, 1), list)
  assert.equal(moveItem(list, 0, 3), list)
  assert.equal(moveItem(list, 5, 0), list)
})
test('moveItem：不改入参', () => {
  const list = ['A', 'B', 'C', 'D']
  const before = [...list]
  moveItem(list, 0, 3)
  assert.deepEqual(list, before)
})

test('moveAdjacent：首项上移不变，原样返回同一引用', () => {
  const list = ['A', 'B', 'C']
  const next = moveAdjacent(list, 0, -1)
  assert.equal(next, list)
})
test('moveAdjacent：末项下移不变，原样返回同一引用', () => {
  const list = ['A', 'B', 'C']
  const next = moveAdjacent(list, 2, 1)
  assert.equal(next, list)
})
test('moveAdjacent：中间项与上一个交换（dir=-1）', () => {
  assert.deepEqual(moveAdjacent(['A', 'B', 'C'], 1, -1), ['B', 'A', 'C'])
})
test('moveAdjacent：中间项与下一个交换（dir=+1）', () => {
  assert.deepEqual(moveAdjacent(['A', 'B', 'C'], 1, 1), ['A', 'C', 'B'])
})
