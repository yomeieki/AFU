import { test } from 'node:test'
import assert from 'node:assert/strict'
import { userDisplayName, userPhoneInfo } from './user-label.ts'

test('userDisplayName：有 nickname → 返回 nickname（即使 latestOrder 也有名字）', () => {
  assert.equal(
    userDisplayName({ id: 1, nickname: '张三', latestOrder: { receiverName: '李四', createdAt: '2026-09-01T00:00:00Z' } }),
    '张三'
  )
})

test('userDisplayName：nickname 为 null 且 latestOrder 有 receiverName → 返回 receiverName', () => {
  assert.equal(
    userDisplayName({ id: 2, nickname: null, latestOrder: { receiverName: '李四', createdAt: '2026-09-01T00:00:00Z' } }),
    '李四'
  )
})

test('userDisplayName：两者都无 → 用户 #<id>', () => {
  assert.equal(userDisplayName({ id: 3, nickname: null, latestOrder: null }), '用户 #3')
})

test('userPhoneInfo：phone 非空 → { phone, source: "wechat" }', () => {
  assert.deepEqual(
    userPhoneInfo({ phone: '13800000000', latestOrder: { receiverPhone: '13900000000' } }),
    { phone: '13800000000', source: 'wechat' }
  )
})

test('userPhoneInfo：phone 空、latestOrder 有 → { phone: receiverPhone, source: "order" }', () => {
  assert.deepEqual(
    userPhoneInfo({ phone: null, latestOrder: { receiverPhone: '13900000000' } }),
    { phone: '13900000000', source: 'order' }
  )
})

test('userPhoneInfo：两者都无 → null', () => {
  assert.equal(userPhoneInfo({ phone: null, latestOrder: null }), null)
})
