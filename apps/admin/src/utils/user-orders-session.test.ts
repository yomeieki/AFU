import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  initialSession, openSession, closeSession, applyUserLoaded, applyOrdersPage, beginMore, applyOrdersError,
} from './user-orders-session.ts'

type U = { id: number; name: string }
type O = { id: number }

const A: U = { id: 1, name: 'A' }
const B: U = { id: 2, name: 'B' }

test('a）加载更多晚到：关闭再开 B 之后，A 的「加载更多」响应必须被丢弃（同一引用）', () => {
  let s = initialSession<U, O>()
  s = openSession(s, 1, A)
  s = applyOrdersPage(s, { seq: 1, page: 1, list: Array.from({ length: 20 }, (_, i) => ({ id: i + 1 })), total: 25 })
  s = closeSession(s, 2)
  s = openSession(s, 3, B)
  s = applyOrdersPage(s, { seq: 3, page: 1, list: [{ id: 101 }], total: 1 })
  const before = s
  const after = applyOrdersPage(s, { seq: 1, page: 2, list: Array.from({ length: 5 }, (_, i) => ({ id: i + 21 })), total: 25 })
  assert.equal(after, before) // 同一引用 = 被丢弃
  assert.deepEqual(after.list, [{ id: 101 }])
  assert.equal(after.total, 1)
})

test('b）getUser 晚到：按 URL 重开 7 的响应，在点了 B 的按钮之后到达，必须被丢弃', () => {
  let s = initialSession<U, O>()
  s = openSession(s, 1, null) // 按 URL 重开，user 还没回来
  s = openSession(s, 2, B) // 这期间点了 B 的按钮
  const before = s
  const after = applyUserLoaded(s, { seq: 1, user: A })
  assert.equal(after, before)
  assert.equal(after.user, B)
})

test('c）首页晚到（BASE 既有场景）：A 的首页响应在切到 B 之后才到，必须被丢弃', () => {
  let s = initialSession<U, O>()
  s = openSession(s, 1, A)
  s = openSession(s, 2, B)
  const discarded = applyOrdersPage(s, { seq: 1, page: 1, list: [{ id: 1 }], total: 1 })
  assert.equal(discarded, s)
  const applied = applyOrdersPage(s, { seq: 2, page: 1, list: [{ id: 2 }], total: 1 })
  assert.notEqual(applied, s)
  assert.deepEqual(applied.list, [{ id: 2 }])
})

test('d）关闭后晚到：A 的响应在关闭弹窗之后才到，必须被丢弃', () => {
  let s = initialSession<U, O>()
  s = openSession(s, 1, A)
  s = closeSession(s, 2)
  const before = s
  const after = applyOrdersPage(s, { seq: 1, page: 1, list: [{ id: 1 }], total: 1 })
  assert.equal(after, before)
  assert.equal(after.user, null)
  assert.deepEqual(after.list, [])
})

test('e）追加去重：重复 id 只保留一次，顺序不变，page 以响应为准', () => {
  let s = initialSession<U, O>()
  s = openSession(s, 1, A)
  s = applyOrdersPage(s, { seq: 1, page: 1, list: [{ id: 1 }, { id: 2 }, { id: 3 }], total: 5 })
  s = applyOrdersPage(s, { seq: 1, page: 2, list: [{ id: 3 }, { id: 4 }, { id: 5 }], total: 5 })
  assert.deepEqual(s.list.map((o) => o.id), [1, 2, 3, 4, 5])
  assert.equal(s.page, 2)
})

test('f）错误：page=1 失败置 failed=true；seq 不符的错误响应被丢弃（同一引用）', () => {
  let s = initialSession<U, O>()
  s = openSession(s, 1, A)
  s = applyOrdersError(s, { seq: 1, page: 1 })
  assert.equal(s.failed, true)
  const before = s
  const after = applyOrdersError(s, { seq: 0, page: 2 })
  assert.equal(after, before)
})

test('openSession：user 传 null 表示按 URL 重开，弹窗尚不渲染', () => {
  const s = openSession(initialSession<U, O>(), 1, null)
  assert.equal(s.user, null)
  assert.equal(s.seq, 1)
  assert.equal(s.loading, 'first')
})

test('openSession：重置 list/total/page/failed', () => {
  let s = initialSession<U, O>()
  s = openSession(s, 1, A)
  s = applyOrdersPage(s, { seq: 1, page: 1, list: [{ id: 1 }], total: 1 })
  s = openSession(s, 2, B)
  assert.deepEqual(s.list, [])
  assert.equal(s.total, 0)
  assert.equal(s.page, 0)
  assert.equal(s.failed, false)
  assert.equal(s.loading, 'first')
})

test('closeSession：user 置 null，弹窗不渲染', () => {
  let s = initialSession<U, O>()
  s = openSession(s, 1, A)
  s = closeSession(s, 2)
  assert.equal(s.user, null)
  assert.equal(s.seq, 2)
})

test('beginMore：seq 匹配时置 loading=more；不匹配时丢弃', () => {
  let s = initialSession<U, O>()
  s = openSession(s, 1, A)
  s = applyOrdersPage(s, { seq: 1, page: 1, list: [{ id: 1 }], total: 5 })
  const more = beginMore(s, 1)
  assert.equal(more.loading, 'more')
  const discarded = beginMore(s, 99)
  assert.equal(discarded, s)
})

test('applyOrdersPage：成功后 loading 回 idle、failed 复位为 false（覆盖此前失败态）', () => {
  let s = initialSession<U, O>()
  s = openSession(s, 1, A)
  s = applyOrdersError(s, { seq: 1, page: 1 })
  assert.equal(s.failed, true)
  s = applyOrdersPage(s, { seq: 1, page: 1, list: [{ id: 1 }], total: 1 })
  assert.equal(s.failed, false)
  assert.equal(s.loading, 'idle')
})

test('applyOrdersError：page>1 失败只复位 loading，不置 failed（分页失败不掩盖已加载的内容）', () => {
  let s = initialSession<U, O>()
  s = openSession(s, 1, A)
  s = applyOrdersPage(s, { seq: 1, page: 1, list: [{ id: 1 }], total: 5 })
  s = beginMore(s, 1)
  s = applyOrdersError(s, { seq: 1, page: 2 })
  assert.equal(s.failed, false)
  assert.equal(s.loading, 'idle')
  assert.deepEqual(s.list, [{ id: 1 }]) // 已加载的内容保留
})
