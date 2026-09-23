// utils/time.js 的行为锁。
//
// M11（复审建议，纳入本批）：预约单的取消/确认文案原来只给 HH:mm（fmtHHmm），
// 但预约可以约到三天后——「11:11 前可直接取消」不说是哪一天，顾客分不清是今天
// 还是某个未来的日子。fmtDayHHmm 按北京日比较给出「HH:mm / 明天 HH:mm / M月D日 HH:mm」，
// 与自取页 pickupDateText 的月日格式（不补零）保持一致。
const test = require('node:test')
const assert = require('node:assert/strict')

const { fmtDayHHmm, fmtHHmm } = require('../../apps/miniapp/utils/time')

test('T11a M11：同日给 HH:mm，明天给「明天 HH:mm」，更远给「M月D日 HH:mm」，按北京日比较', () => {
  // 同一个北京日：v 北京时间 10:00，now 北京时间 09:00，都是 09-23
  assert.equal(fmtDayHHmm('2026-09-23T02:00:00Z', '2026-09-23T01:00:00Z'), '10:00')
  // 明天：v 是 09-24，now 是 09-23
  assert.equal(fmtDayHHmm('2026-09-24T02:00:00Z', '2026-09-23T01:00:00Z'), '明天 10:00')
  // 更远：v 是 09-25，now 是 09-23
  assert.equal(fmtDayHHmm('2026-09-25T02:00:00Z', '2026-09-23T01:00:00Z'), '9月25日 10:00')
  // 跨零点：v 的北京时间是 09-24 00:30，now 的北京时间是 09-23 23:30——仍是「明天」
  assert.equal(fmtDayHHmm('2026-09-23T16:30:00Z', '2026-09-23T15:30:00Z'), '明天 00:30')
  // 无效输入不抛，返回空串
  assert.equal(fmtDayHHmm(null, '2026-09-23T01:00:00Z'), '')
  assert.equal(fmtDayHHmm('not-a-date', '2026-09-23T01:00:00Z'), '')
})

test('T11a 附带：不传 now 时按当前时刻算（页面调用方式），与手动传当前时刻等价', () => {
  const now = Date.now()
  const soon = new Date(now + 5 * 60 * 1000).toISOString()
  assert.equal(fmtDayHHmm(soon), fmtDayHHmm(soon, now))
})

test('回归：fmtHHmm 逐字节不变（fmtDayHHmm 复用它算钟点）', () => {
  assert.equal(fmtHHmm('2026-09-23T02:00:00Z'), '10:00')
})
