import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readUsersQuery, writeUsersQuery } from './users-query.ts'

test('readUsersQuery：空参数 → 全部默认值', () => {
  assert.deepEqual(readUsersQuery(new URLSearchParams('')), {
    kw: '', hasOrders: true, page: 1, sort: 'created', ordersUserId: null,
  })
})

test('readUsersQuery：hasOrders=0 → false', () => {
  assert.equal(readUsersQuery(new URLSearchParams('hasOrders=0')).hasOrders, false)
})

test('readUsersQuery：hasOrders=1 → true', () => {
  assert.equal(readUsersQuery(new URLSearchParams('hasOrders=1')).hasOrders, true)
})

test('readUsersQuery：hasOrders 缺省 → true', () => {
  assert.equal(readUsersQuery(new URLSearchParams('')).hasOrders, true)
})

test('readUsersQuery：page 非法值（abc/0/-2）→ 1', () => {
  assert.equal(readUsersQuery(new URLSearchParams('page=abc')).page, 1)
  assert.equal(readUsersQuery(new URLSearchParams('page=0')).page, 1)
  assert.equal(readUsersQuery(new URLSearchParams('page=-2')).page, 1)
})

test('readUsersQuery：page=3 → 3', () => {
  assert.equal(readUsersQuery(new URLSearchParams('page=3')).page, 3)
})

test('readUsersQuery：sort=spend → spend', () => {
  assert.equal(readUsersQuery(new URLSearchParams('sort=spend')).sort, 'spend')
})

test('readUsersQuery：sort=xyz 或缺省 → created', () => {
  assert.equal(readUsersQuery(new URLSearchParams('sort=xyz')).sort, 'created')
  assert.equal(readUsersQuery(new URLSearchParams('')).sort, 'created')
})

test('readUsersQuery：orders=12 → 12', () => {
  assert.equal(readUsersQuery(new URLSearchParams('orders=12')).ordersUserId, 12)
})

test('readUsersQuery：orders=0/orders=x/缺省 → null', () => {
  assert.equal(readUsersQuery(new URLSearchParams('orders=0')).ordersUserId, null)
  assert.equal(readUsersQuery(new URLSearchParams('orders=x')).ordersUserId, null)
  assert.equal(readUsersQuery(new URLSearchParams('')).ordersUserId, null)
})

test('readUsersQuery：kw 去首尾空白', () => {
  assert.equal(readUsersQuery(new URLSearchParams('kw=' + encodeURIComponent('  张三  '))).kw, '张三')
})

test('writeUsersQuery：默认值不落 URL', () => {
  const next = writeUsersQuery(new URLSearchParams(''), {
    kw: '', hasOrders: true, page: 1, sort: 'created', ordersUserId: null,
  })
  assert.equal(next.toString(), '')
})

test('writeUsersQuery：非默认值落键', () => {
  const next = writeUsersQuery(new URLSearchParams(''), {
    kw: '138', hasOrders: false, page: 2, sort: 'spend', ordersUserId: 7,
  })
  assert.equal(next.get('kw'), '138')
  assert.equal(next.get('hasOrders'), '0')
  assert.equal(next.get('page'), '2')
  assert.equal(next.get('sort'), 'spend')
  assert.equal(next.get('orders'), '7')
})

test('writeUsersQuery：只 patch 一个字段时其余保留当前值，恢复默认后自动删键', () => {
  let params = writeUsersQuery(new URLSearchParams(''), { kw: '138', page: 2 })
  assert.equal(params.get('kw'), '138')
  assert.equal(params.get('page'), '2')
  // 恢复 kw 默认值：kw 键消失，page 不受影响
  params = writeUsersQuery(params, { kw: '' })
  assert.equal(params.has('kw'), false)
  assert.equal(params.get('page'), '2')
})

test('writeUsersQuery：不认识的既有键原样保留', () => {
  const next = writeUsersQuery(new URLSearchParams('foo=bar'), { page: 2 })
  assert.equal(next.get('foo'), 'bar')
  assert.equal(next.get('page'), '2')
})
